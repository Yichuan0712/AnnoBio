"""Persistent, serial PipelineSpec v1 runner.

Each run owns immutable compiler output and input artifacts under a project-scoped directory.
Artifact JSON is atomically committed before run.json points at it, so a successful JobRun never
references a half-written table.  The runner intentionally does not mutate canvas Dataset nodes.
"""
from __future__ import annotations

from contextlib import suppress
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from typing import Any, Callable

if __package__:
    from .model_settings import settings_for_model
    from .pipeline_compile import compile_pipeline
    from .pipeline_runtime_adapters import (
        PipelineJobCancelled,
        PipelineJobError,
        execute_llm_job,
        execute_process_job,
        normalize_table,
    )
else:
    from model_settings import settings_for_model
    from pipeline_compile import compile_pipeline
    from pipeline_runtime_adapters import (
        PipelineJobCancelled,
        PipelineJobError,
        execute_llm_job,
        execute_process_job,
        normalize_table,
    )


RUN_FORMAT = "annobio.pipeline-run"
RUN_FORMAT_VERSION = 1
TERMINAL_STATES = {"succeeded", "failed", "cancelled", "interrupted"}
_PROJECT_ID_RE = re.compile(r"^[^\x00-\x1f/\\]{1,200}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str) + "\n").encode("utf-8")


def _atomic_write(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    temporary.write_bytes(_json_bytes(payload))
    # Windows denies replacing a file that a scanner or indexer briefly holds open; that hold
    # clears within milliseconds, so retry a few times before failing the run over it.
    for attempt in range(6):
        try:
            os.replace(temporary, path)
            return
        except PermissionError:
            if attempt == 5:
                with suppress(OSError):
                    temporary.unlink()
                raise
            time.sleep(0.02 * (attempt + 1))


def _append_line(path: Path, record: Any) -> None:
    """Append one JSON line. A crash can only tear the last line, which readers skip."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("ab") as handle:
        handle.write(_json_bytes(record))


class PipelineCompileFailure(ValueError):
    def __init__(self, diagnostics: list[dict]):
        super().__init__("Pipeline compilation failed.")
        self.diagnostics = diagnostics


class PipelineRunNotFound(KeyError):
    pass


class PipelineRunConflict(RuntimeError):
    pass


def _apply_model_settings(job: dict, settings: dict, credential_id: str, node_overrides: Any) -> None:
    """The Run's model's own Max tokens / Concurrency (Settings, "Per model") replace the shared
    values the compiler used; settings a Run node saved for itself still win."""
    if isinstance(node_overrides, str):
        try:
            node_overrides = json.loads(node_overrides or "{}")
        except ValueError:
            node_overrides = {}
    if not isinstance(node_overrides, dict):
        node_overrides = {}
    own = settings_for_model(settings, credential_id)
    config = job["config"]
    for key in ("run_max_tokens", "run_concurrency"):
        if key in node_overrides or own.get(key) is None:
            continue
        config.setdefault("settings", {})[key] = own[key]
        if key in (config.get("unresolved_settings") or []):
            config["unresolved_settings"] = [item for item in config["unresolved_settings"] if item != key]


class PipelineRunner:
    def __init__(
        self,
        root: Path,
        *,
        credential_resolver: Callable[[str], dict | None],
        settings_loader: Callable[[], dict],
        compiler: Callable[..., dict] = compile_pipeline,
        llm_adapter: Callable[..., dict] = execute_llm_job,
        process_adapter: Callable[..., dict] = execute_process_job,
    ):
        self.root = Path(root)
        self.credential_resolver = credential_resolver
        self.settings_loader = settings_loader
        self.compiler = compiler
        self.llm_adapter = llm_adapter
        self.process_adapter = process_adapter
        self._lock = threading.RLock()
        self._threads: dict[str, threading.Thread] = {}
        self._cancel_events: dict[str, threading.Event] = {}
        self._processes: dict[str, subprocess.Popen] = {}
        # Live attempt per (run_id, job_id): its token, fingerprint and row progress. Progress stays
        # in memory and reaches run.json when the attempt ends, so a row never rewrites run.json.
        self._attempts: dict[tuple[str, str], dict] = {}
        self._mark_abandoned_runs_interrupted()

    @staticmethod
    def validate_project_id(project_id: str) -> str:
        value = str(project_id or "").strip()
        if not _PROJECT_ID_RE.fullmatch(value) or value in {".", ".."}:
            raise ValueError("project_id must be a stable, non-empty identifier (maximum 200 characters).")
        return value

    @staticmethod
    def _project_key(project_id: str) -> str:
        return hashlib.sha256(project_id.encode("utf-8")).hexdigest()

    def _project_dir(self, project_id: str) -> Path:
        return self.root / self._project_key(self.validate_project_id(project_id))

    def _run_dir(self, project_id: str, run_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{32}", str(run_id or "")):
            raise PipelineRunNotFound(run_id)
        return self._project_dir(project_id) / str(run_id)

    def _run_file(self, project_id: str, run_id: str) -> Path:
        return self._run_dir(project_id, run_id) / "run.json"

    def _active_marker(self, run_id: str) -> Path:
        return self.root / "active" / f"{run_id}.json"

    def _request_index(self, project_id: str, request_id: str) -> Path:
        name = hashlib.sha256(request_id.encode("utf-8")).hexdigest()
        return self._project_dir(project_id) / "requests" / f"{name}.json"

    def _row_checkpoint_file(self, project_id: str, run_id: str, job_id: str) -> Path:
        name = hashlib.sha256(job_id.encode("utf-8")).hexdigest()
        return self._run_dir(project_id, run_id) / "row_checkpoints" / f"{name}.jsonl"

    def _save_run(self, run: dict) -> None:
        # An active run always has a marker, so startup only has to look at active runs: the marker
        # is written before run.json turns active and removed after run.json turns terminal.
        marker = self._active_marker(run["run_id"])
        active = run["status"] not in TERMINAL_STATES
        if active and not marker.exists():
            _atomic_write(marker, {"project_id": run["project_id"], "run_id": run["run_id"]})
        run["updated_at"] = _now()
        _atomic_write(self._run_file(run["project_id"], run["run_id"]), run)
        if not active:
            marker.unlink(missing_ok=True)

    def _load_run(self, project_id: str, run_id: str) -> dict:
        path = self._run_file(project_id, run_id)
        try:
            run = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError) as exc:
            raise PipelineRunNotFound(run_id) from exc
        if run.get("project_id") != self.validate_project_id(project_id):
            raise PipelineRunNotFound(run_id)
        return run

    def _artifact_path(self, run: dict, artifact_id: str) -> Path:
        return self._run_dir(run["project_id"], run["run_id"]) / "artifacts" / f"{artifact_id}.json"

    def _write_artifact(self, run: dict, logical_id: str, table: dict, *, producer: dict | None,
                        valid: bool = True) -> dict:
        table = normalize_table(table)
        artifact_id = uuid.uuid4().hex
        payload = {
            "format": "annobio.pipeline-artifact", "format_version": 1,
            "artifact_id": artifact_id, "run_id": run["run_id"], "logical_id": logical_id,
            "producer": producer, "created_at": _now(), "table": table,
        }
        digest = hashlib.sha256(_json_bytes(payload)).hexdigest()
        path = self._artifact_path(run, artifact_id)
        _atomic_write(path, payload)
        definition = next((item for item in run.get("spec", {}).get("artifacts", [])
                           if item.get("id") == logical_id), {})
        record = {
            "artifact_id": artifact_id, "logical_id": logical_id,
            "name": str(definition.get("name") or logical_id),
            "producer": producer, "row_count": len(table["rows"]),
            "schema": {"headers": table["headers"], "column_types": table["column_types"]},
            "sha256": digest, "content_sha256": hashlib.sha256(_json_bytes(table)).hexdigest(),
            "path": f"artifacts/{artifact_id}.json", "valid": bool(valid),
        }
        run.setdefault("artifacts", {})[logical_id] = record
        return record

    def _read_artifact(self, run: dict, logical_id: str, *, require_valid: bool = True) -> dict:
        record = (run.get("artifacts") or {}).get(logical_id)
        if not record or (require_valid and not record.get("valid")):
            raise PipelineJobError(f'Artifact "{logical_id}" is unavailable.')
        run_dir = self._run_dir(run["project_id"], run["run_id"]).resolve()
        path = (run_dir / str(record.get("path") or "")).resolve()
        if not path.is_relative_to(run_dir):
            raise PipelineJobError(f'Artifact "{logical_id}" has an invalid storage reference.')
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PipelineJobError(f'Artifact "{logical_id}" cannot be read.') from exc
        if hashlib.sha256(_json_bytes(payload)).hexdigest() != record.get("sha256"):
            raise PipelineJobError(f'Artifact "{logical_id}" failed its integrity check.')
        return normalize_table(payload.get("table"))

    def _artifact_content_digest(self, run: dict, logical_id: str) -> str:
        record = (run.get("artifacts") or {}).get(logical_id) or {}
        digest = str(record.get("content_sha256") or "")
        if digest:
            return digest
        return hashlib.sha256(_json_bytes(self._read_artifact(run, logical_id))).hexdigest()

    def _job_fingerprint(self, run: dict, job: dict) -> str:
        input_digests = {
            alias: self._artifact_content_digest(run, logical_id)
            for alias, logical_id in sorted((job.get("inputs") or {}).items())
        }
        execution = None
        if job.get("type") == "llm":
            execution = {
                "credential_id": (run.get("credential_bindings") or {}).get(job["id"]),
                "model": (run.get("execution_models") or {}).get(job["id"]),
            }
        payload = {"job": job, "inputs": input_digests, "execution": execution,
                   "runtime": run.get("runtime") if job.get("type") == "process" else None}
        return hashlib.sha256(_json_bytes(payload)).hexdigest()

    def _find_request_run(self, project_id: str, request_id: str | None) -> dict | None:
        """One index file per request, so the lookup cost does not grow with run history."""
        if not request_id:
            return None
        try:
            record = json.loads(self._request_index(project_id, request_id).read_text(encoding="utf-8"))
            if record.get("request_id") != request_id:
                return None
            return self._load_run(project_id, str(record.get("run_id") or ""))
        except (OSError, ValueError, AttributeError, PipelineRunNotFound):
            return None

    def _row_checkpoints(self, project_id: str, run_id: str, job_id: str, fingerprint: str | None) -> dict[str, dict]:
        """Latest checkpoint per input row, only from attempts of this exact job definition."""
        if not fingerprint:
            return {}
        try:
            lines = self._row_checkpoint_file(project_id, run_id, job_id).read_bytes().splitlines()
        except OSError:
            return {}
        checkpoints: dict[str, dict] = {}
        for line in lines:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if isinstance(record, dict) and record.get("fingerprint") == fingerprint:
                checkpoints[str(record.get("index"))] = {
                    "status": record.get("status"), "outputs": record.get("outputs") or [],
                    "error": record.get("error"),
                }
        return checkpoints

    def compile(self, *, canvas_state: dict, route: list[dict], input_dataset_ids: list[str] | None,
                mapping_policy: str = "strict") -> dict:
        settings = self.settings_loader()
        defaults = {key: settings.get(key) for key in ("run_max_tokens", "run_max_retries", "run_concurrency")}
        return self.compiler(canvas_state=canvas_state, route=route, input_dataset_ids=input_dataset_ids,
                             run_defaults=defaults, mapping_policy=mapping_policy)

    @staticmethod
    def _input_tables(canvas_state: dict, spec: dict) -> dict[str, dict]:
        nodes = {str(node.get("nodeId")): node for node in (canvas_state.get("nodes") or [])
                 if isinstance(node, dict)}
        result = {}
        for logical_id in spec["inputs"]:
            node_id = logical_id.removeprefix("dataset:")
            node = nodes.get(node_id)
            if not node:
                raise ValueError(f'Input Dataset "{node_id}" is missing from the canvas snapshot.')
            result[logical_id] = normalize_table(node.get("datasetContent") or {})
        return result

    def start(self, *, project_id: str, canvas_state: dict, route: list[dict],
              input_dataset_ids: list[str] | None, project_session_id: str | None = None,
              request_id: str | None = None, parent_run_id: str | None = None) -> dict:
        project_id = self.validate_project_id(project_id)
        request_id = str(request_id or "").strip() or None
        if request_id and (len(request_id) > 200 or not _PROJECT_ID_RE.fullmatch(request_id)):
            raise ValueError("request_id must be a non-empty identifier (maximum 200 characters).")
        with self._lock:
            existing = self._find_request_run(project_id, request_id)
            if existing:
                return self._live_status(existing)
            if parent_run_id:
                parent = self._load_run(project_id, parent_run_id)
                if parent.get("status") not in TERMINAL_STATES:
                    raise PipelineRunConflict("An active Pipeline run cannot be used as a revision parent.")
        compiled = self.compile(canvas_state=canvas_state, route=route,
                                input_dataset_ids=input_dataset_ids, mapping_policy="strict")
        if compiled.get("spec") is None:
            raise PipelineCompileFailure(compiled.get("diagnostics") or [])
        spec = compiled["spec"]
        input_tables = self._input_tables(canvas_state, spec)
        nodes = {str(node.get("nodeId")): node for node in (canvas_state.get("nodes") or [])
                 if isinstance(node, dict)}
        settings = self.settings_loader()
        default_credential = str(settings.get("default_run_credential_id") or "")
        bindings: dict[str, str] = {}
        resolved_credentials: dict[str, dict] = {}
        execution_models: dict[str, dict] = {}
        for job in spec["jobs"]:
            if job["type"] != "llm":
                continue
            run_node_id = str(job["config"]["model_binding"]["run_node_id"])
            credential_id = str((nodes.get(run_node_id) or {}).get("runCredentialId") or default_credential).strip()
            if not credential_id:
                raise ValueError(f'Run node "{run_node_id}" has no credential configured.')
            credential = self.credential_resolver(credential_id)
            if not credential:
                raise ValueError(f'Credential "{credential_id}" was not found.')
            bindings[job["id"]] = credential_id
            resolved_credentials[job["id"]] = credential
            _apply_model_settings(job, settings, credential_id, (nodes.get(run_node_id) or {}).get("runSettings"))
            execution_models[job["id"]] = {
                "model": str(credential.get("model") or credential.get("llm") or ""),
                "provider": str(credential.get("provider") or ""),
                "base_url": str(credential.get("base_url") or ""),
            }

        artifact_defs = {item["id"]: item for item in spec["artifacts"]}
        known_rows = {logical_id: len(table["rows"]) for logical_id, table in input_tables.items()}
        plan_jobs = []
        for job in spec["jobs"]:
            input_ids = list(job["inputs"].values())
            input_rows = known_rows.get(input_ids[0]) if len(input_ids) == 1 else None
            source = (spec.get("source_map") or {}).get(job["id"]) or {}
            item = {
                "job_id": job["id"], "type": job["type"],
                "name": str((source.get("names") or [job["id"]])[0]),
                "depends_on": list(job.get("depends_on") or []),
                "input_rows": input_rows,
            }
            if job["type"] == "llm":
                credential = resolved_credentials[job["id"]]
                item["model"] = {
                    "credential_id": bindings[job["id"]],
                    "model": str(credential.get("model") or credential.get("llm") or ""),
                    "provider": str(credential.get("provider") or ""),
                }
                item["settings"] = deepcopy(job["config"].get("settings") or {})
                item["estimated_calls"] = input_rows
                output_rows = input_rows if job["config"]["output_schema"].get("return_shape") == "single" else None
            else:
                item["estimated_calls"] = None
                output_rows = None
            plan_jobs.append(item)
            for logical_ids in job["outputs"].values():
                for logical_id in logical_ids:
                    if output_rows is not None:
                        known_rows[logical_id] = output_rows
                    else:
                        known_rows.pop(logical_id, None)

        plan = {
            "inputs": [{
                "logical_id": logical_id,
                "name": str((artifact_defs.get(logical_id) or {}).get("name") or logical_id),
                "row_count": len(input_tables[logical_id]["rows"]),
            } for logical_id in spec["inputs"]],
            "jobs": plan_jobs,
            "outputs": list(spec["outputs"]),
        }

        run_id = uuid.uuid4().hex
        created = _now()
        run = {
            "format": RUN_FORMAT, "format_version": RUN_FORMAT_VERSION,
            "run_id": run_id, "project_id": project_id, "status": "pending",
            "request_id": request_id, "parent_run_id": parent_run_id,
            "revision": 1,
            "created_at": created, "updated_at": created, "started_at": None, "finished_at": None,
            "spec": deepcopy(spec), "diagnostics": compiled.get("diagnostics") or [],
            # Keep the frozen node definitions needed to publish results into node History.
            # Input rows are already stored as artifacts and are not duplicated here.
            "history_canvas": {
                "nodes": [{key: deepcopy(value) for key, value in node.items() if key != "datasetContent"}
                          for node in canvas_state.get("nodes") or []],
                "connections": deepcopy(canvas_state.get("connections") or []),
            },
            "plan": plan,
            "credential_bindings": bindings,
            "execution_models": execution_models,
            "runtime": {
                "python_path": str(self.settings_loader().get("python_path") or "").strip() or sys.executable,
            },
            # Asset sessions contain no credentials. They are intentionally replaceable on resume;
            # a browser project can mint a fresh session after a backend restart.
            "project_session_id": project_session_id,
            "jobs": [{
                "job_id": job["id"], "type": job["type"], "status": "pending", "attempts": 0,
                "started_at": None, "finished_at": None, "error": None, "artifacts": [],
                "completed": 0, "total": None, "fingerprint": None,
                "attempt_token": None, "reused_from": None,
            } for job in spec["jobs"]],
            "artifacts": {}, "error": None,
        }
        with self._lock:
            existing = self._find_request_run(project_id, request_id)
            if existing:
                return self._live_status(existing)
            for logical_id, table in input_tables.items():
                self._write_artifact(run, logical_id, table, producer=None)
            if parent_run_id:
                parent = self._load_run(project_id, parent_run_id)
                if parent.get("status") not in TERMINAL_STATES:
                    raise PipelineRunConflict("An active Pipeline run cannot be used as a revision parent.")
                run["revision"] = int(parent.get("revision") or 1) + 1
                self._reuse_parent_jobs(run, parent)
            self._save_run(run)
            if request_id:
                _atomic_write(self._request_index(project_id, request_id),
                              {"request_id": request_id, "run_id": run_id})
            self._launch(run)
        return self._live_status(run)

    def revise(self, project_id: str, run_id: str, *, canvas_state: dict, route: list[dict],
               input_dataset_ids: list[str] | None, project_session_id: str | None = None,
               request_id: str | None = None) -> dict:
        return self.start(
            project_id=project_id, canvas_state=canvas_state, route=route,
            input_dataset_ids=input_dataset_ids, project_session_id=project_session_id,
            request_id=request_id, parent_run_id=run_id,
        )

    def _reuse_parent_jobs(self, run: dict, parent: dict) -> None:
        """Copy valid unchanged checkpoints into a new revision; descendants naturally invalidate."""
        parent_jobs = {state.get("job_id"): state for state in (parent.get("jobs") or [])}
        jobs = {job["id"]: job for job in run["spec"]["jobs"]}
        for state in run["jobs"]:
            job = jobs[state["job_id"]]
            try:
                fingerprint = self._job_fingerprint(run, job)
            except PipelineJobError:
                continue
            old_state = parent_jobs.get(job["id"]) or {}
            old_fingerprint = old_state.get("fingerprint")
            if not old_fingerprint:
                try:
                    old_job = next(item for item in parent["spec"]["jobs"] if item["id"] == job["id"])
                    old_fingerprint = self._job_fingerprint(parent, old_job)
                except (StopIteration, KeyError, PipelineJobError):
                    old_fingerprint = None
            if old_state.get("status") != "succeeded" or old_fingerprint != fingerprint:
                continue
            copied = []
            try:
                for port, logical_ids in job["outputs"].items():
                    for logical_id in logical_ids:
                        old_record = (parent.get("artifacts") or {}).get(logical_id) or {}
                        if not old_record.get("valid"):
                            raise PipelineJobError(f'Artifact "{logical_id}" is not reusable.')
                        record = self._write_artifact(
                            run, logical_id, self._read_artifact(parent, logical_id),
                            producer={"job_id": job["id"], "port": port,
                                      "reused_from_run_id": parent["run_id"]}, valid=True,
                        )
                        copied.append(record["artifact_id"])
            except PipelineJobError:
                for logical_ids in job["outputs"].values():
                    for logical_id in logical_ids:
                        record = (run.get("artifacts") or {}).get(logical_id)
                        if (record or {}).get("artifact_id") in copied:
                            run["artifacts"].pop(logical_id, None)
                continue
            state.update({
                "status": "succeeded", "attempts": 0, "started_at": None, "finished_at": _now(),
                "error": None, "artifacts": copied, "completed": old_state.get("total"),
                "total": old_state.get("total"), "fingerprint": fingerprint,
                "reused_from": {"run_id": parent["run_id"], "job_id": job["id"]},
            })

    def _launch(self, run: dict) -> None:
        run_id = run["run_id"]
        existing = self._threads.get(run_id)
        if existing and existing.is_alive():
            raise PipelineRunConflict("This Pipeline run is already active.")
        event = threading.Event()
        self._cancel_events[run_id] = event
        thread = threading.Thread(target=self._execute, args=(run["project_id"], run_id, event), daemon=True)
        self._threads[run_id] = thread
        thread.start()

    def _register_process(self, run_id: str, proc: subprocess.Popen) -> None:
        with self._lock:
            self._processes[run_id] = proc
            event = self._cancel_events.get(run_id)
            if event and event.is_set() and proc.poll() is None:
                proc.kill()

    def _execute(self, project_id: str, run_id: str, cancel_event: threading.Event) -> None:
        try:
            with self._lock:
                run = self._load_run(project_id, run_id)
                run["status"] = "running"
                run["started_at"] = run.get("started_at") or _now()
                run["finished_at"] = None
                run["error"] = None
                self._save_run(run)

            jobs_by_id = {job["id"]: job for job in run["spec"]["jobs"]}
            for job_state in run["jobs"]:
                if job_state["status"] == "succeeded":
                    continue
                if cancel_event.is_set():
                    raise PipelineJobCancelled("Cancelled")
                job = jobs_by_id[job_state["job_id"]]
                with self._lock:
                    run = self._load_run(project_id, run_id)
                    if cancel_event.is_set() or run.get("status") == "cancelling":
                        raise PipelineJobCancelled("Cancelled")
                    job_state = next(item for item in run["jobs"] if item["job_id"] == job["id"])
                    attempt_token = uuid.uuid4().hex
                    fingerprint = self._job_fingerprint(run, job)
                    row_checkpoints = (self._row_checkpoints(project_id, run_id, job["id"], fingerprint)
                                       if job["type"] == "llm" else {})
                    completed_rows = sum(1 for item in row_checkpoints.values()
                                         if item.get("status") == "succeeded")
                    job_state.update({"status": "running", "started_at": _now(), "finished_at": None,
                                      "error": None, "attempts": int(job_state.get("attempts") or 0) + 1,
                                      "artifacts": [], "completed": completed_rows, "total": None,
                                      "fingerprint": fingerprint, "attempt_token": attempt_token,
                                      "reused_from": None})
                    self._attempts[(run_id, job["id"])] = {
                        "token": attempt_token, "fingerprint": fingerprint,
                        "completed": completed_rows, "total": None,
                    }
                    self._save_run(run)
                try:
                    inputs = {alias: self._read_artifact(run, logical_id)
                              for alias, logical_id in job["inputs"].items()}
                    if job["type"] == "llm":
                        self._set_job_progress(run_id, job["id"], completed_rows,
                                               len(inputs["data"]["rows"]), attempt_token)
                        credential_id = run["credential_bindings"][job["id"]]
                        credential = self.credential_resolver(credential_id)
                        if not credential:
                            raise PipelineJobError(f'Credential "{credential_id}" was not found.')
                        credential = {**credential, **(run.get("execution_models", {}).get(job["id"]) or {})}
                        result = self.llm_adapter(
                            job, inputs["data"], credential, run.get("project_session_id"), cancel_event,
                            progress_callback=lambda completed, total: self._set_job_progress(
                                run_id, job["id"], completed, total, attempt_token,
                            ),
                            row_checkpoints=row_checkpoints,
                            row_callback=lambda index, outputs, error: self._checkpoint_llm_row(
                                project_id, run_id, job["id"], attempt_token, index, outputs, error,
                            ),
                        )
                        output_tables = {"result": result["table"]}
                    else:
                        self._set_job_progress(run_id, job["id"], 0, 1, attempt_token)
                        python_path = str((run.get("runtime") or {}).get("python_path") or sys.executable)
                        output_tables = self.process_adapter(
                            job, inputs, python_path, run.get("project_session_id"), cancel_event,
                            register_proc=lambda proc: self._register_process(run_id, proc),
                        )
                        self._set_job_progress(run_id, job["id"], 1, 1, attempt_token)
                    missing_ports = sorted(set(job["outputs"]) - set(output_tables))
                    if missing_ports:
                        raise PipelineJobError("Process did not return required output branch(es): " + ", ".join(missing_ports))
                    with self._lock:
                        run = self._load_run(project_id, run_id)
                        state = next(item for item in run["jobs"] if item["job_id"] == job["id"])
                        if (cancel_event.is_set() or run.get("status") == "cancelling"
                                or state.get("attempt_token") != attempt_token):
                            raise PipelineJobCancelled("Cancelled")
                        for port, logical_ids in job["outputs"].items():
                            for logical_id in logical_ids:
                                record = self._write_artifact(
                                    run, logical_id, output_tables[port],
                                    producer={"job_id": job["id"], "port": port}, valid=True,
                                )
                                state["artifacts"].append(record["artifact_id"])
                        state.update({"status": "succeeded", "finished_at": _now(), "error": None,
                                      "attempt_token": None,
                                      **self._end_attempt(run_id, job["id"], attempt_token)})
                        self._save_run(run)  # checkpoint only after every artifact has been committed
                except PipelineJobCancelled as exc:
                    self._finish_job_error(project_id, run_id, job, exc, "cancelled", attempt_token)
                    raise
                except Exception as exc:
                    self._finish_job_error(project_id, run_id, job, exc, "failed", attempt_token)
                    raise

            with self._lock:
                run = self._load_run(project_id, run_id)
                if cancel_event.is_set() or run.get("status") == "cancelling":
                    raise PipelineJobCancelled("Cancelled")
                run.update({"status": "succeeded", "finished_at": _now(), "error": None})
                self._save_run(run)
        except PipelineJobCancelled as exc:
            with self._lock:
                run = self._load_run(project_id, run_id)
                run.update({"status": "cancelled", "finished_at": _now(), "error": str(exc)})
                self._block_pending(run, "Pipeline was cancelled.")
                self._save_run(run)
        except Exception as exc:
            with self._lock:
                try:
                    run = self._load_run(project_id, run_id)
                    run.update({"status": "failed", "finished_at": _now(), "error": str(exc)})
                    self._block_pending(run, "An earlier job failed.")
                    self._save_run(run)
                except PipelineRunNotFound:
                    pass
        finally:
            with self._lock:
                self._processes.pop(run_id, None)
                self._cancel_events.pop(run_id, None)
                self._threads.pop(run_id, None)
                for key in [key for key in self._attempts if key[0] == run_id]:
                    del self._attempts[key]

    def _finish_job_error(self, project_id: str, run_id: str, job: dict, exc: Exception,
                          status: str, attempt_token: str) -> None:
        with self._lock:
            progress = self._end_attempt(run_id, job["id"], attempt_token)
            run = self._load_run(project_id, run_id)
            state = next(item for item in run["jobs"] if item["job_id"] == job["id"])
            if state.get("attempt_token") != attempt_token:
                return
            partial = getattr(exc, "partial_table", None)
            if partial is not None:
                for port, logical_ids in job["outputs"].items():
                    for logical_id in logical_ids:
                        record = self._write_artifact(run, logical_id, partial,
                            producer={"job_id": job["id"], "port": port}, valid=False)
                        state["artifacts"].append(record["artifact_id"])
            state.update({"status": status, "finished_at": _now(), "error": str(exc),
                          "attempt_token": None, **progress})
            self._save_run(run)

    def _end_attempt(self, run_id: str, job_id: str, attempt_token: str) -> dict:
        """Stop accepting this attempt's callbacks; returns its last progress for run.json."""
        key = (run_id, job_id)
        attempt = self._attempts.get(key)
        if not attempt or attempt["token"] != attempt_token:
            return {}
        del self._attempts[key]
        return {"completed": attempt["completed"], "total": attempt["total"]}

    def _set_job_progress(self, run_id: str, job_id: str, completed: int, total: int,
                          attempt_token: str) -> None:
        with self._lock:
            attempt = self._attempts.get((run_id, job_id))
            if attempt and attempt["token"] == attempt_token:
                attempt["completed"] = max(0, int(completed))
                attempt["total"] = max(0, int(total))

    def _checkpoint_llm_row(self, project_id: str, run_id: str, job_id: str,
                            attempt_token: str, index: int, outputs: list[dict],
                            error: str | None) -> None:
        """Append one finished input row; a row costs its own size, not a run.json rewrite."""
        with self._lock:
            attempt = self._attempts.get((run_id, job_id))
            if not attempt or attempt["token"] != attempt_token:
                return
            cancelled = str(error or "").casefold() == "cancelled"
            _append_line(self._row_checkpoint_file(project_id, run_id, job_id), {
                "fingerprint": attempt["fingerprint"], "index": int(index),
                "status": "cancelled" if cancelled else ("failed" if error else "succeeded"),
                "outputs": outputs, "error": error,
            })

    @staticmethod
    def _block_pending(run: dict, reason: str) -> None:
        for state in run["jobs"]:
            if state["status"] == "pending":
                state.update({"status": "blocked", "finished_at": _now(), "error": reason})

    def cancel(self, project_id: str, run_id: str) -> dict:
        with self._lock:
            run = self._load_run(project_id, run_id)
            if run["status"] in TERMINAL_STATES:
                return self._live_status(run)
            run["status"] = "cancelling"
            self._save_run(run)
            self._cancel_events.setdefault(run_id, threading.Event()).set()
            proc = self._processes.get(run_id)
            if proc and proc.poll() is None:
                proc.kill()
            return self._live_status(run)

    def delete(self, project_id: str, run_id: str) -> None:
        """Remove a finished run and its stored tables. Results already added to a project keep their
        own copies (node History, Dataset copies), and revisions copied what they reused."""
        with self._lock:
            run = self._load_run(project_id, run_id)
            if run["status"] not in TERMINAL_STATES or run_id in self._threads:
                raise PipelineRunConflict("Stop this Pipeline run before deleting it.")
            shutil.rmtree(self._run_dir(project_id, run_id))

    def resume(self, project_id: str, run_id: str, *, project_session_id: str | None = None) -> dict:
        finishing_thread = None
        with self._lock:
            run = self._load_run(project_id, run_id)
            if run["status"] in {"pending", "running", "cancelling"}:
                return self._live_status(run)
            if run["status"] not in {"failed", "cancelled", "interrupted"}:
                raise PipelineRunConflict("Only failed, cancelled, or interrupted Pipeline runs can resume.")
            finishing_thread = self._threads.get(run_id)
        # A worker persists its terminal state immediately before leaving its finally block.  Let
        # that tiny window close without holding our lock; otherwise the old worker cannot remove
        # itself and a resume could leave a pending run with no replacement worker.
        if finishing_thread and finishing_thread.is_alive():
            finishing_thread.join(timeout=5)
        with self._lock:
            run = self._load_run(project_id, run_id)
            if run["status"] in {"pending", "running", "cancelling"}:
                return self._live_status(run)
            still_finishing = self._threads.get(run_id)
            if still_finishing and still_finishing.is_alive():
                raise PipelineRunConflict("The previous Pipeline worker is still finishing; retry resume shortly.")
            if run["status"] not in {"failed", "cancelled", "interrupted"}:
                raise PipelineRunConflict("Only failed, cancelled, or interrupted Pipeline runs can resume.")
            if project_session_id is not None:
                run["project_session_id"] = project_session_id
            self._prepare_resume(run)
            run.update({"status": "pending", "finished_at": None, "error": None})
            self._save_run(run)
            self._launch(run)
            return self._live_status(run)

    def _prepare_resume(self, run: dict) -> None:
        jobs = {job["id"]: job for job in run["spec"]["jobs"]}
        available: set[str] = set()
        for logical_id in run["spec"]["inputs"]:
            try:
                self._read_artifact(run, logical_id)
                available.add(logical_id)
            except PipelineJobError as exc:
                raise PipelineRunConflict(
                    f'Frozen input checkpoint "{logical_id}" is unavailable; start a new revision.'
                ) from exc
        for state in run["jobs"]:
            job = jobs[state["job_id"]]
            input_ids = set((job.get("inputs") or {}).values())
            inputs_ready = input_ids.issubset(available)
            fingerprint = None
            if inputs_ready:
                try:
                    fingerprint = self._job_fingerprint(run, job)
                except PipelineJobError:
                    inputs_ready = False
            outputs = [logical_id for ids in (job.get("outputs") or {}).values() for logical_id in ids]
            checkpoint_valid = state.get("status") == "succeeded" and inputs_ready
            if checkpoint_valid:
                try:
                    for logical_id in outputs:
                        self._read_artifact(run, logical_id)
                except PipelineJobError:
                    checkpoint_valid = False
            if checkpoint_valid:
                state["fingerprint"] = fingerprint
                available.update(outputs)
                continue

            # Row checkpoints are keyed by job fingerprint, so a changed job or input reuses none.
            checkpoints = (self._row_checkpoints(run["project_id"], run["run_id"], job["id"], fingerprint)
                           if job.get("type") == "llm" and inputs_ready else {})
            for logical_id in outputs:
                run.setdefault("artifacts", {}).pop(logical_id, None)
            state.update({
                "status": "pending", "started_at": None, "finished_at": None, "error": None,
                "artifacts": [], "total": state.get("total"),
                "completed": sum(1 for item in checkpoints.values() if item.get("status") == "succeeded"),
                "fingerprint": fingerprint, "attempt_token": None, "reused_from": None,
            })

    def status(self, project_id: str, run_id: str) -> dict:
        with self._lock:
            return self._live_status(self._load_run(project_id, run_id))

    def definition(self, project_id: str, run_id: str) -> dict:
        with self._lock:
            run = self._load_run(project_id, run_id)
            return {"spec": deepcopy(run["spec"]),
                    "canvas_state": deepcopy(run.get("history_canvas"))}

    def list_runs(self, project_id: str) -> list[dict]:
        project_dir = self._project_dir(project_id)
        if not project_dir.is_dir():
            return []
        items = []
        with self._lock:
            for path in project_dir.glob("*/run.json"):
                try:
                    run = json.loads(path.read_text(encoding="utf-8"))
                    if run.get("project_id") != project_id or not re.fullmatch(r"[0-9a-f]{32}", str(run.get("run_id") or "")):
                        continue
                    jobs = run.get("jobs") or []
                    items.append({"run_id": run["run_id"], "status": run["status"],
                                  "created_at": run.get("created_at"), "updated_at": run.get("updated_at"),
                                  "finished_at": run.get("finished_at"),
                                  "job_count": len(jobs),
                                  # Job ids name their canvas nodes (llm:<Run>, process:<Process>), which
                                  # files a run under the pipeline it came from.
                                  "job_ids": [state.get("job_id") for state in jobs],
                                  "succeeded_job_count": sum(1 for state in jobs if state.get("status") == "succeeded"),
                                  "produced_artifact_ids": sorted(logical_id for logical_id, artifact in
                                                                  (run.get("artifacts") or {}).items()
                                                                  if artifact.get("valid") and artifact.get("producer")),
                                  "revision": run.get("revision") or 1})
                except (OSError, ValueError, KeyError, TypeError):
                    continue
        return sorted(items, key=lambda item: (item.get("created_at") or "", item["run_id"]), reverse=True)

    def _live_status(self, run: dict) -> dict:
        """public_status, with the in-memory row progress of attempts that are still running."""
        with self._lock:
            for state in run.get("jobs") or []:
                attempt = self._attempts.get((run["run_id"], state.get("job_id")))
                if attempt and attempt["token"] == state.get("attempt_token"):
                    state["completed"], state["total"] = attempt["completed"], attempt["total"]
            return self.public_status(run)

    def results(self, project_id: str, run_id: str, logical_id: str | None = None,
                *, include_partial: bool = True) -> dict:
        with self._lock:
            run = self._load_run(project_id, run_id)
            ids = [logical_id] if logical_id else list(run["spec"]["outputs"])
            outputs = []
            for item in ids:
                record = (run.get("artifacts") or {}).get(item)
                if not record or (not include_partial and not record.get("valid")):
                    continue
                table = self._read_artifact(run, item, require_valid=not include_partial)
                outputs.append({"logical_id": item, "artifact": deepcopy(record), "table": table})
            return {"run_id": run_id, "project_id": run["project_id"], "status": run["status"],
                    "outputs": outputs}

    @staticmethod
    def public_status(run: dict) -> dict:
        artifacts = [{key: value for key, value in record.items() if key != "path"}
                     for record in (run.get("artifacts") or {}).values()]
        jobs = [{key: deepcopy(value) for key, value in state.items()
                 if key not in {"attempt_token", "fingerprint", "row_checkpoints"}}
                for state in (run.get("jobs") or [])]
        return {
            "run_id": run["run_id"], "project_id": run["project_id"], "status": run["status"],
            "revision": int(run.get("revision") or 1), "parent_run_id": run.get("parent_run_id"),
            "created_at": run["created_at"], "updated_at": run["updated_at"],
            "started_at": run.get("started_at"), "finished_at": run.get("finished_at"),
            "error": run.get("error"), "jobs": jobs,
            "artifacts": artifacts, "outputs": list((run.get("spec") or {}).get("outputs") or []),
            "plan": deepcopy(run.get("plan") or {}),
            "diagnostics": deepcopy(run.get("diagnostics") or []),
        }

    def _mark_abandoned_runs_interrupted(self) -> None:
        """Runs left active by a stopped backend; reads only active markers, not all history."""
        marker_dir = self.root / "active"
        if not marker_dir.is_dir():
            return
        for marker in marker_dir.glob("*.json"):
            try:
                record = json.loads(marker.read_text(encoding="utf-8"))
                run = self._load_run(str(record["project_id"]), str(record["run_id"]))
            except (OSError, ValueError, KeyError, TypeError, PipelineRunNotFound):
                with suppress(OSError):
                    marker.unlink(missing_ok=True)  # its run is gone or unreadable; nothing to resume
                continue
            if run.get("status") in TERMINAL_STATES:
                with suppress(OSError):
                    marker.unlink(missing_ok=True)
                continue
            run.update({"status": "interrupted", "finished_at": _now(),
                        "error": "Backend stopped while this Pipeline was running."})
            for state in run.get("jobs") or []:
                if state.get("status") == "running":
                    state.update({"status": "interrupted", "finished_at": _now(),
                                  "error": "Backend stopped during this job.",
                                  "attempt_token": None})
            try:
                self._save_run(run)  # terminal now, so this also removes the marker
            except OSError:
                continue
