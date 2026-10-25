"""Checking which structured-output mode a model accepts (llm.probe_structured_output), storing it on
the credential (POST /api/credentials/{id}/structured-check), starting runs there, and storing the
mode a run found when it differs."""

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

ROWS = '{"rows": [{"element": "Hydrogen", "atomic_number": 1, "note": null, "isotopes": ["H-1", "H-2"]}]}'


def reply(content=None, tool_arguments=None):
    calls = None
    if tool_arguments is not None:
        calls = [SimpleNamespace(function=SimpleNamespace(name=llm_structured.TOOL_NAME, arguments=tool_arguments))]
    message = SimpleNamespace(content=content, tool_calls=calls)
    return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason="stop")])


def completion_answering(*answers):
    answers = list(answers)
    requests = []

    def fake(**request):
        requests.append(request)
        answer = answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer

    fake.requests = requests
    return fake


def probe(fake):
    with mock.patch.object(llm, "completion", fake), mock.patch.object(llm.time, "sleep"):
        return llm.probe_structured_output(provider="openai", model="gpt-x", api_key="k", base_url="")


class ProbeTest(unittest.TestCase):
    def test_the_first_mode_that_works_is_reported(self):
        result = probe(completion_answering(reply(ROWS)))
        self.assertEqual((result["ok"], result["mode"]), (True, "json_schema"))
        self.assertIn("natively", result["detail"])

    def test_an_endpoint_that_ignores_the_schema_is_found(self):
        fake = completion_answering(reply("Hydrogen and helium."), reply("Hydrogen, helium."), reply(tool_arguments=ROWS))
        result = probe(fake)
        self.assertEqual((result["ok"], result["mode"]), (True, "tool"))
        self.assertEqual([t["mode"] for t in result["tried"]], ["json_schema"])
        self.assertIn("Rejected: json_schema", result["detail"])

    def test_a_model_that_fails_every_mode_is_reported_as_such(self):
        fake = completion_answering(*[reply("no") for _ in range(8)])
        result = probe(fake)
        self.assertEqual((result["ok"], result["mode"]), (False, None))
        self.assertIn("any of the four ways", result["detail"])

    def test_a_check_that_cannot_reach_the_model_says_nothing_about_it(self):
        error = litellm.AuthenticationError(message="Invalid API key", llm_provider="openai", model="gpt-x")
        result = probe(completion_answering(error))
        self.assertIsNone(result["ok"])
        self.assertIn("could not reach", result["detail"])


class StoredCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = Path(self.tmp.name) / "credentials.json"
        self.file.write_text(json.dumps([
            {"id": "a", "model": "deepseek-chat", "api_key": "k", "base_url": "", "provider": "deepseek"},
            {"id": "b", "model": "deepseek-chat", "api_key": "k2", "base_url": "", "provider": "deepseek"},
            {"id": "c", "model": "gpt-5", "api_key": "k", "base_url": "", "provider": "openai"},
        ]), encoding="utf-8")
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

    def stored(self, credential_id):
        return next(c for c in json.loads(self.file.read_text(encoding="utf-8")) if c["id"] == credential_id)

    def listed(self, credential_id):
        return next(c for c in main.list_credentials() if c.id == credential_id)

    def test_a_check_is_stored_listed_and_starts_runs_there(self):
        result = {"ok": True, "mode": "tool", "detail": "via a tool call", "tried": []}
        with mock.patch.object(main, "llm_probe_structured_output", return_value=result):
            main.structured_check_credential("a")
        self.assertEqual(self.stored("a")["structured_check"]["mode"], "tool")
        listed = self.listed("a")
        self.assertEqual((listed.structured_check_ok, listed.structured_mode), (True, "tool"))
        self.assertEqual(self.memory.get(llm.structured_mode_key("deepseek", "deepseek-chat", "")), "tool")

    def test_a_check_that_could_not_run_changes_nothing(self):
        result = {"ok": None, "mode": None, "detail": "could not reach", "tried": []}
        with mock.patch.object(main, "llm_probe_structured_output", return_value=result):
            main.structured_check_credential("a")
        self.assertNotIn("structured_check", self.stored("a"))
        self.assertIsNone(self.memory.get(llm.structured_mode_key("deepseek", "deepseek-chat", "")))

    def test_a_check_for_an_older_model_is_not_shown(self):
        items = json.loads(self.file.read_text(encoding="utf-8"))
        items[2]["structured_check"] = {"ok": True, "mode": "tool", "model": "gpt-4o", "detail": ""}
        self.file.write_text(json.dumps(items), encoding="utf-8")
        self.assertIsNone(self.listed("c").structured_mode)
        main._seed_structured_modes()
        self.assertIsNone(self.memory.get(llm.structured_mode_key("openai", "gpt-5", "")))

    def test_stored_checks_seed_the_modes_at_startup(self):
        items = json.loads(self.file.read_text(encoding="utf-8"))
        items[2]["structured_check"] = {"ok": True, "mode": "json_object", "model": "gpt-5", "detail": ""}
        self.file.write_text(json.dumps(items), encoding="utf-8")
        main._seed_structured_modes()
        self.assertEqual(self.memory.get(llm.structured_mode_key("openai", "gpt-5", "")), "json_object")

    def test_a_mode_lowered_during_a_run_is_stored_on_every_credential_of_that_model(self):
        rejected = litellm.BadRequestError(message="response_format json_schema is unavailable", model="m", llm_provider="deepseek")
        fake = completion_answering(rejected, reply(tool_arguments='{"name": "H"}'))
        model = build_output_model([{"key": "name", "type": "str"}])
        with mock.patch.object(llm, "completion", fake):
            llm.run_structured(provider="deepseek", model="deepseek-chat", api_key="k", base_url="https://api.deepseek.com",
                               prompt="Name it.", response_model=model)
        for credential_id in ("a", "b"):
            check = self.stored(credential_id)["structured_check"]
            self.assertEqual((check["ok"], check["mode"]), (True, "tool"))
            self.assertIn("Found during a run; rejected: litellm.BadRequestError", check["detail"])
        self.assertNotIn("structured_check", self.stored("c"))


if __name__ == "__main__":
    unittest.main()
