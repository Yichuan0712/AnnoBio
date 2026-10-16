"""A model's own settings (Settings → Run / Optimize / Agent, for the model chosen on the tab).

A model's value replaces the shared one of the same name; a per-node settings_override still wins.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parent))

import main  # noqa: E402
from model_settings import clean_model_settings, settings_for_model, validate_model_settings  # noqa: E402
from pipeline_runner import _apply_model_settings  # noqa: E402


class ModelSettingsRulesTest(unittest.TestCase):
    def test_validate_drops_blank_values_and_empty_models(self):
        self.assertEqual(
            validate_model_settings({"a": {"run_max_tokens": 1024, "run_concurrency": None}, "b": {}}),
            {"a": {"run_max_tokens": 1024}},
        )

    def test_validate_rejects_shared_only_keys_and_out_of_range(self):
        with self.assertRaises(ValueError):
            validate_model_settings({"a": {"run_max_retries": 1}})
        with self.assertRaises(ValueError):
            validate_model_settings({"a": {"run_concurrency": 11}})

    def test_clean_drops_what_is_invalid(self):
        self.assertEqual(
            clean_model_settings({"a": {"run_max_tokens": 1024, "run_concurrency": 99, "debug_mode": True}, "b": "x"}),
            {"a": {"run_max_tokens": 1024}},
        )
        self.assertEqual(clean_model_settings(None), {})

    def test_model_value_replaces_shared_value(self):
        settings = {"run_max_tokens": 8192, "run_concurrency": 4, "model_settings": {"a": {"run_max_tokens": 2048}}}
        self.assertEqual(settings_for_model(settings, "a")["run_max_tokens"], 2048)
        self.assertEqual(settings_for_model(settings, "a")["run_concurrency"], 4)
        self.assertEqual(settings_for_model(settings, "b")["run_max_tokens"], 8192)

    def test_settings_patch_validates_model_settings(self):
        self.assertEqual(main.SettingsPatch(model_settings={"a": {"review_max_tokens": 4096}}).model_settings,
                         {"a": {"review_max_tokens": 4096}})
        with self.assertRaises(ValidationError):
            main.SettingsPatch(model_settings={"a": {"review_max_tokens": 1}})


class ModelSettingsStorageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        patcher = mock.patch.object(main, "SETTINGS_FILE", Path(self.tmp.name) / "settings.json")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_patch_saves_and_replaces_every_model(self):
        main.patch_settings(main.SettingsPatch(model_settings={"a": {"run_max_tokens": 1024}, "b": {"run_concurrency": 2}}))
        self.assertEqual(main._load_settings()["model_settings"], {"a": {"run_max_tokens": 1024}, "b": {"run_concurrency": 2}})
        main.patch_settings(main.SettingsPatch(model_settings={"a": {"run_max_tokens": 1024}}))
        self.assertEqual(main._load_settings()["model_settings"], {"a": {"run_max_tokens": 1024}})
        # A patch without model_settings leaves them alone.
        main.patch_settings(main.SettingsPatch(run_max_tokens=4096))
        self.assertEqual(main._load_settings()["model_settings"], {"a": {"run_max_tokens": 1024}})

    def test_deleting_a_credential_deletes_its_settings(self):
        main.patch_settings(main.SettingsPatch(model_settings={"a": {"run_max_tokens": 1024}, "b": {"run_concurrency": 2}}))
        with mock.patch.object(main, "_update_credentials", return_value=True):
            main.delete_credential("a")
        self.assertEqual(main._load_settings()["model_settings"], {"b": {"run_concurrency": 2}})

    def test_deleting_a_credential_clears_the_tabs_that_chose_it(self):
        main.patch_settings(main.SettingsPatch(default_run_credential_id="a", default_review_credential_id="b"))
        with mock.patch.object(main, "_update_credentials", return_value=True):
            main.delete_credential("a")
        settings = main._load_settings()
        self.assertEqual((settings["default_run_credential_id"], settings["default_review_credential_id"]), ("", "b"))

    def test_a_model_can_choose_auto_context(self):
        main.patch_settings(main.SettingsPatch(agent_context_tokens=50000, model_settings={"a": {"agent_context_tokens": 0}}))
        with mock.patch.object(main, "_load_credentials", return_value=[]):
            self.assertEqual(main.agent_context("a")["source"], "fallback")

    def test_agent_context_uses_the_models_own_window(self):
        main.patch_settings(main.SettingsPatch(agent_context_tokens=50000, model_settings={"a": {"agent_context_tokens": 120000}}))
        with mock.patch.object(main, "_load_credentials", return_value=[]):
            self.assertEqual(main.agent_context("a")["context_tokens"], 120000)
            self.assertEqual(main.agent_context("b")["context_tokens"], 50000)


class PipelineModelSettingsTest(unittest.TestCase):
    def _job(self):
        return {"config": {"settings": {"run_max_tokens": 8192, "run_concurrency": 4, "run_max_retries": 2}}}

    def test_models_values_replace_compiled_shared_values(self):
        job = self._job()
        settings = {"model_settings": {"a": {"run_max_tokens": 2048, "run_concurrency": 8}}}
        _apply_model_settings(job, settings, "a", None)
        self.assertEqual(job["config"]["settings"], {"run_max_tokens": 2048, "run_concurrency": 8, "run_max_retries": 2})

    def test_node_settings_still_win(self):
        job = self._job()
        settings = {"model_settings": {"a": {"run_max_tokens": 2048, "run_concurrency": 8}}}
        _apply_model_settings(job, settings, "a", json.dumps({"run_max_tokens": 1000}))
        self.assertEqual(job["config"]["settings"]["run_max_tokens"], 8192)
        self.assertEqual(job["config"]["settings"]["run_concurrency"], 8)


if __name__ == "__main__":
    unittest.main()
