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


def run(nid="r", input_id="raw", **extra):
    return {"type": "run", "nodeId": nid, "runName": nid, "runWorkingSetId": input_id,
            "runInputToColumn": {"text": "text"}, "runCredentialId": "PRIVATE_CREDENTIAL",
            "runResults": "PRIVATE_RESULTS", **extra}


def process(nid, primary="", **extra):
    return {"type": "process", "nodeId": nid, "name": nid, "primaryDatasetId": primary,
            "dfCode": "def process(df):\n    return df\n", **extra}


def edge(a, b, typ):
    return {"fromId": a, "toId": b, "type": typ}


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
    return {"nodes": [dataset("raw"), prompt(), run()], "connections": [edge("p", "r", "prompt-to-run")]}


def branched():
    return {"nodes": [dataset("raw"), process("split"),
        dataset("left", processOutputName="left"), dataset("right", processOutputName="right"),
        process("merge", "left", datasetAliases={"right": "df_right"}, dfCode="def process(df):\n    return df.merge(df_right)\n"),
        dataset("merged"), prompt(), run(input_id="merged")],
        "connections": [edge("raw", "split", "dataset-to-process"), edge("split", "left", "process-to-dataset"),
            edge("split", "right", "process-to-dataset"), edge("left", "merge", "dataset-to-process"),
            edge("right", "merge", "dataset-to-process"), edge("merge", "merged", "process-to-dataset"),
            edge("p", "r", "prompt-to-run")]}


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
        self.assertEqual(split["outputs"], {"left": ["dataset:left"], "right": ["dataset:right"]})
        self.assertEqual(merge["inputs"], {"df": "dataset:left", "df_right": "dataset:right"})
        self.assertEqual(merge["depends_on"], ["process:split"])
        self.assertEqual(llm["depends_on"], ["process:merge"])

    def test_multiple_inputs_and_process_only_are_valid_specs(self):
        state = {"nodes": [dataset("a"), dataset("b"), process("join", "a", datasetAliases={"b": "df_b"}), dataset("out")],
                 "connections": [edge("a", "join", "dataset-to-process"), edge("b", "join", "dataset-to-process"), edge("join", "out", "process-to-dataset")]}
        self.assertEqual(self.valid(state)["inputs"], ["dataset:a", "dataset:b"])
        state["nodes"][2]["primaryDatasetId"] = ""
        self.error(state, "INVALID_PRIMARY_INPUT")

    def test_dynamic_process_schema_is_not_inferred_from_cached_rows(self):
        state = branched()
        state["nodes"][5]["datasetContent"]["headers"] = ["old_column"]
        state["nodes"][-1]["runInputToColumn"] = {"text": "new_column"}
        result = self.compile(state)
        self.assertIsNotNone(result["spec"], result)
        self.assertIn("RUNTIME_INPUT_SCHEMA", [d["code"] for d in result["diagnostics"]])
        art = next(a for a in result["spec"]["artifacts"] if a["id"] == "dataset:merged")
        self.assertEqual(art["schema"], {"status": "runtime", "columns": []})
        self.assertEqual(art["observed_schema"]["columns"], [{"name": "old_column", "type": "text"}])
        state["nodes"][-1]["runInputToColumn"] = {}
        self.error(state, "UNMAPPED_INPUT")

    def test_materialized_llm_schema_supports_second_llm_and_row_numbers(self):
        state = simple()
        state["nodes"] += [dataset("out", sourceRunNodeId="r"), prompt("p2"),
                           run("r2", "out", runInputToColumn={"text": "Output: answer"})]
        state["connections"].append(edge("p2", "r2", "prompt-to-run"))
        spec = self.valid(state)
        art = next(a for a in spec["artifacts"] if a["id"] == "dataset:out")
        self.assertEqual([c["name"] for c in art["schema"]["columns"]], ["Input: #", "Input: text", "Output: #", "Output: answer"])
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
        selected = [i for i in route_for(state) if i.get("dataset_node_id") != "right"]
        self.error(state, "MISSING_DEPENDENCY", route=selected)

    def test_saved_output_requires_explicit_boundary_when_producer_unselected(self):
        state = simple()
        state["nodes"][0]["sourceRunNodeId"] = "old-run"
        self.error(state, "UNSELECTED_PRODUCER")
        self.assertEqual(self.valid(state, input_dataset_ids=["raw"])["inputs"], ["dataset:raw"])

    def test_boundary_cannot_hide_selected_producer_or_cycle(self):
        state = simple()
        state["nodes"][0]["sourceRunNodeId"] = "r"
        self.error(state, "CYCLIC_DEPENDENCY")
        self.error(state, "INPUT_PRODUCER_CONFLICT", input_dataset_ids=["raw"])

    def test_multiple_producers_and_missing_branch_name(self):
        state = branched()
        state["nodes"][2]["sourceRunNodeId"] = "r"
        self.error(state, "MULTIPLE_PRODUCERS")
        del state["nodes"][2]["sourceRunNodeId"]
        del state["nodes"][2]["processOutputName"]
        self.error(state, "MISSING_BRANCH_NAME")

    def test_disconnected_and_wrong_prompt_pair(self):
        state = simple()
        state["nodes"].append(dataset("unused"))
        self.error(state, "DISCONNECTED_SELECTION")
        state = simple()
        state["nodes"].append(prompt("p2"))
        state["connections"].append(edge("p2", "r", "prompt-to-run"))
        self.error(state, "PROMPT_RUN_MISMATCH")

    def test_process_code_is_parsed_never_executed(self):
        state = branched()
        state["nodes"][1]["dfCode"] = "raise RuntimeError('MUST NOT EXECUTE')\ndef process(df):\n    return {'left': df, 'right': df}\n"
        self.valid(state)
        for code in ["# def process(df):\npass", "def process(df, required):\n    return df", "async def process(df):\n    return df", "def process(df): this is invalid python!"]:
            with self.subTest(code=code):
                state["nodes"][1]["dfCode"] = code
                self.error(state, "INVALID_PROCESS_FUNCTION")

    def test_unbound_process_alias_and_duplicate_alias(self):
        state = branched()
        state["nodes"][4]["dfCode"] = "def process(df):\n    return df_missing\n"
        self.error(state, "UNBOUND_DATASET_ALIAS")
        state["nodes"][4]["datasetAliases"] = {"right": "df"}
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

    def test_two_materializations_share_one_job_output_port(self):
        state = simple()
        state["nodes"] += [dataset("out-a", sourceRunNodeId="r"), dataset("out-b", sourceRunNodeId="r")]
        spec = self.valid(state)
        self.assertEqual(len(spec["jobs"]), 1)
        self.assertEqual(spec["jobs"][0]["outputs"], {"result": ["dataset:out-a", "dataset:out-b"]})

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
