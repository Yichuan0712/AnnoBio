"""Structured output in the prompt-JSON mode (models without native structured output).

The reply is free text: the JSON must be read by the parser rather than by counting brackets, a reply
cut off at max tokens must say so, and scalar values in string fields are stored as text.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import llm  # noqa: E402  (needs backend/ on sys.path for its own sibling imports)
import llm_structured  # noqa: E402
from run_output_schema import build_output_model, build_table_output_model  # noqa: E402

FIELDS = [
    {"key": "kinase", "type": "str", "description": "Kinase"},
    {"key": "is_specifically_mentioned", "type": "str", "description": "true or false"},
    {"key": "evidence_texts", "type": "list_str", "description": "Sentences"},
    {"key": "confidence", "type": "float", "description": "0-1"},
]
ROW_MODEL = build_output_model(FIELDS)
TABLE_MODEL = build_table_output_model(ROW_MODEL)


def reply(text: str, finish_reason: str = "stop"):
    message = SimpleNamespace(content=text, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason=finish_reason)])


def run_prompt_mode(text: str, finish_reason: str = "stop", return_shape: str = "table"):
    """run_structured in the prompt mode, the model answering `text` every time it is asked."""
    model = TABLE_MODEL if return_shape == "table" else ROW_MODEL
    with mock.patch.object(llm, "completion", return_value=reply(text, finish_reason)), \
            mock.patch.object(llm, "structured_modes", llm_structured.ModeMemory()), \
            mock.patch.object(llm, "safe_print"):
        out, used_fallback = llm.run_structured(
            provider="deepseek", model="deepseek-reasoner", api_key="k", base_url="",
            prompt="Extract pairs.", response_model=model, max_tokens=8192, return_shape=return_shape,
            structured_mode="prompt",
        )
    assert used_fallback
    return out


class PromptJsonModeTest(unittest.TestCase):
    def test_a_bracket_inside_a_string_does_not_end_the_array(self):
        text = (
            'Here you go:\n[\n  {"kinase": "ATR", "is_specifically_mentioned": "true",\n'
            '   "evidence_texts": ["Ser15] was phosphorylated", "Ser37 too"], "confidence": 0.9}\n]\nDone.'
        )
        out = run_prompt_mode(text)
        self.assertEqual(out["rows"][0]["evidence_texts"], ["Ser15] was phosphorylated", "Ser37 too"])

    def test_an_object_reply_is_read_the_same_way(self):
        text = '{"kinase": "ATR {x}", "is_specifically_mentioned": "true", "evidence_texts": ["a } b"], "confidence": 1} trailing'
        out = run_prompt_mode(text, return_shape="single")
        self.assertEqual(out["evidence_texts"], ["a } b"])

    def test_true_false_and_numbers_in_string_fields_become_text(self):
        text = '[{"kinase": 7, "is_specifically_mentioned": true, "evidence_texts": [], "confidence": 0.5},' \
               ' {"kinase": null, "is_specifically_mentioned": false, "evidence_texts": [], "confidence": 1}]'
        rows = run_prompt_mode(text)["rows"]
        self.assertEqual([(r["kinase"], r["is_specifically_mentioned"]) for r in rows], [("7", "true"), ("", "false")])

    def test_a_single_row_reply_has_its_string_fields_coerced_too(self):
        text = '{"kinase": 7, "is_specifically_mentioned": false, "evidence_texts": [], "confidence": 1}'
        out = run_prompt_mode(text, return_shape="single")
        self.assertEqual((out["kinase"], out["is_specifically_mentioned"]), ("7", "false"))

    def test_a_reply_cut_off_at_max_tokens_says_so(self):
        text = '[{"kinase": "ATR", "is_specifically_mentioned": "true", "evidence_texts": ["Hyperoxia phosph'
        with self.assertRaisesRegex(ValueError, r"max tokens limit \(8192\).*Raise Max tokens in Settings"):
            run_prompt_mode(text, finish_reason="length")

    def test_an_incomplete_reply_still_reports_the_parse_error(self):
        with self.assertRaisesRegex(ValueError, "Unterminated string"):
            run_prompt_mode('[{"kinase": "ATR", "evidence_texts": ["Hyperoxia phosph')


if __name__ == "__main__":
    unittest.main()
