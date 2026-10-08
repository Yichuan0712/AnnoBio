"""Compiler acceptance tests: real canvas shapes, no model/network/user-code execution."""
from copy import deepcopy
import json
from pathlib import Path
import shutil
import subprocess
import unittest

from backend.pipeline_compile import compile_pipeline


DEFAULTS = {"run_max_tokens": 8192, "run_max_retries": 2, "run_concurrency": 4}


def dataset(nid, headers=None, **extra):
    return {"type": "dataset", "nodeId": nid, "name": nid,
            "datasetContent": {"headers": headers if headers is not None else ["text"], "rows": [["PRIVATE_ROW"]]}, **extra}


def prompt(nid="p", content="Read {text}"):
    return {"type": "prompt", "nodeId": nid, "name": nid, "sections": [{"name": "Task", "content": content}],
            "outputFormat": {"returnShape": "single", "fields": [{"key": "answer", "type": "str"}]}}


def run(nid="r", **extra):
    return {"type": "run", "nodeId": nid, "runName": nid,
            "runInputToColumn": {"text": "text"}, "runCredentialId": "PRIVATE_CREDENTIAL",
            "runResults": "PRIVATE_RESULTS", **extra}


def process(nid, **extra):
    return {"type": "process", "nodeId": nid, "name": nid,
            "dfCode": "def process(df):\n    return df\n", **extra}


def edge(a, b, typ):
    return {"fromId": a, "toId": b, "type": typ}


def data(a, b, alias=None, port="result"):
    """An input of step b read from a (a Dataset, or a step's output port): a Run's only input has
    no alias, a Process's primary is df."""
    return {"type": "data", "fromId": a, "fromPort": port, "toId": b, **({"alias": alias} if alias else {})}


SPLIT_CODE = "def process(df):\n    return {'left': df, 'right': df}\n"


def route_for(state):
    selected = []
    for n in state["nodes"]:
        if n["type"] in {"dataset", "process"}:
            selected.append({"type": n["type"], f"{n['type']}_node_id": n["nodeId"]})
        elif n["type"] == "run":
            pid = next(e["fromId"] for e in state["connections"] if e["type"] == "prompt-to-run" and e["toId"] == n["nodeId"])
            selected.append({"type": "prompt", "prompt_node_id": pid, "run_node_id": n["nodeId"]})
    return selected


def simple():
    return {"nodes": [dataset("raw"), prompt(), run()], "connections": [edge("p", "r", "prompt-to-run"), data("raw", "r")]}


def branched():
    """raw -> split (left, right) -> merge -> LLM, each step reading the one before it directly."""
    return {"nodes": [dataset("raw"), process("split", dfCode=SPLIT_CODE),
        process("merge", dfCode="def process(df):\n    return df.merge(df_right)\n"), prompt(), run()],
        "connections": [data("raw", "split", "df"), data("split", "merge", "df", "left"),
            data("split", "merge", "df_right", "right"), edge("p", "r", "prompt-to-run"), data("merge", "r")]}


class PipelineCompileTests(unittest.TestCase):
    def compile(self, state, **kwargs):
        return compile_pipeline(canvas_state=state, route=kwargs.pop("route", route_for(state)),
                                run_defaults=kwargs.pop("run_defaults", DEFAULTS), **kwargs)

    def valid(self, state, **kwargs):
        result = self.compile(state, **kwargs)
        self.assertIsNotNone(result["spec"], result["diagnostics"])
        return result["spec"]

    def error(self, state, code, **kwargs):
        result = self.compile(state, **kwargs)
        self.assertIsNone(result["spec"], result)
        self.assertIn(code, [d["code"] for d in result["diagnostics"]], result)

    def test_simple_implicit_output_and_immutable_code_only_snapshot(self):
        state = simple()
        original = deepcopy(state)
        spec = self.valid(state)
        self.assertEqual(state, original)
        self.assertEqual(spec["inputs"], ["dataset:raw"])
        self.assertEqual(spec["outputs"], ["output:llm:r:result"])
        self.assertEqual(spec["jobs"][0]["config"]["settings"], DEFAULTS)
        serialized = json.dumps(spec)
        for private in ["PRIVATE_ROW", "PRIVATE_CREDENTIAL", "PRIVATE_RESULTS"]:
            self.assertNotIn(private, serialized)
        state["nodes"][1]["sections"][0]["content"] = "changed"
        self.assertEqual(spec["jobs"][0]["config"]["sections"][0]["content"], "Read {text}")

    def test_missing_result_input_boundary_is_rejected(self):
        state = simple()
        state["nodes"][0]["resultMissing"] = True
        state["nodes"][0]["datasetContent"] = {"headers": [], "rows": []}
        self.error(state, "MISSING_RESULT", input_dataset_ids=["raw"])

    def test_graph_order_does_not_depend_on_canvas_or_route_order(self):
        state = branched()
        expected = self.compile(state)
        state["nodes"].reverse()
        state["connections"].reverse()
        self.assertEqual(expected, self.compile(state, route=list(reversed(route_for(state)))))
        self.assertEqual([j["id"] for j in expected["spec"]["jobs"]], ["process:split", "process:merge", "llm:r"])

    def test_branch_merge_preserves_aliases_and_has_one_merge_job(self):
        spec = self.valid(branched())
        split, merge, llm = spec["jobs"]
        self.assertEqual(split["outputs"], {"left": ["output:process:split:left"], "right": ["output:process:split:right"]})
        self.assertEqual(merge["inputs"], {"df": "output:process:split:left", "df_right": "output:process:split:right"})
        self.assertEqual(merge["depends_on"], ["process:split"])
        self.assertEqual(llm["inputs"], {"data": "output:process:merge:result"})
        self.assertEqual(llm["depends_on"], ["process:merge"])
        self.assertEqual(spec["inputs"], ["dataset:raw"])
        self.assertEqual(spec["outputs"], ["output:llm:r:result"])
        # Outputs are named after the step that makes them: a Prompt, a Process, or a branch.
        names = {artifact["id"]: artifact["name"] for artifact in spec["artifacts"]}
        self.assertEqual(names, {"dataset:raw": "raw", "output:process:split:left": "left", "output:process:split:right": "right",
                                 "output:process:merge:result": "merge", "output:llm:r:result": "p"})

    def test_multiple_inputs_and_process_only_are_valid_specs(self):
        state = {"nodes": [dataset("a"), dataset("b"), process("join")],
                 "connections": [data("a", "join", "df"), data("b", "join", "df_b")]}
        spec = self.valid(state)
        self.assertEqual(spec["inputs"], ["dataset:a", "dataset:b"])
        self.assertEqual(spec["outputs"], ["output:process:join:result"])
        del state["connections"][0]["alias"]
        self.error(state, "INVALID_PRIMARY_INPUT")

    def test_a_run_reading_a_process_output_is_checked_when_it_runs(self):
        state = branched()
        state["nodes"][-1]["runInputToColumn"] = {"text": "new_column"}
        result = self.compile(state)
        self.assertIsNotNone(result["spec"], result)
        self.assertIn("RUNTIME_INPUT_SCHEMA", [d["code"] for d in result["diagnostics"]])
        art = next(a for a in result["spec"]["artifacts"] if a["id"] == "output:process:merge:result")
        self.assertEqual(art["schema"], {"status": "runtime", "columns": []})
        state["nodes"][-1]["runInputToColumn"] = {}
        self.error(state, "UNMAPPED_INPUT")

    def test_a_run_reading_a_run_knows_its_columns(self):
        state = simple()
        state["nodes"] += [prompt("p2"), run("r2", runInputToColumn={"text": "Output: answer"})]
        state["connections"] += [edge("p2", "r2", "prompt-to-run"), data("r", "r2")]
        spec = self.valid(state)
        art = next(a for a in spec["artifacts"] if a["id"] == "output:llm:r:result")
        self.assertEqual([c["name"] for c in art["schema"]["columns"]], ["Input: #", "Input: text", "Output: #", "Output: answer"])
        self.assertEqual(spec["jobs"][-1]["inputs"], {"data": "output:llm:r:result"})
        self.assertEqual(spec["jobs"][-1]["depends_on"], ["llm:r"])
        state["nodes"][-1]["runInputToColumn"] = {"text": "obsolete"}
        self.error(state, "MISSING_COLUMN")

    def test_multimodal_types_and_table_shape(self):
        state = simple()
        state["nodes"][0]["datasetContent"]["columnTypes"] = ["pdf"]
        state["nodes"][1]["inputTypes"] = {"text": "pdf"}
        state["nodes"][1]["outputFormat"]["returnShape"] = "table"
        spec = self.valid(state)
        self.assertEqual(spec["jobs"][0]["config"]["output_schema"]["return_shape"], "table")
        state["nodes"][1]["inputTypes"] = {"text": "image"}
        self.error(state, "INPUT_TYPE_MISMATCH")

    def test_legacy_mapping_inference_escaped_braces_and_ambiguity(self):
        state = simple()
        state["nodes"][1]["sections"][0]["content"] = "Read {Text}; ignore {{literal}}"
        state["nodes"][2]["runInputToColumn"] = "{}"
        self.assertEqual(self.valid(state)["jobs"][0]["config"]["input_mapping"], {"Text": "text"})
        state["nodes"][0]["datasetContent"]["headers"] = ["text", "TEXT"]
        self.error(state, "UNMAPPED_INPUT")

    def test_selection_excludes_other_versions_and_runs(self):
        state = simple()
        selected = route_for(state)
        state["nodes"] += [prompt("p2", "UNSELECTED"), run("r2")]
        state["connections"] += [edge("p", "p2", "prompt-to-prompt"), edge("p2", "r2", "prompt-to-run")]
        spec = self.valid(state, route=selected)
        self.assertEqual([j["id"] for j in spec["jobs"]], ["llm:r"])
        self.assertNotIn("UNSELECTED", json.dumps(spec))

    def test_missing_dependencies_are_not_added_silently(self):
        state = branched()
        selected = [i for i in route_for(state) if i.get("dataset_node_id") != "raw"]
        self.error(state, "MISSING_DEPENDENCY", route=selected)

    def test_reading_a_step_outside_the_selection_is_reported(self):
        state = branched()
        selected = [i for i in route_for(state) if i.get("process_node_id") != "split"]
        result = self.compile(state, route=selected)
        problem = next(d for d in result["diagnostics"] if d["code"] == "UNSELECTED_UPSTREAM")
        self.assertEqual((problem["node_id"], problem["message"].split(",")[0]), ("merge", 'Reads the output of "split"'))

    def test_a_dataset_saved_from_a_step_is_only_an_input(self):
        # A Dataset saved from the Run's results is a table of its own: reading it does not chain to the Run.
        state = simple()
        state["nodes"] += [dataset("saved", sourceRunNodeId="r"), prompt("p2"), run("r2")]
        state["connections"] += [edge("p2", "r2", "prompt-to-run"), data("saved", "r2"),
                                 edge("r", "saved", "run-to-dataset-snapshot")]
        spec = self.valid(state)
        self.assertEqual(spec["inputs"], ["dataset:raw", "dataset:saved"])
        self.assertEqual({job["id"]: job["depends_on"] for job in spec["jobs"]}, {"llm:r": [], "llm:r2": []})

    def test_steps_reading_each_other_are_a_cycle(self):
        state = {"nodes": [process("a"), process("b")],
                 "connections": [data("b", "a", "df"), data("a", "b", "df")]}
        self.error(state, "CYCLIC_DEPENDENCY")

    def test_a_branch_the_process_does_not_return_is_reported(self):
        state = branched()
        next(e for e in state["connections"] if e.get("alias") == "df_right")["fromPort"] = "middle"
        result = self.compile(state)
        self.assertIn(("UNKNOWN_OUTPUT_PORT", "merge"), [(d["code"], d["node_id"]) for d in result["diagnostics"]])
        state = simple()
        state["nodes"] += [prompt("p2"), run("r2")]
        state["connections"] += [edge("p2", "r2", "prompt-to-run"), data("r", "r2", port="other")]
        self.error(state, "UNKNOWN_OUTPUT_PORT")

    def test_every_branch_of_a_process_is_an_output_and_named_by_its_branch(self):
        state = {"nodes": [dataset("raw"), process("split", dfCode=SPLIT_CODE)], "connections": [data("raw", "split", "df")]}
        spec = self.valid(state)
        self.assertEqual(spec["outputs"], ["output:process:split:left", "output:process:split:right"])
        self.assertEqual([a["name"] for a in spec["artifacts"] if a["producer"]], ["left", "right"])
        # A branch nobody reads stays an output of the pipeline.
        state = branched()
        state["nodes"][1]["dfCode"] = "def process(df):\n    return {'left': df, 'right': df, 'rest': df}\n"
        self.assertIn("output:process:split:rest", self.valid(state)["outputs"])

    def test_dynamic_branches_are_the_ones_read_downstream(self):
        state = branched()
        for code in ["def process(df):\n    return {name: df for name in ('left', 'right')}\n",
                     "def process(df):\n    out = {'left': df, 'right': df}\n    return out\n"]:
            with self.subTest(code=code):
                state["nodes"][1]["dfCode"] = code
                result = self.compile(state)
                self.assertIsNotNone(result["spec"], result)
                split = next(job for job in result["spec"]["jobs"] if job["id"] == "process:split")
                self.assertEqual(sorted(split["outputs"]), ["left", "right"])
                self.assertIn(("RUNTIME_PROCESS_CONTRACT", "warning"), [(d["code"], d["severity"]) for d in result["diagnostics"]])

    def test_run_diagnostics_name_the_connected_prompt(self):
        state = simple()
        state["nodes"][-1]["runName"] = "Run"
        state["nodes"][-1]["runInputToColumn"] = {"text": "missing"}
        result = self.compile(state)
        problem = next(item for item in result["diagnostics"] if item["code"] == "MISSING_COLUMN")
        self.assertEqual(problem["node_name"], "Run · p")

    def test_unused_dataset_does_not_block_and_wrong_prompt_pair(self):
        state = simple()
        state["nodes"].append(dataset("unused"))
        spec = self.valid(state)
        self.assertNotIn("dataset:unused", [item["id"] for item in spec["artifacts"]])
        self.assertNotIn("dataset:unused", spec["inputs"])
        state = simple()
        state["nodes"].append(prompt("p2"))
        state["connections"].append(edge("p2", "r", "prompt-to-run"))
        self.error(state, "PROMPT_RUN_MISMATCH")

    def test_process_code_is_parsed_never_executed(self):
        state = branched()
        state["nodes"][1]["dfCode"] = "raise RuntimeError('MUST NOT EXECUTE')\ndef process(df):\n    return {'left': df, 'right': df}\n"
        self.valid(state)
        for code in ["# def process(df):\npass", "def process(data):\n    return data", "def process(df, df_right, /):\n    return df", "async def process(df):\n    return df", "def process(df): this is invalid python!"]:
            with self.subTest(code=code):
                state["nodes"][1]["dfCode"] = code
                self.error(state, "INVALID_PROCESS_FUNCTION")

    def test_unbound_process_alias_and_duplicate_alias(self):
        state = branched()
        state["nodes"][2]["dfCode"] = "def process(df):\n    return df_missing\n"
        self.error(state, "UNBOUND_DATASET_ALIAS")
        for code in ["def process(df, df_missing):\n    return df", "def process(df, *, df_missing):\n    return df"]:
            with self.subTest(code=code):
                state["nodes"][2]["dfCode"] = code
                self.error(state, "UNBOUND_DATASET_ALIAS")
        # Its other Input dataset is a parameter; one more with a default, or **inputs, needs none.
        for code in ["def process(df, df_right):\n    return df.merge(df_right)\n",
                     "def process(df, df_right, limit=5, **inputs):\n    return df.merge(df_right)\n"]:
            with self.subTest(code=code):
                state["nodes"][2]["dfCode"] = code
                self.valid(state)
        next(e for e in state["connections"] if e.get("alias") == "df_right")["alias"] = "right"
        self.error(state, "INVALID_ALIAS")

    def test_node_settings_override_defaults_without_copying_credentials(self):
        state = simple()
        state["nodes"][2]["runSettings"] = '{"run_max_tokens": 2048, "api_key": "SECRET"}'
        spec = self.valid(state)
        self.assertEqual(spec["jobs"][0]["config"]["settings"]["run_max_tokens"], 2048)
        self.assertNotIn("SECRET", json.dumps(spec))
        state["nodes"][2]["runSettings"] = {"run_concurrency": 0}
        self.error(state, "INVALID_RUN_SETTING")
        state["nodes"][2]["runSettings"] = {}
        result = self.compile(state, run_defaults={})
        self.assertEqual(set(result["spec"]["jobs"][0]["config"]["unresolved_settings"]), set(DEFAULTS))

    def test_multiple_diagnostics_invalid_json_and_duplicate_schema(self):
        state = simple()
        state["nodes"][0]["datasetContent"]["headers"] = ["text", "text"]
        state["nodes"][2]["runInputToColumn"] = "{"
        state["nodes"][1]["outputFormat"]["fields"] = []
        result = self.compile(state)
        self.assertIsNone(result["spec"])
        self.assertTrue({"DUPLICATE_COLUMNS", "INVALID_OBJECT", "EMPTY_OUTPUT_SCHEMA"} <= {d["code"] for d in result["diagnostics"]})

    def test_bad_canvas_and_route_return_diagnostics(self):
        for state, selected in [(None, []), ({"nodes": []}, None), ({"nodes": []}, [None]),
                                ({"nodes": []}, [{"type": "prompt"}]), ({"nodes": []}, [{"type": []}])]:
            result = compile_pipeline(canvas_state=state, route=selected)
            self.assertIsNone(result["spec"])
            self.assertTrue(result["diagnostics"])

    def test_non_string_mapping_does_not_fall_back_to_inferred_column(self):
        state = simple()
        state["nodes"][2]["runInputToColumn"] = {"text": ["text"]}
        self.error(state, "INVALID_INPUT_MAPPING")

    def test_two_readers_share_one_job_output(self):
        state = simple()
        state["nodes"] += [process("a"), process("b")]
        state["connections"] += [data("r", "a", "df"), data("r", "b", "df")]
        spec = self.valid(state)
        jobs = {job["id"]: job for job in spec["jobs"]}
        self.assertEqual(jobs["llm:r"]["outputs"], {"result": ["output:llm:r:result"]})
        self.assertEqual(jobs["process:a"]["inputs"], jobs["process:b"]["inputs"])

    def test_complex_output_names_have_canonical_keys_and_display_columns(self):
        state = simple()
        state["nodes"][1]["outputFormat"]["fields"][0]["key"] = "drug-name"
        result = self.compile(state)
        self.assertIsNotNone(result["spec"], result)
        field = result["spec"]["jobs"][0]["config"]["output_schema"]["fields"][0]
        self.assertEqual((field["key"], field["display"]), ("drug_name", "drug-name"))
        self.assertEqual(result["spec"]["artifacts"][-1]["schema"]["columns"][-1]["name"], "Output: drug-name")

    @unittest.skipUnless(shutil.which("node"), "Node is needed for the frontend/compiler boundary test")
    def test_real_frontend_selection_compiles(self):
        script = Path(__file__).parents[1] / "app" / "tests" / "pipelineSelectionBridge.mjs"
        state = branched()
        result = subprocess.run(["node", str(script)], input=json.dumps(state), capture_output=True, text=True, check=True, timeout=15)
        selected = json.loads(result.stdout)
        spec = self.valid(state, route=selected)
        self.assertEqual([j["id"] for j in spec["jobs"]], ["process:split", "process:merge", "llm:r"])


if __name__ == "__main__":
    unittest.main()
