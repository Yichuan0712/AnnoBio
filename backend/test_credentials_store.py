"""Concurrent credential changes must not erase each other (main._update_credentials).

Opening Settings tests the OpenRouter credential while a model is checked for tool calling; both
used to write back the whole list they read before their slow model call, so whichever finished
last erased the other's result.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import main  # noqa: E402  (needs backend/ on sys.path for its own sibling imports)


def _slow_probe(**_kwargs):
    time.sleep(0.3)
    return {"ok": True, "detail": "The model called the test tool."}


async def _slow_verify(**kwargs):
    await asyncio.sleep(0.3)
    return {"ok": True, "error": "", "provider": kwargs["current_provider"]}


class ConcurrentCredentialChangesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = Path(self.tmp.name) / "credentials.json"
        self.file.write_text(json.dumps([
            {"id": "a", "model": "gpt-5", "api_key": "k", "base_url": "", "provider": "openai"},
            {"id": "b", "model": "openrouter/auto", "api_key": "k", "base_url": "", "provider": "openrouter"},
            {"id": "c", "model": "gpt-5-nano", "api_key": "k", "base_url": "", "provider": "openai"},
        ]), encoding="utf-8")
        self.patches = [
            mock.patch.object(main, "CREDENTIALS_FILE", self.file),
            mock.patch.object(main, "llm_probe_tool_calling", _slow_probe),
            mock.patch.object(main, "verify_credential", _slow_verify),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.tmp.cleanup()

    def test_overlapping_check_test_and_delete_all_persist(self):
        threads = [
            threading.Thread(target=main.agent_check_credential, args=("a",)),
            threading.Thread(target=lambda: asyncio.run(main.test_credential("b"))),
            threading.Thread(target=lambda: (time.sleep(0.1), main.delete_credential("c"))),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        saved = {item["id"]: item for item in json.loads(self.file.read_text(encoding="utf-8"))}
        self.assertEqual(set(saved), {"a", "b"})
        self.assertTrue(saved["a"]["agent_check"]["ok"])
        self.assertTrue(saved["b"]["last_check_ok"])

    def test_update_of_a_removed_credential_reports_it(self):
        main.delete_credential("c")
        self.assertFalse(main._update_credential("c", {"last_check_ok": True}))


if __name__ == "__main__":
    unittest.main()
