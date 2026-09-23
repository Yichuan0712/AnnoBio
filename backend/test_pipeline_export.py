"""Focused regression tests for the standalone Python pipeline archive."""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import sys
import unittest
import uuid
import zipfile
from pathlib import Path

from backend.pipeline_export import PipelineExportError, build_pipeline_archive


def _canvas_state() -> dict:
    return {
        "version": 2,
        "nodes": [
            {
                "type": "dataset",
                "nodeId": "dataset-raw",
                "name": "Raw input",
                "datasetContent": {
                    "headers": ["text", "figure"],
                    "columnTypes": ["text", "image"],
                    "rows": [["private row that must not be exported", {"kind": "images", "assetIds": ["secret"]}]],
                },
            },
            {
                "type": "process",
                "nodeId": "process-clean",
                "name": "Clean rows",
                "activeMode": "row",
                "code": "def process(row):\n    row['text'] = str(row['text']).strip()\n    return row\n",
            },
            {
                "type": "dataset",
                "nodeId": "dataset-clean",
                "name": "Cleaned",
                "datasetContent": {
                    "headers": ["text", "figure"],
                    "columnTypes": ["text", "image"],
                    "rows": [],
                },
            },
            {
                "type": "prompt",
                "nodeId": "prompt-original",
                "name": "Original prompt",
                "sections": [{"name": "Task", "content": "Original content {text}"}],
                "inputTypes": {"text": "text"},
                "outputFormat": {
                    "returnShape": "single",
                    "fields": [{"key": "answer", "type": "str"}],
                },
            },
            {
                "type": "prompt",
                "nodeId": "prompt-duplicate",
                "name": "Edited duplicate",
                "sections": [{"name": "Task", "content": "Edited duplicate content {text}"}],
                "inputTypes": {"text": "text"},
                "outputFormat": {
                    "returnShape": "single",
                    "fields": [{"key": "answer", "type": "str", "description": "Final answer"}],
                },
            },
            {
                "type": "run",
                "nodeId": "run-duplicate",
                "runName": "Run A1",
                "runWorkingSetId": "dataset-clean",
                "runCredentialId": "credential-1",
                "runInputToColumn": json.dumps({"text": "text"}),
                "runResults": json.dumps([{"output": {"answer": "private cached result"}}]),
            },
        ],
        "connections": [
            {"fromId": "dataset-raw", "toId": "process-clean", "type": "dataset-to-process"},
            {"fromId": "process-clean", "toId": "dataset-clean", "type": "process-to-dataset"},
            {"fromId": "prompt-duplicate", "toId": "run-duplicate", "type": "prompt-to-run"},
        ],
    }


def _selected_route() -> list[dict]:
    return [
        {"type": "dataset", "dataset_node_id": "dataset-raw"},
        {"type": "process", "process_node_id": "process-clean"},
        {"type": "dataset", "dataset_node_id": "dataset-clean"},
        {"type": "prompt", "prompt_node_id": "prompt-duplicate", "run_node_id": "run-duplicate"},
    ]


class PipelineExportTests(unittest.TestCase):
    def build(self, state: dict | None = None) -> tuple[str, bytes]:
        return build_pipeline_archive(
            canvas_state=state or _canvas_state(),
            route=_selected_route(),
            name="Research Pipeline",
            credentials=[
                {
                    "id": "credential-1",
                    "provider": "openrouter",
                    "model": "openai/gpt-4.1-mini",
                    "base_url": "",
                    "api_key": "must-never-be-exported",
                }
            ],
            default_credential_id="",
            run_max_tokens=4096,
            run_concurrency=3,
            author_name='Ada "AJ" Lovelace',
            generated_at="2026-09-23T17:00:00Z",
        )

    def test_archive_is_code_only_deterministic_and_compilable(self):
        filename, archive = self.build()
        self.assertEqual(filename, "research-pipeline.zip")
        self.assertEqual(archive, self.build()[1])

        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            names = set(bundle.namelist())
            required = {
                "research-pipeline/main.py",
                "research-pipeline/pipeline.json",
                "research-pipeline/DATA.md",
                "research-pipeline/README.md",
                "research-pipeline/requirements.txt",
                "research-pipeline/.env.example",
                "research-pipeline/processor/__init__.py",
                "research-pipeline/prompt/__init__.py",
                "research-pipeline/engine/__init__.py",
                "research-pipeline/engine/base.py",
                "research-pipeline/engine/litellm_engine.py",
                "research-pipeline/engine/openrouter_engine.py",
            }
            self.assertTrue(required.issubset(names))
            self.assertFalse(any("/data/" in name for name in names))
            combined = b"\n".join(bundle.read(name) for name in names)
            self.assertNotIn(b"private row", combined)
            self.assertNotIn(b"private cached result", combined)
            self.assertNotIn(b"must-never-be-exported", combined)
            self.assertIn(b"Edited duplicate content", combined)
            self.assertNotIn(b"Original content", combined)
            self.assertIn(b'Ada "AJ" Lovelace', combined)
            self.assertIn(b"AnnoBio", combined)
            manifest = json.loads(bundle.read("research-pipeline/pipeline.json"))
            self.assertEqual(manifest["authors"]["workflow"], 'Ada "AJ" Lovelace')
            self.assertEqual(manifest["generated_at"], "2026-09-23T17:00:00Z")

            for name in names:
                if name.endswith(".py"):
                    compile(bundle.read(name), name, "exec")

            test_root = Path(__file__).parent / f".pipeline-export-test-{uuid.uuid4().hex}"
            project_root = test_root / "research-pipeline"
            try:
                for member in names:
                    target = test_root / Path(member)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(bundle.read(member))
                completed = subprocess.run(
                    [sys.executable, "main.py", "--help"],
                    cwd=project_root,
                    capture_output=True,
                    text=True,
                    timeout=20,
                    check=False,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertIn("--engine", completed.stdout)
                smoke_script = """
from pathlib import Path
import pandas as pd
from engine.base import BaseEngine, parse_structured_content
from prompt import prompt_01_edited_duplicate as prompt_step

class FakeEngine(BaseEngine):
    def complete(self, *, content, output_schema, model_config):
        assert "Edited duplicate content hello" in content
        return {"answer": "ok"}

result = prompt_step.run(
    pd.DataFrame([{"text": "hello", "figure": ""}]),
    FakeEngine(),
    input_root=Path.cwd(),
    concurrency=1,
)
assert result.to_dict(orient="records")[0]["Output: answer"] == "ok"
try:
    parse_structured_content({"wrong": "value"}, prompt_step.OUTPUT_SCHEMA)
except ValueError as exc:
    assert "unexpected fields" in str(exc)
else:
    raise AssertionError("Invalid structured output was accepted")
"""
                smoke = subprocess.run(
                    [sys.executable, "-c", smoke_script],
                    cwd=project_root,
                    capture_output=True,
                    text=True,
                    timeout=20,
                    check=False,
                )
                self.assertEqual(smoke.returncode, 0, smoke.stderr)
            finally:
                shutil.rmtree(test_root, ignore_errors=True)

    def test_same_name_input_mapping_is_inferred_for_legacy_runs(self):
        state = _canvas_state()
        run = next(node for node in state["nodes"] if node.get("nodeId") == "run-duplicate")
        run["runInputToColumn"] = "{}"
        filename, archive = self.build(state)
        self.assertEqual(filename, "research-pipeline.zip")
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            manifest = json.loads(bundle.read("research-pipeline/pipeline.json"))
        prompt_step = next(step for step in manifest["route"] if step["type"] == "prompt")
        self.assertEqual(prompt_step["input_mapping"], {"text": "text"})

    def test_unmapped_input_explains_how_to_fix_the_selected_run(self):
        state = _canvas_state()
        prompt = next(node for node in state["nodes"] if node.get("nodeId") == "prompt-duplicate")
        prompt["sections"] = [{"name": "Task", "content": "Answer {question}"}]
        run = next(node for node in state["nodes"] if node.get("nodeId") == "run-duplicate")
        run["runInputToColumn"] = "{}"
        with self.assertRaisesRegex(PipelineExportError, 'Open "Run A1" and map each input'):
            self.build(state)

    def test_implicit_mapping_does_not_guess_between_case_collisions(self):
        state = _canvas_state()
        dataset = next(node for node in state["nodes"] if node.get("nodeId") == "dataset-clean")
        dataset["datasetContent"]["headers"] = ["Question", "question"]
        dataset["datasetContent"]["columnTypes"] = ["text", "text"]
        prompt = next(node for node in state["nodes"] if node.get("nodeId") == "prompt-duplicate")
        prompt["sections"] = [{"name": "Task", "content": "Answer {QUESTION}"}]
        run = next(node for node in state["nodes"] if node.get("nodeId") == "run-duplicate")
        run["runInputToColumn"] = "{}"
        with self.assertRaisesRegex(PipelineExportError, 'Open "Run A1" and map each input'):
            self.build(state)

    def test_duplicate_dataset_columns_are_rejected(self):
        state = _canvas_state()
        dataset = next(node for node in state["nodes"] if node.get("nodeId") == "dataset-clean")
        dataset["datasetContent"]["headers"] = ["text", "text"]
        dataset["datasetContent"]["columnTypes"] = ["text", "text"]
        with self.assertRaisesRegex(PipelineExportError, "contains duplicate columns: text"):
            self.build(state)


if __name__ == "__main__":
    unittest.main()
