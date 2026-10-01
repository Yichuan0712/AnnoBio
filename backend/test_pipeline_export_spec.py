"""Compiler/export integration and generated-program execution, using fake models only."""
from copy import deepcopy
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

from backend.pipeline_compile import compile_pipeline
from backend.pipeline_export import build_pipeline_archive, PipelineExportError
from backend.pipeline_export_spec import export_compiled_pipeline
from backend.test_pipeline_compile import DEFAULTS, simple, branched, dataset, edge, process, route_for


class CompiledExportTests(unittest.TestCase):
    def build(self, state, **kwargs):
        return build_pipeline_archive(canvas_state=state, route=kwargs.pop("route", route_for(state)), name="Compiled", **kwargs)

    def files(self, archive):
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            return {p.removeprefix("compiled/"): bundle.read(p).decode("utf-8") for p in bundle.namelist()}

    def test_archive_embeds_compiler_plan_and_excludes_private_fields(self):
        state = simple()
        state["nodes"][-1]["runSettings"] = {"run_max_tokens": 1024, "run_max_retries": 0, "run_concurrency": 2}
        before = deepcopy(state)
        _, archive = self.build(state, credentials=[{"id": "PRIVATE_CREDENTIAL", "provider": "openrouter", "model": "test/model", "api_key": "SECRET_KEY"}])
        files = self.files(archive)
        manifest = json.loads(files["pipeline.json"])
        expected = compile_pipeline(canvas_state=state, route=route_for(state), run_defaults=DEFAULTS)["spec"]
        execution = manifest["execution"]
        self.assertEqual([j["id"] for j in execution["jobs"]], [j["id"] for j in expected["jobs"]])
        self.assertEqual(execution["artifacts"], expected["artifacts"])
        job = execution["jobs"][0]
        self.assertEqual(job["config"]["model"]["max_tokens"], 1024)
        self.assertEqual(job["config"]["model"]["max_retries"], 0)
        self.assertEqual(job["config"]["settings"]["run_concurrency"], 2)
        prompt_source = files[manifest["route"][1]["source"]]
        self.assertIn("DEFAULT_CONCURRENCY = 2", prompt_source)
        self.assertNotIn("model_binding", json.dumps(execution))
        combined = "\n".join(files.values())
        for value in ("PRIVATE_ROW", "PRIVATE_CREDENTIAL", "SECRET_KEY", "PRIVATE_RESULTS"):
            self.assertNotIn(value, combined)
        self.assertEqual(state, before)

    def test_renderer_needs_no_canvas_and_uses_frozen_spec(self):
        state = simple()
        compiled = compile_pipeline(canvas_state=state, route=route_for(state), run_defaults=DEFAULTS)["spec"]
        snapshot = deepcopy(compiled)
        state.clear()
        with patch("backend.pipeline_export_spec.compile_pipeline", side_effect=AssertionError("must not recompile")):
            _, archive = export_compiled_pipeline(spec=compiled, models={"llm:r": {
                "engine": "litellm", "provider": "test", "model": "fake", "base_url": "",
                "max_tokens": 8192, "max_retries": 2, "api_key": "EXCLUDE_THIS"}}, name="Compiled")
        self.assertEqual(compiled, snapshot)
        self.assertNotIn("EXCLUDE_THIS", "\n".join(self.files(archive).values()))

    def test_multi_input_is_an_export_capability_error(self):
        state = simple()
        state["nodes"] += [dataset("lookup"), process("join", "raw", datasetAliases={"lookup": "df_lookup"}), dataset("joined")]
        state["nodes"][2]["runWorkingSetId"] = "joined"
        state["connections"] += [edge("raw", "join", "dataset-to-process"), edge("lookup", "join", "dataset-to-process"), edge("join", "joined", "process-to-dataset")]
        self.assertIsNotNone(compile_pipeline(canvas_state=state, route=route_for(state), run_defaults=DEFAULTS)["spec"])
        with self.assertRaisesRegex(PipelineExportError, "compiled graph is valid.*multi-input"):
            self.build(state)

    def test_saved_input_boundary_and_cycles_remain_distinct(self):
        state = simple()
        state["nodes"][0]["sourceRunNodeId"] = "outside"
        self.build(state, input_dataset_ids=["raw"])
        with self.assertRaisesRegex(PipelineExportError, "outside the selection"):
            self.build(state, input_dataset_ids=[])
        state["nodes"][0]["sourceRunNodeId"] = "r"
        with self.assertRaisesRegex(PipelineExportError, "also produced"):
            self.build(state, input_dataset_ids=["raw"])

    def test_invalid_graph_never_enters_codegen(self):
        state = simple()
        state["nodes"][-1]["runInputToColumn"] = {"text": "gone"}
        with patch("backend.pipeline_export_spec.export_compiled_pipeline") as renderer:
            with self.assertRaisesRegex(PipelineExportError, "missing columns"):
                self.build(state)
            renderer.assert_not_called()

    def test_quotes_and_newlines_in_names_generate_valid_source(self):
        state = branched()
        state["nodes"][1]["name"] = 'Split "one"\nsecond line'
        state["nodes"][-2]["name"] = 'Prompt "two"\nsecond line'
        _, archive = self.build(state)
        for path, source in self.files(archive).items():
            if path.endswith(".py"):
                compile(source, path, "exec")

    def test_retry_setting_and_normalized_output_names_are_executable(self):
        state = simple()
        state["nodes"][1]["outputFormat"]["fields"] = [
            {"key": "drug-name", "type": "str"}, {"key": "drug name", "type": "str"}]
        state["nodes"][-1]["runSettings"] = {"run_max_retries": 1}
        files = self.files(self.build(state)[1])
        ns = {}
        exec(files["engine/base.py"], ns)
        prompt = next(s for s in json.loads(files["pipeline.json"])["route"] if s["type"] == "prompt")
        self.assertEqual([(f["key"], f["display"]) for f in prompt["output_schema"]["fields"]],
                         [("drug_name", "drug-name"), ("drug_name_1", "drug name")])
        import pandas as pd
        engine = Mock()
        engine.complete.side_effect = [RuntimeError("transient"), {"drug_name": "a", "drug_name_1": "b"}]
        result = ns["run_prompt_step"](pd.DataFrame([{"text": "hello"}]), engine, prompt_name="p", sections=prompt["sections"],
            input_mapping=prompt["input_mapping"], input_types=prompt["input_types"], output_schema=prompt["output_schema"],
            model_config=prompt["model"], input_root=Path.cwd(), concurrency=1)
        self.assertEqual(engine.complete.call_count, 2)
        self.assertEqual(result["Output: drug-name"].tolist(), ["a"])
        self.assertEqual(result["Output: drug name"].tolist(), ["b"])

    def test_generated_dag_executes_split_merge_llm_and_two_saved_outputs_once(self):
        state = branched()
        state["nodes"][1]["dfCode"] = "def process(df):\n    return {'left': df, 'right': df.rename(columns={'text': 'other'})}\n"
        state["nodes"][4]["dfCode"] = "def process(df):\n    out = df.copy()\n    out['text'] = out['text'] + ':' + df_right['other']\n    return out\n"
        state["nodes"] += [dataset("out-a", sourceRunNodeId="r"), dataset("out-b", sourceRunNodeId="r")]
        _, archive = self.build(state)
        with tempfile.TemporaryDirectory(prefix="annobio-compiled-") as folder:
            with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
                bundle.extractall(folder)
            root = Path(folder) / "compiled"
            # Execute the generated CLI entry function, with real pandas/Excel and fake LLM.
            script = '''
import sys
import pandas as pd
import main
calls = []
class FakeEngine:
    def complete(self, *, content, output_schema, model_config):
        calls.append(content)
        return {'answer': content}
main.create_engine = lambda *_: FakeEngine()
pd.DataFrame([{'text': 'a'}, {'text': 'b'}]).to_excel('input.xlsx', sheet_name='Input', index=False)
sys.argv = ['main.py', '--input', 'input.xlsx', '--output', 'output.xlsx', '--concurrency', '1']
assert main.main() == 0
tables = pd.read_excel('output.xlsx', sheet_name=None)
assert set(tables) == {'out-a', 'out-b'}, tables.keys()
assert calls == ['Read a:a', 'Read b:b'], calls
assert tables['out-a']['Output: answer'].tolist() == calls
assert tables['out-a'].equals(tables['out-b'])
'''
            result = subprocess.run([sys.executable, "-c", script], cwd=root, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
