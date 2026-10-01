"""Runtime adapters shared by the in-app Pipeline runner.

The compiler describes jobs but never executes them.  This module is the narrow boundary that
turns one compiled job plus materialized input artifacts into materialized output tables.  It
deliberately contains no persistence or scheduling policy; those belong to pipeline_runner.py.
"""
from __future__ import annotations

import concurrent.futures
import re
import threading
from typing import Any, Callable

if __package__:
    from .asset_store import resolve_content
    from .llm import run_structured as llm_run_structured
    from .process_df_exec import run_process_df_code
    from .run_output_schema import (
        build_output_model,
        build_table_output_model,
        run_structured_output_is_empty,
    )
else:
    from asset_store import resolve_content
    from llm import run_structured as llm_run_structured
    from process_df_exec import run_process_df_code
    from run_output_schema import (
        build_output_model,
        build_table_output_model,
        run_structured_output_is_empty,
    )


class PipelineJobError(RuntimeError):
    """A job failed after any useful partial output was captured."""

    def __init__(self, message: str, *, partial_table: dict | None = None):
        super().__init__(message)
        self.partial_table = partial_table


class PipelineJobCancelled(PipelineJobError):
    pass


def normalize_table(value: dict | None) -> dict:
    """Return the canonical JSON table shape used by persisted artifacts."""
    value = value if isinstance(value, dict) else {}
    headers = [str(item) for item in (value.get("headers") or [])]
    if len(headers) != len(set(headers)):
        raise PipelineJobError("Dataset contains duplicate columns.")
    rows = []
    for row in value.get("rows") or []:
        if isinstance(row, dict):
            rows.append([row.get(header) for header in headers])
        elif isinstance(row, list):
            rows.append([row[index] if index < len(row) else None for index in range(len(headers))])
        else:
            raise PipelineJobError("Dataset rows must be arrays or objects.")
    column_types = [str(item or "text") for item in (value.get("columnTypes") or value.get("column_types") or [])]
    if len(column_types) < len(headers):
        column_types.extend(["text"] * (len(headers) - len(column_types)))
    row_ids = list(value.get("rowIds") or value.get("row_ids") or [])
    if len(row_ids) != len(rows):
        row_ids = list(range(1, len(rows) + 1))
    return {"headers": headers, "column_types": column_types[:len(headers)], "row_ids": row_ids, "rows": rows}


def _records(table: dict) -> list[dict[str, Any]]:
    headers = table["headers"]
    return [{header: row[index] if index < len(row) else None for index, header in enumerate(headers)}
            for row in table["rows"]]


def _asset_kind(value: Any) -> str | None:
    if not isinstance(value, dict) or not isinstance(value.get("assetIds"), list):
        return None
    if value.get("kind") == "images":
        return "image"
    if value.get("kind") == "pdf":
        return "pdf"
    return None


def compile_prompt_content(template: str, values: dict[str, Any], input_types: dict[str, str],
                           project_session_id: str | None) -> str | list[dict[str, Any]]:
    """Mirror the browser's placeholder and image/PDF substitution contract."""
    content: list[dict[str, Any]] = []
    attached: set[str] = set()

    def append_text(text: str) -> None:
        if not text:
            return
        if content and content[-1].get("type") == "text":
            content[-1]["text"] += text
        else:
            content.append({"type": "text", "text": text})

    end = 0
    for match in re.finditer(r"(?<!\{)\{([^{}]+)\}(?!\})", str(template)):
        append_text(template[end:match.start()])
        name = match.group(1)
        if name not in values:
            append_text(match.group(0))
            end = match.end()
            continue
        value = values[name]
        actual_kind = _asset_kind(value)
        expected_kind = str(input_types.get(name) or "text")
        if actual_kind:
            if expected_kind == "text":
                raise ValueError(f'Input "{name}" is Text but maps to an asset column.')
            if expected_kind in {"image", "pdf"} and expected_kind != actual_kind:
                raise ValueError(f'Input "{name}" requires a {expected_kind} column.')
            asset_ids = value.get("assetIds") or []
            if not asset_ids:
                raise ValueError(f'Missing {actual_kind} input for "{name}".')
            append_text(f"\n[{actual_kind.title()} files: {name}]\n")
            if name not in attached:
                for asset_id in asset_ids:
                    content.append({"type": "image_ref" if actual_kind == "image" else "pdf_ref",
                                    "asset_id": asset_id})
            attached.add(name)
        else:
            if expected_kind in {"image", "pdf"}:
                raise ValueError(f'Input "{name}" requires a {expected_kind} column.')
            append_text("" if value is None else str(value))
        end = match.end()
    append_text(template[end:])
    if not content:
        return ""
    if len(content) == 1 and content[0].get("type") == "text":
        return str(content[0].get("text") or "")
    if not project_session_id:
        raise ValueError("Image/PDF inputs require a project session.")
    return resolve_content(content, project_session_id)


def execute_llm_job(job: dict, table: dict, credential: dict, project_session_id: str | None,
                    cancel_event: threading.Event,
                    invoke: Callable[..., tuple[Any, bool, dict]] = llm_run_structured,
                    progress_callback: Callable[[int, int], None] | None = None,
                    row_checkpoints: dict[int | str, dict] | None = None,
                    row_callback: Callable[[int, list[dict], str | None], None] | None = None) -> dict:
    """Execute all rows for one compiled LLM job and materialize the canvas result-table shape."""
    table = normalize_table(table)
    config = job["config"]
    schema = config["output_schema"]
    fields = list(schema.get("fields") or [])
    return_shape = str(schema.get("return_shape") or "single")
    if return_shape == "table":
        row_model = build_output_model(fields)
        response_model = build_table_output_model(row_model)
    else:
        response_model = build_output_model(fields)

    template = "\n\n".join(str(section.get("content") or "").strip()
                             for section in config.get("sections") or []).strip()
    mapping = dict(config.get("input_mapping") or {})
    placeholders = list(dict.fromkeys(re.findall(r"(?<!\{)\{([^{}]+)\}(?!\})", template)))
    for name in placeholders:
        if mapping.get(name):
            continue
        exact = [header for header in table["headers"] if header == name]
        folded = [header for header in table["headers"] if header.casefold() == name.casefold()]
        matches = exact or folded
        if len(matches) == 1:
            mapping[name] = matches[0]
    missing = [name for name in placeholders if not mapping.get(name)]
    unknown = sorted({column for column in mapping.values() if column not in table["headers"]})
    if missing:
        raise PipelineJobError("Missing runtime input mappings: " + ", ".join(missing))
    if unknown:
        raise PipelineJobError("Prompt maps inputs to missing columns: " + ", ".join(unknown))

    settings = config.get("settings") or {}
    retries = max(0, min(5, int(settings.get("run_max_retries") or 0)))
    concurrency = max(1, min(10, int(settings.get("run_concurrency") or 1)))
    output_fields = [{"key": str(field["key"]), "display": str(field.get("display") or field["key"])}
                     for field in fields]
    headers = ["Input: #", *[f"Input: {header}" for header in table["headers"]], "Output: #",
               *[f"Output: {field['display']}" for field in output_fields]]
    if not table["rows"]:
        if progress_callback:
            progress_callback(0, 0)
        return {"table": {"headers": headers, "column_types": ["text"] * len(headers),
                           "row_ids": [], "rows": []}, "errors": []}

    records = _records(table)
    provider = str(credential.get("provider") or "")
    model = str(credential.get("model") or credential.get("llm") or "")
    api_key = str(credential.get("api_key") or "")
    base_url = str(credential.get("base_url") or "")
    if not model:
        raise PipelineJobError("The selected credential has no model configured.")
    if not api_key:
        raise PipelineJobError("The selected credential has no API key.")
    max_tokens = int(settings.get("run_max_tokens") or 8192)

    def one(item: tuple[int, dict[str, Any]]) -> tuple[int, list[dict], str | None]:
        index, row = item
        if cancel_event.is_set():
            return index, [], "Cancelled"
        try:
            values = {name: row.get(column) for name, column in mapping.items()}
            prompt = compile_prompt_content(template, values, config.get("input_types") or {}, project_session_id)
            last_error: Exception | None = None
            for attempt in range(retries + 1):
                if cancel_event.is_set():
                    return index, [], "Cancelled"
                try:
                    output, _, _ = invoke(
                        provider=provider, model=model, api_key=api_key, base_url=base_url,
                        prompt=prompt, response_model=response_model, max_tokens=max_tokens,
                        return_shape=return_shape, return_debug=True,
                    )
                    if return_shape == "table" and isinstance(output, dict) and "rows" in output:
                        output = output["rows"]
                    if run_structured_output_is_empty(output, return_shape, output_fields):
                        raise ValueError("Empty model output")
                    values_out = output if isinstance(output, list) else [output]
                    return index, [value for value in values_out if isinstance(value, dict)], None
                except Exception as exc:  # retry is deliberately per input row
                    last_error = exc
                    if attempt == retries:
                        raise
            raise last_error or RuntimeError("Unknown model error")
        except Exception as exc:
            return index, [], str(exc)

    outcomes: list[tuple[int, list[dict], str | None] | None] = [None] * len(records)
    completed = 0
    for raw_index, checkpoint in (row_checkpoints or {}).items():
        try:
            index = int(raw_index)
        except (TypeError, ValueError):
            continue
        if not (0 <= index < len(records)) or checkpoint.get("status") != "succeeded":
            continue
        outputs = [item for item in (checkpoint.get("outputs") or []) if isinstance(item, dict)]
        outcomes[index] = (index, outputs, None)
        completed += 1
    if progress_callback:
        progress_callback(completed, len(records))

    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(one, item) for item in enumerate(records) if outcomes[item[0]] is None]
        for future in concurrent.futures.as_completed(futures):
            outcome = future.result()
            outcomes[outcome[0]] = outcome
            completed += 1
            if row_callback:
                row_callback(outcome[0], outcome[1], outcome[2])
            if progress_callback:
                progress_callback(completed, len(records))

    materialized: list[list[Any]] = []
    errors: list[dict[str, Any]] = []
    for outcome in outcomes:
        if outcome is None:  # defensive: every submitted future must produce one outcome
            continue
        input_index, output_rows, error = outcome
        if error:
            errors.append({"input_row_index": input_index, "error": error})
        for output in output_rows or ([{}] if error else []):
            result_row = [input_index + 1, *table["rows"][input_index], len(materialized) + 1]
            result_row.extend(error if error else output.get(field["key"], output.get(field["display"]))
                              for field in output_fields)
            materialized.append(result_row)
    result = {"headers": headers, "column_types": ["text"] * len(headers),
              "row_ids": list(range(1, len(materialized) + 1)), "rows": materialized}
    if cancel_event.is_set():
        raise PipelineJobCancelled("Cancelled", partial_table=result)
    if errors:
        raise PipelineJobError(f"{len(errors)} input row(s) failed.", partial_table=result)
    return {"table": result, "errors": []}


def execute_process_job(job: dict, tables_by_alias: dict[str, dict], python_path: str,
                        project_session_id: str | None, cancel_event: threading.Event,
                        register_proc: Callable[[Any], None] | None = None) -> dict[str, dict]:
    """Execute one compiled Process job and retain empty-frame schemas from the subprocess."""
    if cancel_event.is_set():
        raise PipelineJobCancelled("Cancelled")
    normalized = {alias: normalize_table(table) for alias, table in tables_by_alias.items()}
    resolved = {}
    if __package__:
        from .asset_store import resolve_cell_for_code
    else:
        from asset_store import resolve_cell_for_code
    for alias, table in normalized.items():
        resolved[alias] = {**table, "rows": resolve_cell_for_code(table["rows"], project_session_id)}
    primary = "df"
    outcome = run_process_df_code(
        python_path=python_path, code=job["config"]["code"], headers=resolved[primary]["headers"],
        rows=resolved[primary]["rows"], input_datasets=resolved, primary_dataset_id=primary,
        register_proc=register_proc,
    )
    if cancel_event.is_set():
        raise PipelineJobCancelled("Cancelled")
    if not outcome.get("ok"):
        raise PipelineJobError(str(outcome.get("error") or "Process failed."))
    tables = outcome.get("output_tables") or {}
    if not tables:  # compatibility with an older process_df_exec response
        for name, records in (outcome.get("outputs") or {}).items():
            headers = list(records[0]) if records else []
            tables[name] = {"headers": headers, "rows": records}
    return {str(name): normalize_table(table) for name, table in tables.items()}
