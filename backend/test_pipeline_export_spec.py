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
from backend.test_pipeline_compile import DEFAULTS, simple, branched, data, dataset, edge, process, route_for


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

    def test_image_input_exports_with_the_mapped_columns_type(self):
        # The canvas has no Prompt input types: an input mapped to an image column sends images.
        state = simple()
        state["nodes"][0]["datasetContent"]["columnTypes"] = ["image"]
        files = self.files(self.build(state)[1])
        module = next(text for path, text in files.items() if "INPUT_TYPES" in text)
        self.assertIn("INPUT_TYPES = {'text': 'image'}", module)

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

    def test_exported_model_settings_are_placeholders_for_linear_and_branched_routes(self):
        credentials = [{"id": "PRIVATE_CREDENTIAL", "provider": "google",
                        "model": "gemini-2.5-flash", "api_key": "PRIVATE_KEY",
                        "base_url": "https://private-api.example.test"}]
        for state in (simple(), branched()):
            with self.subTest(nodes=len(state["nodes"])):
                files = self.files(self.build(state, credentials=credentials)[1])
                manifest = json.loads(files["pipeline.json"])
                self.assertEqual(manifest["default_engine"], "litellm")
                steps = manifest.get("route", manifest.get("graph", {}).get("steps", []))
                for step in steps:
                    if step["type"] != "prompt":
                        continue
                    self.assertEqual(step["model"]["model"], "YOUR_PROVIDER/YOUR_MODEL")
                    self.assertEqual(step["model"]["provider"], "")
                    self.assertEqual(step["model"]["base_url"], "")
                    self.assertIn("YOUR_PROVIDER/YOUR_MODEL", files[step["source"]])
                for job in manifest["execution"]["jobs"]:
                    if job["type"] == "llm":
                        self.assertEqual(job["config"]["model"]["model"], "YOUR_PROVIDER/YOUR_MODEL")
                self.assertIn("ANNOBIO_MODEL=YOUR_PROVIDER/YOUR_MODEL", files[".env.example"])
                self.assertIn("replace `YOUR_PROVIDER/YOUR_MODEL`", files["README.md"])
                combined = "\n".join(files.values())
                for value in ("gemini-2.5-flash", "https://private-api.example.test", "PRIVATE_KEY", "PRIVATE_CREDENTIAL"):
                    self.assertNotIn(value, combined)

    def test_multi_input_export_accepts_named_workbooks(self):
        state = {"nodes": [dataset("raw", ["text"]), dataset("lookup", ["suffix"]),
                           process("join",
                                   dfCode="def process(df):\n    out = df.copy()\n    out['text'] = out['text'] + df_lookup['suffix']\n    return out\n")],
                 "connections": [data("raw", "join", "df"), data("lookup", "join", "df_lookup")]}
        state["nodes"][1]["datasetContent"]["headers"] = ["suffix", "image"]
        state["nodes"][1]["datasetContent"]["columnTypes"] = ["text", "image"]
        route = route_for(state)
        self.assertIsNotNone(compile_pipeline(canvas_state=state, route=route,
                                              input_dataset_ids=["raw", "lookup"], run_defaults=DEFAULTS)["spec"])
        _, archive = self.build(state, route=route, input_dataset_ids=["raw", "lookup"])
        files = self.files(archive)
        manifest = json.loads(files["pipeline.json"])
        self.assertEqual({item["id"] for item in manifest["inputs"]}, {"raw", "lookup"})
        self.assertIn("--input raw=/path/to/raw.xlsx", files["DATA.md"])
        self.assertIn("--input lookup=/path/to/lookup.xlsx", files["DATA.md"])
        with tempfile.TemporaryDirectory(prefix="annobio-multi-input-") as folder:
            with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
                bundle.extractall(folder)
            script = '''
import sys
import pandas as pd
import main
pd.DataFrame({'text': ['a']}).to_excel('raw.xlsx', sheet_name='Input', index=False)
pd.DataFrame({'suffix': ['x'], 'image': ['files/p.png']}).to_excel('lookup.xlsx', sheet_name='Input', index=False)
assert main.load_input(__import__('pathlib').Path('lookup.xlsx').resolve(), 'Input', ['suffix', 'image'], ['image'])['image'][0] == str(__import__('pathlib').Path('files/p.png').resolve())
sys.argv = ['main.py', '--input', 'raw=raw.xlsx', '--input', 'lookup=lookup.xlsx', '--output', 'out.xlsx']
assert main.main() == 0
assert pd.read_excel('out.xlsx')['text'].tolist() == ['ax']
'''
            result = subprocess.run([sys.executable, "-c", script], cwd=Path(folder) / "compiled",
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_unselected_upstream_and_cycles_never_export(self):
        state = branched()
        with self.assertRaisesRegex(PipelineExportError, 'output of "split", which is not in this Pipeline'):
            self.build(state, route=[item for item in route_for(state) if item.get("process_node_id") != "split"])
        cycle = {"nodes": [dataset("raw"), process("a"), process("b")],
                 "connections": [data("raw", "a", "df"), data("b", "a", "df_b"), data("a", "b", "df")]}
        with self.assertRaisesRegex(PipelineExportError, "dependency cycle"):
            self.build(cycle)

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
        result = ns["run_prompt_step"](pd.DataFrame([{"text": "hello"}]), engine, prompt_name="p", prompt=prompt["prompt"],
            input_mapping=prompt["input_mapping"], input_types=prompt["input_types"], output_schema=prompt["output_schema"],
            model_config=prompt["model"], input_root=Path.cwd(), concurrency=1)
        self.assertEqual(engine.complete.call_count, 2)
        self.assertEqual(result["Output: drug-name"].tolist(), ["a"])
        self.assertEqual(result["Output: drug name"].tolist(), ["b"])

    def test_generated_dag_executes_split_merge_and_llm_once(self):
        state = branched()
        state["nodes"][1]["dfCode"] = "def process(df):\n    return {'left': df, 'right': df.rename(columns={'text': 'other'})}\n"
        state["nodes"][2]["dfCode"] = "def process(df):\n    out = df.copy()\n    out['text'] = out['text'] + ':' + df_right['other']\n    return out\n"
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
# The Run's output is named after its Prompt.
assert set(tables) == {'p'}, tables.keys()
assert calls == ['Read a:a', 'Read b:b'], calls
assert tables['p']['Output: answer'].tolist() == calls
'''
            result = subprocess.run([sys.executable, "-c", script], cwd=root, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def run_exported(self, archive, script):
        with tempfile.TemporaryDirectory(prefix="annobio-process-only-") as folder:
            with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
                bundle.extractall(folder)
            result = subprocess.run([sys.executable, "-c", script], cwd=Path(folder) / "compiled",
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_process_only_route_exports_without_llm_engine(self):
        state = {"nodes": [dataset("raw"), process("clean", dfCode="def process(df):\n    out = df.copy()\n    out['text'] = out['text'].str.upper()\n    return out\n")],
                 "connections": [data("raw", "clean", "df")]}
        files = self.files(self.build(state)[1])
        self.assertFalse(any(path.startswith(("engine/", "prompt/")) for path in files))
        self.assertNotIn(".env.example", files)
        self.assertNotIn("litellm", files["requirements.txt"])
        self.assertNotIn("engine", files["main.py"].split("def main", 1)[1])
        manifest = json.loads(files["pipeline.json"])
        self.assertEqual((manifest["engines"], manifest["default_engine"]), ([], None))
        self.run_exported(self.build(state)[1], '''
import sys
import pandas as pd
import main
pd.DataFrame([{'text': 'a'}, {'text': 'b'}]).to_excel('input.xlsx', sheet_name='Input', index=False)
sys.argv = ['main.py', '--input', 'input.xlsx', '--output', 'output.xlsx']
assert main.main() == 0
assert pd.read_excel('output.xlsx')['text'].tolist() == ['A', 'B']
''')

    def test_process_only_branched_route_executes(self):
        state = branched()
        state["nodes"] = [n for n in state["nodes"] if n["type"] not in {"prompt", "run"}]
        state["connections"] = [e for e in state["connections"] if e["toId"] != "r"]
        state["nodes"][1]["dfCode"] = "def process(df):\n    return {'left': df, 'right': df.rename(columns={'text': 'other'})}\n"
        state["nodes"][2]["dfCode"] = "def process(df):\n    out = df.copy()\n    out['text'] = out['text'] + ':' + df_right['other']\n    return out\n"
        _, archive = self.build(state)
        self.assertNotIn("engine/__init__.py", self.files(archive))
        self.run_exported(archive, '''
import sys
import pandas as pd
import main
pd.DataFrame([{'text': 'a'}]).to_excel('input.xlsx', sheet_name='Input', index=False)
sys.argv = ['main.py', '--input', 'input.xlsx', '--output', 'output.xlsx']
assert main.main() == 0
assert pd.read_excel('output.xlsx', sheet_name=None)['merge']['text'].tolist() == ['a:a']
''')


if __name__ == "__main__":
    unittest.main()
