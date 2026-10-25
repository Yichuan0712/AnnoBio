"""The structured-output mode a run finds for a model is kept on its credentials (main._store_mode_found_in_run)
and starts that model's runs there after a restart (main._seed_structured_modes). Nothing of it is shown."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import litellm  # noqa: E402

import llm  # noqa: E402
import llm_structured  # noqa: E402
import main  # noqa: E402  (needs backend/ on sys.path for its own sibling imports)
from run_output_schema import build_output_model  # noqa: E402


def reply(content=None, tool_arguments=None):
    calls = None
    if tool_arguments is not None:
        calls = [SimpleNamespace(function=SimpleNamespace(name=llm_structured.TOOL_NAME, arguments=tool_arguments))]
    message = SimpleNamespace(content=content, tool_calls=calls)
    return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason="stop")])


def completion_answering(*answers):
    answers = list(answers)

    def fake(**_request):
        answer = answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer

    return fake


class StoredModeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = Path(self.tmp.name) / "credentials.json"
        self.write([
            {"id": "a", "model": "deepseek-chat", "api_key": "k", "base_url": "", "provider": "deepseek"},
            {"id": "b", "model": "deepseek-chat", "api_key": "k2", "base_url": "", "provider": "deepseek"},
            {"id": "c", "model": "gpt-5", "api_key": "k", "base_url": "", "provider": "openai"},
        ])
        self.memory = llm_structured.ModeMemory(on_change=main._store_mode_found_in_run)
        self.patches = [
            mock.patch.object(main, "CREDENTIALS_FILE", self.file),
            mock.patch.object(llm, "structured_modes", self.memory),
            mock.patch.object(llm, "safe_print"),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.tmp.cleanup()

    def write(self, items):
        self.file.write_text(json.dumps(items), encoding="utf-8")

    def stored(self, credential_id):
        return next(c for c in json.loads(self.file.read_text(encoding="utf-8")) if c["id"] == credential_id)

    def with_stored(self, index, found):
        items = json.loads(self.file.read_text(encoding="utf-8"))
        items[index]["structured_output"] = found
        self.write(items)

    def test_a_mode_a_run_finds_is_kept_on_every_credential_of_that_model(self):
        rejected = litellm.BadRequestError(message="response_format json_schema is unavailable", model="m", llm_provider="deepseek")
        model = build_output_model([{"key": "name", "type": "str"}])
        with mock.patch.object(llm, "completion", completion_answering(rejected, reply(tool_arguments='{"name": "H"}'))):
            llm.run_structured(provider="deepseek", model="deepseek-chat", api_key="k", base_url="https://api.deepseek.com",
                               prompt="Name it.", response_model=model)
        for credential_id in ("a", "b"):
            found = self.stored(credential_id)["structured_output"]
            self.assertEqual((found["mode"], found["model"]), ("tool", "deepseek-chat"))
            self.assertIn("litellm.BadRequestError", found["rejected"])
        self.assertNotIn("structured_output", self.stored("c"))

    def test_stored_modes_start_runs_there_after_a_restart(self):
        self.with_stored(2, {"mode": "json_object", "model": "gpt-5"})
        main._seed_structured_modes()
        self.assertEqual(self.memory.get(llm.structured_mode_key("openai", "gpt-5", "")), "json_object")

    def test_a_mode_found_for_an_older_model_is_ignored(self):
        self.with_stored(2, {"mode": "tool", "model": "gpt-4o"})
        main._seed_structured_modes()
        self.assertIsNone(self.memory.get(llm.structured_mode_key("openai", "gpt-5", "")))

    def test_a_mode_a_credential_already_has_does_not_rewrite_the_file(self):
        self.with_stored(2, {"mode": "json_schema", "model": "gpt-5"})
        with mock.patch.object(main, "_update_credentials") as update:
            main._store_mode_found_in_run(llm.structured_mode_key("openai", "gpt-5", ""), "json_schema", "")
            main._store_mode_found_in_run(llm.structured_mode_key("openai", "other-model", ""), "tool", "")
        update.assert_not_called()

    def test_the_mode_is_not_listed_with_the_credentials(self):
        self.with_stored(2, {"mode": "tool", "model": "gpt-5"})
        listed = next(c for c in main.list_credentials() if c.id == "c")
        self.assertNotIn("structured", json.dumps(listed.model_dump()))


if __name__ == "__main__":
    unittest.main()
