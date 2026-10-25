"""Generation parameters a Generate sends (model_params.py): which a model takes (found offline through
LiteLLM, or OpenRouter's catalog), how they are stored per model, how both run paths send them, and a
parameter the provider rejects being left out from then on."""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import litellm  # noqa: E402

import llm  # noqa: E402
import llm_structured  # noqa: E402
import main  # noqa: E402  (needs backend/ on sys.path for its own sibling imports)
import pipeline_runner  # noqa: E402
from model_params import clean_run_params, param_fields, validate_run_params  # noqa: E402
from model_settings import clean_model_settings, settings_for_model, validate_model_settings  # noqa: E402
from pipeline_runtime_adapters import execute_llm_job  # noqa: E402
from run_output_schema import build_output_model  # noqa: E402


def reply(content):
    message = SimpleNamespace(content=content, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason="stop")])


class ValidationTest(unittest.TestCase):
    def test_known_parameters_in_range_are_kept(self):
        self.assertEqual(validate_run_params({"temperature": 0.2, "seed": 7.0, "reasoning_effort": "high", "top_p": None}),
                         {"temperature": 0.2, "seed": 7, "reasoning_effort": "high"})

    def test_unknown_names_bad_values_and_ranges_are_refused(self):
        for value in ({"stop": ["}"]}, {"temperature": 3}, {"temperature": True}, {"seed": 1.5},
                      {"reasoning_effort": "max"}, {"top_k": "40"}, []):
            with self.assertRaises(ValueError, msg=str(value)):
                validate_run_params(value)

    def test_reading_the_settings_file_drops_what_is_invalid(self):
        self.assertEqual(clean_run_params({"temperature": 9, "top_p": 0.5, "stop": "x"}), {"top_p": 0.5})

    def test_fields_follow_the_spec_order_and_hide_the_probe_value(self):
        fields = param_fields(["reasoning_effort", "temperature"])
        self.assertEqual([f["name"] for f in fields], ["temperature", "reasoning_effort"])
        self.assertNotIn("probe", fields[0])
        self.assertEqual(fields[1]["choices"], ["low", "medium", "high"])


class StoredPerModelTest(unittest.TestCase):
    def test_params_are_stored_with_a_model_and_never_shared(self):
        stored = validate_model_settings({"a": {"run_max_tokens": 2048, "run_params": {"temperature": 0.3}}, "b": {"run_params": {}}})
        self.assertEqual(stored, {"a": {"run_max_tokens": 2048, "run_params": {"temperature": 0.3}}})
        settings = {"run_max_tokens": 8192, "model_settings": stored}
        self.assertEqual(settings_for_model(settings, "a")["run_params"], {"temperature": 0.3})
        self.assertEqual(settings_for_model(settings, "b")["run_params"], {})
        with self.assertRaises(ValueError):
            validate_model_settings({"a": {"run_params": {"temperature": 5}}})
        self.assertEqual(clean_model_settings({"a": {"run_params": {"temperature": 5, "seed": 3}}}), {"a": {"run_params": {"seed": 3}}})


class SupportedParamsTest(unittest.TestCase):
    """Uses LiteLLM's own model knowledge (mock_response, no network); pinned in requirements.txt."""

    def test_litellm_knowledge_narrows_the_provider_list_per_model(self):
        gpt5 = llm.supported_run_params("openai", "gpt-5", "")
        self.assertNotIn("temperature", gpt5)  # only temperature=1
        self.assertNotIn("top_p", gpt5)
        self.assertIn("reasoning_effort", gpt5)
        self.assertNotIn("reasoning_effort", llm.supported_run_params("openai", "gpt-4o-mini", ""))
        self.assertNotIn("seed", llm.supported_run_params("anthropic", "claude-sonnet-4-5", ""))

    def test_parameters_deepseek_ignores_are_not_offered(self):
        self.assertEqual(llm.supported_run_params("deepseek", "deepseek-reasoner", "https://api.deepseek.com"), ["seed"])
        self.assertNotIn("reasoning_effort", llm.supported_run_params("deepseek", "deepseek-chat", "https://api.deepseek.com"))

    def test_openrouter_models_use_the_catalog(self):
        names = llm.supported_run_params("openrouter", "deepseek/deepseek-chat", "",
                                         openrouter_parameters=["temperature", "top_k", "min_p", "tools", "stop", "logit_bias"])
        self.assertEqual(names, ["temperature", "top_k", "min_p"])
        self.assertEqual(llm.supported_run_params("openrouter", "x/y", "", openrouter_parameters=None), [])

    def test_a_custom_endpoint_offers_nothing(self):
        self.assertEqual(llm.supported_run_params("openai", "qwen", "http://localhost:8000/v1", custom_endpoint=True), [])


class EndpointTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = Path(self.tmp.name) / "credentials.json"
        self.file.write_text(json.dumps([
            {"id": "or", "model": "deepseek/deepseek-chat", "api_key": "k", "base_url": "https://openrouter.ai/api/v1", "provider": "openrouter"},
            {"id": "local", "model": "qwen", "api_key": "k", "base_url": "http://localhost:8000/v1", "provider": "openai"},
        ]), encoding="utf-8")
        patch = mock.patch.object(main, "CREDENTIALS_FILE", self.file)
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_openrouter_models_are_looked_up_in_the_catalog_even_with_a_base_url(self):
        catalog = [{"id": "deepseek/deepseek-chat", "parameters": ["temperature", "seed", "tools"]}]
        with mock.patch("oauth_openrouter.get_catalog", return_value=catalog):
            names = [f["name"] for f in main.credential_run_params("or")["params"]]
        self.assertEqual(names, ["temperature", "seed"])

    def test_a_custom_endpoint_lists_no_parameters(self):
        self.assertEqual(main.credential_run_params("local"), {"params": []})


class SendingTest(unittest.TestCase):
    def setUp(self):
        patches = [
            mock.patch.object(llm, "structured_modes", llm_structured.ModeMemory()),
            mock.patch.object(llm, "_rejected_params", {}),
            mock.patch.object(llm, "safe_print"),
            mock.patch.object(llm.time, "sleep"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.model = build_output_model([{"key": "name", "type": "str"}])

    def call(self, answers, params):
        calls = []

        def fake(**request):
            calls.append(request)
            answer = answers.pop(0)
            if isinstance(answer, BaseException):
                raise answer
            return answer

        with mock.patch.object(llm, "completion", side_effect=fake):
            out = llm.run_structured(provider="openai", model="gpt-x", api_key="k", base_url="", prompt="Name it.",
                                     response_model=self.model, params=params)
        return out, calls

    def test_params_reach_every_call(self):
        _, calls = self.call([reply('{"name": "H"}')], {"temperature": 0.2, "seed": 3})
        self.assertEqual((calls[0]["temperature"], calls[0]["seed"]), (0.2, 3))

    def test_a_rejected_parameter_is_left_out_from_then_on_without_lowering_the_mode(self):
        rejected = litellm.BadRequestError(message="Unsupported value: 'temperature' does not support 0.2 with this model.",
                                           model="gpt-x", llm_provider="openai")
        (out, used_fallback), calls = self.call([rejected, reply('{"name": "H"}')], {"temperature": 0.2, "seed": 3})
        self.assertEqual(out, {"name": "H"})
        self.assertFalse(used_fallback)
        self.assertNotIn("temperature", calls[1])
        self.assertEqual(calls[1]["seed"], 3)
        self.assertEqual(calls[1]["response_format"]["type"], "json_schema")
        _, calls = self.call([reply('{"name": "H"}')], {"temperature": 0.2})
        self.assertNotIn("temperature", calls[0])

    def test_an_error_that_names_no_sent_parameter_is_raised(self):
        error = litellm.BadRequestError(message="Invalid prompt", model="gpt-x", llm_provider="openai")
        with self.assertRaises(litellm.BadRequestError):
            self.call([error], {"seed": 3})


class RunPathsTest(unittest.TestCase):
    def test_a_pipeline_job_gets_the_models_params_and_sends_them(self):
        job = {"config": {"settings": {"run_max_tokens": 1024}}}
        settings = {"model_settings": {"cred": {"run_params": {"top_p": 0.5}}}}
        pipeline_runner._apply_model_settings(job, settings, "cred", {})
        self.assertEqual(job["config"]["settings"]["run_params"], {"top_p": 0.5})

        seen = {}

        def invoke(**kwargs):
            seen.update(kwargs)
            return {"name": "H"}, False, {}

        job = {"config": {"prompt": "Name {x}.", "input_mapping": {"x": "x"},
                          "output_schema": {"return_shape": "single", "fields": [{"key": "name", "type": "str"}]},
                          "settings": {"run_params": {"top_p": 0.5}}}}
        table = {"headers": ["x"], "rows": [["a"]]}
        credential = {"provider": "openai", "model": "gpt-x", "api_key": "k", "base_url": ""}
        execute_llm_job(job, table, credential, None, threading.Event(), invoke=invoke)
        self.assertEqual(seen["params"], {"top_p": 0.5})

    def test_a_pipeline_job_without_params_calls_as_before(self):
        def invoke(provider, model, api_key, base_url, prompt, response_model, max_tokens, return_shape, return_debug):
            return {"name": "H"}, False, {}

        job = {"config": {"prompt": "Name {x}.", "input_mapping": {"x": "x"},
                          "output_schema": {"return_shape": "single", "fields": [{"key": "name", "type": "str"}]},
                          "settings": {}}}
        out = execute_llm_job(job, {"headers": ["x"], "rows": [["a"]]},
                              {"provider": "openai", "model": "gpt-x", "api_key": "k", "base_url": ""}, None,
                              threading.Event(), invoke=invoke)
        self.assertEqual(out["errors"], [])


if __name__ == "__main__":
    unittest.main()
