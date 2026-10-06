from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
sys.path.insert(0, str(Path(__file__).resolve().parent))

from backend.pipeline_runner import PipelineRunner
from backend.pipeline_runtime_adapters import PipelineJobCancelled, PipelineJobError, execute_llm_job
from backend.test_pipeline_compile import branched, route_for


DEFAULTS = {"run_max_tokens": 1024, "run_max_retries": 0, "run_concurrency": 2,
            "default_run_credential_id": "cred", "python_path": sys.executable}


def dataset(node_id, headers, rows, **extra):
    return {"type": "dataset", "nodeId": node_id, "name": node_id,
            "datasetContent": {"headers": headers, "columnTypes": ["text"] * len(headers),
                               "rowIds": list(range(10, 10 + len(rows))), "rows": rows}, **extra}


def prompt(node_id, text, field, return_shape="single"):
    return {"type": "prompt", "nodeId": node_id, "name": node_id,
            "sections": [{"name": "Task", "content": text}],
            "outputFormat": {"returnShape": return_shape,
                             "fields": [{"key": field, "type": "str"}]}}


def run(node_id, input_id, mapping):
    return {"type": "run", "nodeId": node_id, "runName": node_id,
            "runWorkingSetId": input_id, "runInputToColumn": mapping,
            "runCredentialId": "cred"}


def edge(source, target, kind):
    return {"fromId": source, "toId": target, "type": kind}


def serial_state(rows=None):
    rows = [["alpha"], ["beta"]] if rows is None else rows
    nodes = [
        dataset("raw", ["text"], rows),
        prompt("p1", "First {text}", "answer"), run("r1", "raw", {"text": "text"}),
        dataset("mid", ["old"], [], sourceRunNodeId="r1"),
        {"type": "process", "nodeId": "clean", "name": "clean", "primaryDatasetId": "mid",
         "dfCode": "def process(df):\n    return pd.DataFrame({'answer': [str(x).upper() for x in df['Output: answer']]})\n"},
        dataset("cleaned", ["old"], [], processOutputName="result"),
        prompt("p2", "Second {answer}", "final"), run("r2", "cleaned", {"answer": "answer"}),
    ]
    connections = [
        edge("p1", "r1", "prompt-to-run"), edge("mid", "clean", "dataset-to-process"),
        edge("clean", "cleaned", "process-to-dataset"), edge("p2", "r2", "prompt-to-run"),
    ]
    route = [
        {"type": "dataset", "dataset_node_id": "raw"},
        {"type": "prompt", "prompt_node_id": "p1", "run_node_id": "r1"},
        {"type": "dataset", "dataset_node_id": "mid"},
        {"type": "process", "process_node_id": "clean"},
        {"type": "dataset", "dataset_node_id": "cleaned"},
        {"type": "prompt", "prompt_node_id": "p2", "run_node_id": "r2"},
    ]
    return {"nodes": nodes, "connections": connections}, route


class PipelineRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.calls = []
        self.invocations = []
        self.fail_second = False
        self.fail_text_once = None
        self.failed_texts = set()
        self.block_jobs = False

        def fake_invoke(**kwargs):
            prompt_text = kwargs["prompt"] if isinstance(kwargs["prompt"], str) else json.dumps(kwargs["prompt"])
            self.invocations.append(prompt_text)
            if (self.fail_text_once and self.fail_text_once in prompt_text
                    and self.fail_text_once not in self.failed_texts):
                self.failed_texts.add(self.fail_text_once)
                raise RuntimeError(f"planned row failure: {self.fail_text_once}")
            field = "final" if "Second" in prompt_text else "answer"
            return {field: prompt_text}, False, {}

        def llm_adapter(job, table, credential, session_id, cancel_event, progress_callback=None,
                        row_checkpoints=None, row_callback=None):
            self.calls.append(job["id"])
            if self.block_jobs:
                while not cancel_event.wait(0.01):
                    pass
                raise PipelineJobCancelled("Cancelled")
            if self.fail_second and job["id"] == "llm:r2":
                raise PipelineJobError("planned second-job failure")
            return execute_llm_job(job, table, credential, session_id, cancel_event, invoke=fake_invoke,
                                   progress_callback=progress_callback, row_checkpoints=row_checkpoints,
                                   row_callback=row_callback)

        self.runner = PipelineRunner(
            Path(self.temp.name), credential_resolver=lambda value: {
                "id": value, "model": "mock", "provider": "mock", "api_key": "secret",
            } if value == "cred" else None,
            settings_loader=lambda: dict(DEFAULTS), llm_adapter=llm_adapter,
        )

    def tearDown(self):
        self.temp.cleanup()

    def wait(self, project_id, run_id, states=("succeeded", "failed", "cancelled", "interrupted")):
        deadline = time.time() + 15
        while time.time() < deadline:
            status = self.runner.status(project_id, run_id)
            if status["status"] in states:
                return status
            time.sleep(0.03)
        self.fail(f"Pipeline did not finish: {self.runner.status(project_id, run_id)}")

    def test_real_process_serial_chain_and_artifact_isolation(self):
        state, route = serial_state()
        original = deepcopy(state)
        started = self.runner.start(project_id="web-project", canvas_state=state, route=route,
                                    input_dataset_ids=["raw"])
        finished = self.wait("web-project", started["run_id"])
        self.assertEqual(finished["status"], "succeeded", finished)
        listed = self.runner.list_runs("web-project")
        self.assertEqual([item["run_id"] for item in listed], [started["run_id"]])
        self.assertIn("dataset:mid", listed[0]["produced_artifact_ids"])
        self.assertEqual(self.runner.list_runs("other-project"), [])
        definition = self.runner.definition("web-project", started["run_id"])
        self.assertEqual(definition["spec"]["format"], "annobio.pipeline-spec")
        self.assertFalse(any("datasetContent" in node for node in definition["canvas_state"]["nodes"]))
        self.assertEqual([job["status"] for job in finished["jobs"]], ["succeeded"] * 3)
        self.assertEqual([(job["completed"], job["total"]) for job in finished["jobs"]],
                         [(2, 2), (1, 1), (2, 2)])
        self.assertEqual(finished["plan"]["inputs"][0]["row_count"], 2)
        self.assertEqual(finished["plan"]["jobs"][0]["estimated_calls"], 2)
        self.assertIsNone(finished["plan"]["jobs"][2]["estimated_calls"])
        self.assertEqual(finished["plan"]["jobs"][0]["model"]["model"], "mock")
        self.assertEqual(self.calls, ["llm:r1", "llm:r2"])
        result = self.runner.results("web-project", started["run_id"])
        self.assertEqual(result["outputs"][0]["table"]["headers"][-1], "Output: final")
        self.assertEqual(len(result["outputs"][0]["table"]["rows"]), 2)
        self.assertEqual(state, original, "Runner must never materialize results into canvas datasets")
        run_path = next(Path(self.temp.name).glob(f"*/{started['run_id']}/run.json"))
        persisted = json.loads(run_path.read_text(encoding="utf-8"))
        self.assertNotIn("secret", json.dumps(persisted))
        self.assertGreaterEqual(len(persisted["artifacts"]), 4)

    def test_static_split_merge_graph_runs_each_join_once(self):
        state = branched()
        raw = next(node for node in state["nodes"] if node["nodeId"] == "raw")
        raw["datasetContent"] = {
            "headers": ["text"], "columnTypes": ["text"], "rowIds": [1, 2],
            "rows": [["a"], ["b"]],
        }
        split = next(node for node in state["nodes"] if node["nodeId"] == "split")
        split["dfCode"] = (
            "def process(df):\n"
            "    return {'left': df, 'right': df.rename(columns={'text': 'other'})}\n"
        )
        merge = next(node for node in state["nodes"] if node["nodeId"] == "merge")
        merge["dfCode"] = (
            "def process(df):\n"
            "    out = df.copy()\n"
            "    out['text'] = out['text'] + ':' + df_right['other']\n"
            "    return out\n"
        )
        next(node for node in state["nodes"] if node["nodeId"] == "r")["runCredentialId"] = "cred"
        started = self.runner.start(
            project_id="branches", canvas_state=state, route=route_for(state),
            input_dataset_ids=["raw"],
        )
        finished = self.wait("branches", started["run_id"])
        self.assertEqual(finished["status"], "succeeded", finished)
        self.assertEqual([job["job_id"] for job in finished["jobs"]],
                         ["process:split", "process:merge", "llm:r"])
        self.assertEqual([job["attempts"] for job in finished["jobs"]], [1, 1, 1])
        branch_ids = {item["logical_id"] for item in finished["artifacts"]}
        self.assertTrue({"dataset:left", "dataset:right", "dataset:merged"}.issubset(branch_ids))
        result = self.runner.results("branches", started["run_id"])["outputs"][0]["table"]
        self.assertEqual([row[-1] for row in result["rows"]], ["Read a:a", "Read b:b"])

    def test_empty_llm_input_skips_model_and_process_still_runs_with_schema(self):
        state = {"nodes": [
            dataset("raw", ["text"], []),
            {"type": "process", "nodeId": "make", "name": "make", "primaryDatasetId": "raw",
             "dfCode": "def process(df):\n    return df.assign(done=pd.Series(dtype='str'))\n"},
            dataset("out", [], [], processOutputName="result"),
        ], "connections": [edge("raw", "make", "dataset-to-process"), edge("make", "out", "process-to-dataset")]}
        route = [{"type": "dataset", "dataset_node_id": "raw"},
                 {"type": "process", "process_node_id": "make"},
                 {"type": "dataset", "dataset_node_id": "out"}]
        started = self.runner.start(project_id="empty", canvas_state=state, route=route,
                                    input_dataset_ids=["raw"])
        finished = self.wait("empty", started["run_id"])
        self.assertEqual(finished["status"], "succeeded", finished)
        result = self.runner.results("empty", started["run_id"])
        self.assertEqual(result["outputs"][0]["table"]["headers"], ["text", "done"])
        self.assertEqual(result["outputs"][0]["table"]["rows"], [])
        self.assertEqual(self.calls, [])

    def test_failed_job_keeps_upstream_checkpoint_and_resume_does_not_repeat_it(self):
        state, route = serial_state([['one']])
        self.fail_second = True
        started = self.runner.start(project_id="resume", canvas_state=state, route=route,
                                    input_dataset_ids=["raw"])
        failed = self.wait("resume", started["run_id"])
        self.assertEqual(failed["status"], "failed")
        self.assertEqual([job["status"] for job in failed["jobs"]],
                         ["succeeded", "succeeded", "failed"])
        self.fail_second = False
        self.runner.resume("resume", started["run_id"])
        done = self.wait("resume", started["run_id"])
        self.assertEqual(done["status"], "succeeded", done)
        self.assertEqual([job["attempts"] for job in done["jobs"]], [1, 1, 2])
        self.assertEqual(self.calls.count("llm:r1"), 1)

    def test_llm_resume_only_retries_failed_rows(self):
        state, route = serial_state()
        self.fail_text_once = "beta"
        started = self.runner.start(project_id="rows", canvas_state=state, route=route,
                                    input_dataset_ids=["raw"])
        failed = self.wait("rows", started["run_id"])
        self.assertEqual(failed["status"], "failed")
        self.assertNotIn("row_checkpoints", failed["jobs"][0])
        run_path = next(Path(self.temp.name).glob(f"*/{started['run_id']}/run.json"))
        first = json.loads(run_path.read_text(encoding="utf-8"))["jobs"][0]
        self.assertNotIn("row_checkpoints", first, "row results must not live in run.json")
        rows = self.runner._row_checkpoints("rows", started["run_id"], "llm:r1", first["fingerprint"])
        self.assertEqual(rows["0"]["status"], "succeeded")
        self.assertEqual(rows["1"]["status"], "failed")
        self.runner.resume("rows", started["run_id"])
        done = self.wait("rows", started["run_id"])
        self.assertEqual(done["status"], "succeeded", done)
        first_prompts = [item for item in self.invocations if item.startswith("First")]
        self.assertEqual(sum("alpha" in item for item in first_prompts), 1)
        self.assertEqual(sum("beta" in item for item in first_prompts), 2)
        self.assertEqual(done["jobs"][0]["attempts"], 2)

    def test_start_and_resume_are_idempotent(self):
        state, route = serial_state([["one"]])
        first = self.runner.start(project_id="idem", canvas_state=state, route=route,
                                  input_dataset_ids=["raw"], request_id="request-one")
        duplicate = self.runner.start(project_id="idem", canvas_state=state, route=route,
                                      input_dataset_ids=["raw"], request_id="request-one")
        self.assertEqual(first["run_id"], duplicate["run_id"])
        self.wait("idem", first["run_id"])

        self.fail_second = True
        failed_run = self.runner.start(project_id="idem", canvas_state=state, route=route,
                                       input_dataset_ids=["raw"], request_id="request-two")
        self.wait("idem", failed_run["run_id"])
        self.fail_second = False
        self.block_jobs = True
        resumed = self.runner.resume("idem", failed_run["run_id"])
        duplicate_resume = self.runner.resume("idem", failed_run["run_id"])
        self.assertEqual(resumed["run_id"], duplicate_resume["run_id"])
        self.assertIn(duplicate_resume["status"], {"pending", "running"})
        self.runner.cancel("idem", failed_run["run_id"])
        self.wait("idem", failed_run["run_id"])

    def test_revision_reuses_only_unchanged_upstream(self):
        state, route = serial_state([["one"]])
        original = self.runner.start(project_id="revision", canvas_state=state, route=route,
                                     input_dataset_ids=["raw"])
        self.wait("revision", original["run_id"])
        state["nodes"][4]["dfCode"] = (
            "def process(df):\n"
            "    return pd.DataFrame({'answer': [str(x).lower() for x in df['Output: answer']]})\n"
        )
        revised = self.runner.revise(
            "revision", original["run_id"], canvas_state=state, route=route,
            input_dataset_ids=["raw"], request_id="revision-request",
        )
        duplicate = self.runner.revise(
            "revision", original["run_id"], canvas_state=state, route=route,
            input_dataset_ids=["raw"], request_id="revision-request",
        )
        self.assertEqual(revised["run_id"], duplicate["run_id"])
        done = self.wait("revision", revised["run_id"])
        self.assertEqual(done["revision"], 2)
        self.assertEqual(done["parent_run_id"], original["run_id"])
        self.assertIsNotNone(done["jobs"][0]["reused_from"])
        self.assertIsNone(done["jobs"][1]["reused_from"])
        self.assertEqual(self.calls.count("llm:r1"), 1)
        self.assertEqual(self.calls.count("llm:r2"), 2)

    def test_backend_restart_marks_active_run_interrupted_and_resumes_checkpoint(self):
        state, route = serial_state([["one"]])
        self.fail_second = True
        started = self.runner.start(project_id="restart", canvas_state=state, route=route,
                                    input_dataset_ids=["raw"])
        self.wait("restart", started["run_id"])
        run_path = next(Path(self.temp.name).glob(f"*/{started['run_id']}/run.json"))
        persisted = json.loads(run_path.read_text(encoding="utf-8"))
        persisted["status"] = "running"
        persisted["jobs"][-1]["status"] = "running"
        persisted["jobs"][-1]["attempt_token"] = "abandoned"
        run_path.write_text(json.dumps(persisted), encoding="utf-8")
        # A crash leaves the active marker that start/resume wrote; the finished run removed it.
        marker = Path(self.temp.name) / "active" / f"{started['run_id']}.json"
        marker.write_text(json.dumps({"project_id": "restart", "run_id": started["run_id"]}), encoding="utf-8")
        restarted = PipelineRunner(
            Path(self.temp.name), credential_resolver=self.runner.credential_resolver,
            settings_loader=lambda: dict(DEFAULTS), llm_adapter=self.runner.llm_adapter,
        )
        interrupted = restarted.status("restart", started["run_id"])
        self.assertEqual(interrupted["status"], "interrupted")
        self.assertEqual(interrupted["jobs"][-1]["status"], "interrupted")
        self.fail_second = False
        restarted.resume("restart", started["run_id"])
        self.runner = restarted
        done = self.wait("restart", started["run_id"])
        self.assertEqual(done["status"], "succeeded", done)
        self.assertEqual(self.calls.count("llm:r1"), 1)

    def test_resume_reports_missing_credential_without_losing_checkpoint(self):
        state, route = serial_state([["one"]])
        self.fail_second = True
        started = self.runner.start(project_id="missing-resource", canvas_state=state, route=route,
                                    input_dataset_ids=["raw"])
        self.wait("missing-resource", started["run_id"])
        self.fail_second = False
        self.runner.credential_resolver = lambda _: None
        self.runner.resume("missing-resource", started["run_id"])
        failed = self.wait("missing-resource", started["run_id"])
        self.assertEqual(failed["status"], "failed")
        self.assertIn('Credential "cred" was not found', failed["error"])
        self.assertEqual([job["attempts"] for job in failed["jobs"]], [1, 1, 2])

    def test_project_scope_and_compile_diagnostics(self):
        state, route = serial_state([['one']])
        started = self.runner.start(project_id="owner-a", canvas_state=state, route=route,
                                    input_dataset_ids=["raw"])
        with self.assertRaises(KeyError):
            self.runner.status("owner-b", started["run_id"])
        self.wait("owner-a", started["run_id"])
        state["nodes"][2]["runInputToColumn"] = {"text": "missing"}
        compiled = self.runner.compile(canvas_state=state, route=route, input_dataset_ids=["raw"])
        self.assertIsNone(compiled["spec"])
        self.assertTrue(any(item["severity"] == "error" for item in compiled["diagnostics"]))

    def test_table_llm_output_expands_rows_with_source_indices(self):
        job = {"id": "llm:table", "config": {
            "sections": [{"name": "Task", "content": "List {text}"}],
            "input_mapping": {"text": "text"}, "input_types": {"text": "text"},
            "output_schema": {"return_shape": "table", "fields": [
                {"key": "item", "display": "Item", "type": "str", "allow_none": False},
            ]},
            "settings": {"run_max_tokens": 100, "run_max_retries": 0, "run_concurrency": 1},
        }}

        def invoke(**_):
            return {"rows": [{"item": "a"}, {"item": "b"}]}, False, {}

        result = execute_llm_job(
            job, {"headers": ["text"], "rows": [["source"]]},
            {"model": "mock", "api_key": "secret"}, None, threading.Event(), invoke=invoke,
        )["table"]
        self.assertEqual(result["headers"], ["Input: #", "Input: text", "Output: #", "Output: Item"])
        self.assertEqual(result["rows"], [[1, "source", 1, "a"], [1, "source", 2, "b"]])

    def test_cancel_stops_new_jobs_and_marks_the_run(self):
        state, route = serial_state([["one"]])
        state["nodes"] = state["nodes"][:4]
        state["connections"] = [edge("p1", "r1", "prompt-to-run")]
        route = route[:3]
        self.block_jobs = True
        started = self.runner.start(project_id="cancel", canvas_state=state, route=route,
                                    input_dataset_ids=["raw"])
        deadline = time.time() + 2
        while not self.calls and time.time() < deadline:
            time.sleep(0.01)
        cancelling = self.runner.cancel("cancel", started["run_id"])
        self.assertEqual(cancelling["status"], "cancelling")
        finished = self.wait("cancel", started["run_id"])
        self.assertEqual(finished["status"], "cancelled")
        self.assertEqual(finished["jobs"][0]["status"], "cancelled")

    def test_late_llm_response_cannot_turn_cancelled_run_into_success(self):
        entered = threading.Event()
        release = threading.Event()

        def late_invoke(**_):
            entered.set()
            release.wait(5)
            return {"answer": "late"}, False, {}

        def adapter(job, table, credential, session_id, cancel_event, **kwargs):
            return execute_llm_job(
                job, table, credential, session_id, cancel_event, invoke=late_invoke, **kwargs,
            )

        self.runner = PipelineRunner(
            Path(self.temp.name), credential_resolver=lambda value: {
                "id": value, "model": "mock", "provider": "mock", "api_key": "secret",
            }, settings_loader=lambda: dict(DEFAULTS), llm_adapter=adapter,
        )
        state, route = serial_state([["one"]])
        state["nodes"] = state["nodes"][:4]
        state["connections"] = [edge("p1", "r1", "prompt-to-run")]
        route = route[:3]
        started = self.runner.start(project_id="late", canvas_state=state, route=route,
                                    input_dataset_ids=["raw"])
        self.assertTrue(entered.wait(3), "LLM request did not start")
        cancelling = self.runner.cancel("late", started["run_id"])
        self.assertEqual(cancelling["status"], "cancelling")
        release.set()
        finished = self.wait("late", started["run_id"])
        self.assertEqual(finished["status"], "cancelled")
        self.assertEqual(finished["jobs"][0]["status"], "cancelled")
        output_records = [item for item in finished["artifacts"] if item["producer"]]
        self.assertTrue(output_records)
        self.assertTrue(all(item["valid"] is False for item in output_records))


    def test_run_json_writes_do_not_grow_with_row_count(self):
        def saves_for(rows, project_id):
            state, route = serial_state([[f"row {index}"] for index in range(rows)])
            state["nodes"] = state["nodes"][:4]
            state["connections"] = [edge("p1", "r1", "prompt-to-run")]
            original_save = self.runner._save_run
            count = 0

            def counting_save(run):
                nonlocal count
                count += 1
                original_save(run)

            with mock.patch.object(self.runner, "_save_run", counting_save):
                started = self.runner.start(project_id=project_id, canvas_state=state, route=route[:3],
                                            input_dataset_ids=["raw"])
                finished = self.wait(project_id, started["run_id"])
            self.assertEqual(finished["status"], "succeeded", finished)
            self.assertEqual((finished["jobs"][0]["completed"], finished["jobs"][0]["total"]), (rows, rows))
            run_path = next(Path(self.temp.name).glob(f"*/{started['run_id']}/run.json"))
            self.assertNotIn("row ", run_path.read_text(encoding="utf-8").replace("row_ids", ""),
                             "row outputs must stay out of run.json")
            return count

        self.assertEqual(saves_for(3, "few-rows"), saves_for(30, "many-rows"))

    def test_status_reports_live_row_progress_without_rewriting_run_json(self):
        second_row = threading.Event()
        release = threading.Event()

        def invoke(**kwargs):
            if "beta" in kwargs["prompt"]:
                second_row.set()
                release.wait(5)
            return {"answer": kwargs["prompt"]}, False, {}

        def adapter(job, table, credential, session_id, cancel_event, **kwargs):
            return execute_llm_job(job, table, credential, session_id, cancel_event, invoke=invoke, **kwargs)

        self.runner.llm_adapter = adapter
        state, route = serial_state([["alpha"], ["beta"]])
        state["nodes"] = state["nodes"][:4]
        state["connections"] = [edge("p1", "r1", "prompt-to-run")]
        settings = dict(DEFAULTS, run_concurrency=1)
        self.runner.settings_loader = lambda: dict(settings)
        started = self.runner.start(project_id="live", canvas_state=state, route=route[:3],
                                    input_dataset_ids=["raw"])
        try:
            self.assertTrue(second_row.wait(3), "second row did not start")
            live = self.runner.status("live", started["run_id"])
            self.assertEqual((live["jobs"][0]["completed"], live["jobs"][0]["total"]), (1, 2))
            run_path = next(Path(self.temp.name).glob(f"*/{started['run_id']}/run.json"))
            persisted = json.loads(run_path.read_text(encoding="utf-8"))["jobs"][0]
            self.assertEqual(persisted["completed"], 0, "progress is not written to run.json per row")
        finally:
            release.set()
        done = self.wait("live", started["run_id"])
        self.assertEqual((done["jobs"][0]["completed"], done["jobs"][0]["total"]), (2, 2))

    def test_request_lookup_and_startup_do_not_scan_run_history(self):
        state, route = serial_state([["one"]])
        for index in range(3):
            older = self.runner.start(project_id="history", canvas_state=state, route=route,
                                      input_dataset_ids=["raw"], request_id=f"older-{index}")
            self.wait("history", older["run_id"])
        with mock.patch.object(Path, "glob", side_effect=AssertionError("run history was scanned")):
            first = self.runner.start(project_id="history", canvas_state=state, route=route,
                                      input_dataset_ids=["raw"], request_id="new-request")
            duplicate = self.runner.start(project_id="history", canvas_state=state, route=route,
                                          input_dataset_ids=["raw"], request_id="new-request")
        self.assertEqual(first["run_id"], duplicate["run_id"])
        self.wait("history", first["run_id"])
        self.assertEqual(list((Path(self.temp.name) / "active").glob("*.json")), [],
                         "finished runs leave no active marker")
        with mock.patch.object(Path, "glob", wraps=Path.glob, autospec=True) as globbed:
            PipelineRunner(Path(self.temp.name), credential_resolver=self.runner.credential_resolver,
                           settings_loader=lambda: dict(DEFAULTS))
        self.assertEqual([call.args[1] for call in globbed.call_args_list], ["*.json"],
                         "startup reads only the active markers")

if __name__ == "__main__":
    unittest.main()
