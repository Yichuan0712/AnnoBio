"""Click to Optimize segmentation: whole-prompt cards are split locally at paragraph boundaries (exact join)."""
from __future__ import annotations

import unittest

import review_optimization_compositional as comp


class SplitTests(unittest.TestCase):
    def test_split_paragraphs_joins_back_exactly(self):
        text = "# Task\nExtract every drug.\n\n# Rules\n- one\n- two\n\n\n# Output\nReturn JSON.\nNo prose."
        for ms in range(1, 9):
            parts = comp.split_paragraphs(text, ms)
            self.assertEqual("".join(parts), text)
            self.assertLessEqual(len(parts), ms)
            self.assertTrue(all(p for p in parts))

    def test_single_line_stays_one_segment(self):
        self.assertEqual(comp.split_paragraphs("one long line " * 200, 5), ["one long line " * 200])

    def call(self, new_sentence, llm_reply=None):
        calls = []

        def fake_chat(**kwargs):
            calls.append(kwargs)
            return llm_reply
        original = comp.llm_chat
        comp.llm_chat = fake_chat
        try:
            parts = comp.compositional_optimization_segments(
                provider="p", model="m", api_key="k", base_url="", max_tokens=8192, old_sentence="old",
                new_sentence=new_sentence, improvement_rationale="why", max_segments=4)
        finally:
            comp.llm_chat = original
        return parts, calls

    def test_whole_prompt_card_uses_the_local_split(self):
        text = "\n\n".join(f"Paragraph {i}: " + "word " * 60 for i in range(6))
        parts, calls = self.call(text)
        self.assertEqual(calls, [])  # no model call: nothing to copy verbatim
        self.assertEqual("".join(parts), text.strip())  # the text is trimmed first, as the frontend's proposal is
        self.assertLessEqual(len(parts), 4)
        self.assertGreater(len(parts), 1)

    def test_one_line_whole_prompt_splits_at_sentences_keeping_spaces(self):
        text = "Identify the sentiment. Review: {text} Return the label only. Use favorable or unfavorable."
        parts = comp.split_paragraphs(text, 3)
        self.assertEqual("".join(parts), text)
        self.assertGreater(len(parts), 1)
        parts, calls = self.call_whole(text)
        self.assertEqual(calls, [])
        self.assertEqual("".join(parts), text)

    def call_whole(self, new_sentence):
        calls = []
        original = comp.llm_chat
        comp.llm_chat = lambda **kw: calls.append(kw)
        try:
            parts = comp.compositional_optimization_segments(
                provider="p", model="m", api_key="k", base_url="", max_tokens=8192, old_sentence="old prompt",
                new_sentence=new_sentence, improvement_rationale="why", max_segments=4, whole_prompt=True)
        finally:
            comp.llm_chat = original
        return parts, calls

    def test_short_sentence_keeps_the_model_split(self):
        parts, calls = self.call("Return every drug name, including brands.",
                                 '{"segments": ["Return every drug name,", " including brands."]}')
        self.assertEqual(len(calls), 1)
        self.assertEqual(parts, ["Return every drug name,", "including brands."])  # unchanged behaviour


if __name__ == "__main__":
    unittest.main()
