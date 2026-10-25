"""llm.run_structured on top of llm_structured.py: what reaches LiteLLM per provider, the modes it
remembers per model, and errors that must not be mistaken for a missing feature."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import litellm  # noqa: E402

import llm  # noqa: E402
import llm_structured  # noqa: E402
from run_output_schema import build_output_model, build_table_output_model  # noqa: E402

ROW_MODEL = build_output_model([{"key": "name", "type": "str"}, {"key": "score", "type": "float", "allow_none": True}])
TABLE_MODEL = build_table_output_model(ROW_MODEL)


def reply(content=None, tool_arguments=None, finish_reason="stop"):
    calls = None
    if tool_arguments is not None:
        calls = [SimpleNamespace(function=SimpleNamespace(name=llm_structured.TOOL_NAME, arguments=tool_arguments))]
    message = SimpleNamespace(content=content, tool_calls=calls)
    return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason=finish_reason)])


def rejected(param="response_format"):
    return litellm.BadRequestError(message=f"{param} json_schema is not supported", model="m", llm_provider="deepseek")


class RunStructuredTest(unittest.TestCase):
    def setUp(self):
        self.memory = llm_structured.ModeMemory()
        patches = [
            mock.patch.object(llm, "structured_modes", self.memory),
            mock.patch.object(llm, "safe_print"),
            mock.patch.object(llm.time, "sleep"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def call(self, answers, **kwargs):
        calls = []

        def fake_completion(**request):
            calls.append(request)
            answer = answers.pop(0)
            if isinstance(answer, BaseException):
                raise answer
            return answer

        params = {
            "provider": "openai", "model": "gpt-4o-mini", "api_key": "k", "base_url": "",
            "prompt": "List.", "response_model": TABLE_MODEL, "return_shape": "table", "max_tokens": 1000,
        }
        params.update(kwargs)
        with mock.patch.object(llm, "completion", side_effect=fake_completion):
            return llm.run_structured(**params), calls

    def test_the_return_value_keeps_its_shape(self):
        (out, used_fallback), calls = self.call([reply('{"rows": [{"name": "H", "score": null}]}')])
        self.assertEqual(out, {"rows": [{"name": "H", "score": None}]})
        self.assertFalse(used_fallback)
        self.assertEqual(calls[0]["response_format"]["type"], "json_schema")
        self.assertEqual(calls[0]["max_tokens"], 1000)
        (out, used_fallback, debug), _ = self.call([reply('{"name": "H", "score": 1}')], response_model=ROW_MODEL,
                                                   return_shape="single", return_debug=True)
        self.assertEqual(out, {"name": "H", "score": 1.0})
        self.assertEqual((debug["path"], debug["repaired"], debug["tried"]), ("json_schema", False, []))

    def test_a_missing_string_field_gets_the_correction_turn_rather_than_a_blank(self):
        answers = [reply('{"Name": "H", "score": 1}'), reply('{"name": "H", "score": 1}')]
        (out, _, debug), calls = self.call(answers, response_model=ROW_MODEL, return_shape="single", return_debug=True)
        self.assertEqual(out["name"], "H")
        self.assertTrue(debug["repaired"])
        self.assertIn("name", calls[1]["messages"][-1]["content"])

    def test_bedrock_keeps_its_key_and_region(self):
        _, calls = self.call([reply('{"rows": []}')], provider="bedrock", model="anthropic.claude-x",
                             api_key="AWS_BEARER_TOKEN_BEDROCK=tok")
        self.assertEqual((calls[0]["api_key"], calls[0]["aws_region_name"]), ("tok", "us-east-1"))
        self.assertEqual(calls[0]["model"], "bedrock/anthropic.claude-x")

    def test_openrouter_models_are_routed_through_openrouter(self):
        _, calls = self.call([reply('{"rows": []}')], provider="openrouter", model="anthropic/claude-sonnet-4.5")
        self.assertEqual(calls[0]["model"], "openrouter/anthropic/claude-sonnet-4.5")

    def test_a_rejected_mode_is_remembered_for_the_next_call(self):
        (_, used_fallback), calls = self.call([rejected(), reply(tool_arguments='{"rows": [{"name": "H", "score": 2}]}')],
                                              provider="deepseek", model="deepseek-chat")
        self.assertFalse(used_fallback)
        self.assertEqual([("response_format" in c, "tools" in c) for c in calls], [(True, False), (False, True)])
        self.assertEqual(self.memory.get(llm.structured_mode_key("deepseek", "deepseek-chat", "")), "tool")
        _, calls = self.call([reply(tool_arguments='{"rows": []}')], provider="deepseek", model="deepseek-chat")
        self.assertEqual(len(calls), 1)
        self.assertIn("tools", calls[0])
        self.assertNotIn("response_format", calls[0])

    def test_a_given_mode_wins_over_the_remembered_one(self):
        self.memory.set(llm.structured_mode_key("openai", "gpt-4o-mini", ""), "tool")
        (_, used_fallback), calls = self.call([reply('[{"name": "H", "score": 1}]')], structured_mode="prompt")
        self.assertTrue(used_fallback)
        self.assertNotIn("tools", calls[0])

    def test_an_outage_is_raised_after_retries_and_never_lowers_the_mode(self):
        outage = litellm.ServiceUnavailableError(message="Service Unavailable", llm_provider="openai", model="m")
        with self.assertRaises(litellm.ServiceUnavailableError):
            self.call([outage, outage, outage, outage])
        self.assertIsNone(self.memory.get(llm.structured_mode_key("openai", "gpt-4o-mini", "")))

    def test_an_error_whose_text_says_rate_is_not_retried(self):
        error = litellm.BadRequestError(message="Cannot generate output for this request", model="m", llm_provider="openai")
        with self.assertRaises(litellm.BadRequestError):
            _, calls = self.call([error, reply('{"rows": []}')])
        self.assertTrue(llm._is_retryable_error(litellm.RateLimitError(message="slow down", llm_provider="openai", model="m")))
        self.assertFalse(llm._is_retryable_error(error))

    def test_image_blocks_reach_the_model_in_the_prompt_mode(self):
        image = {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}}
        _, calls = self.call([reply('[{"name": "H", "score": 1}]')], prompt=[{"type": "text", "text": "Read."}, image],
                             structured_mode="prompt")
        content = calls[0]["messages"][0]["content"]
        self.assertEqual(content[1], image)
        self.assertEqual(content[-1]["type"], "text")

    def test_images_for_a_text_only_adapter_are_refused_rather_than_dropped(self):
        # LiteLLM's DeepSeek adapter keeps only the text of a content list.
        image = {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}}
        with self.assertRaisesRegex(ValueError, "DeepSeek's API reads text only"):
            self.call([], provider="deepseek", model="deepseek-chat", prompt=[{"type": "text", "text": "Read."}, image])
        (out, _), calls = self.call([reply('{"rows": []}')], provider="deepseek", model="deepseek-chat",
                                    prompt=[{"type": "text", "text": "Text only."}])
        self.assertEqual(out, {"rows": []})


if __name__ == "__main__":
    unittest.main()
