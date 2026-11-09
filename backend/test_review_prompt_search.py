"""APE and EvoPrompt Optimize methods (review_prompt_search.py): scripted models, the real backend scoring."""
from __future__ import annotations

from types import SimpleNamespace
import unittest

import prompt_search_templates as templates
from review_engine_hooks import make_score_input
from review_prompt_search import get_final_prompt, keep_placeholders, run_ape, run_evoprompt
from test_review_engine_hooks import BUNDLE, PROMPT, comparison_rows, tables


def score_input():
    return make_score_input(comparison_rows=comparison_rows(), score_mapping=BUNDLE, score_match_code="",
                            score_tables=tables(), output_fields=[{"display": "drug", "key": "drug"}],
                            python_path=None, project_session_id=None)


class Generate:
    """Names the drug only when the prompt says GOOD; counts runs per prompt."""

    def __init__(self):
        self.runs: list[str] = []
        self.concurrency = 4

    def __call__(self, template, values):
        self.runs.append(template)
        drug = values["text"].split("took ")[1].rstrip(".")
        return [{"drug": drug if "GOOD" in template else "pain"}]


def run(method, meta, settings=None, rows=None):
    generate, events = Generate(), []
    body = SimpleNamespace(prompt=PROMPT, comparison_rows=rows if rows is not None else comparison_rows())
    hooks = {"_run_row": generate, "_score_input": score_input()}
    fn = run_ape if method == "ape" else run_evoprompt
    import review_prompt_search
    original = review_prompt_search.llm_chat
    review_prompt_search.llm_chat = lambda _p, _m, _k, _b, messages, max_tokens: meta(messages[0]["content"])
    try:
        fn(provider="", model="", api_key="", base_url="", body=body, max_tokens=100, max_failed_inputs=30,
           is_cancelled=lambda: False, append_event=events.append, settings={**(settings or {}), **hooks})
    finally:
        review_prompt_search.llm_chat = original
    cards = [s for e in events if e["type"] == "suggestions" for s in e["suggestions"]]
    return cards, events, generate


class HelperTests(unittest.TestCase):
    def test_dropped_placeholders_come_back(self):
        prompt = "Read {abstract} and {title}. Answer."
        self.assertEqual(keep_placeholders("Answer from {title}.", prompt), "Answer from {title}.\n\nabstract: {abstract}")
        self.assertEqual(keep_placeholders("Use {abstract} {title}", prompt), "Use {abstract} {title}")
        self.assertEqual(keep_placeholders("x", "no placeholders"), "x")

    def test_get_final_prompt_is_evoprompts(self):
        self.assertEqual(get_final_prompt("1. ... <prompt>A</prompt> then <prompt> B </prompt>"), "B")
        self.assertEqual(get_final_prompt('"quoted"'), "quoted")

    def test_templates_are_the_official_texts(self):
        self.assertTrue(templates.APE_GENERATION_TEMPLATE.startswith("I gave a friend an instruction."))
        self.assertTrue(templates.APE_GENERATION_TEMPLATE.endswith("The instruction was to [APE]"))
        self.assertEqual(templates.EVOPROMPT_PARAPHRASE.format(s="X"),
                         "Generate a variation of the following instruction while keeping the semantic meaning.\nInput:X\nOutput:")
        for tag in ("<prompt0>", "<prompt1>", "<prompt2>", "<prompt3>"):
            self.assertEqual(templates.EVOPROMPT_DE_TEMPLATE.count(tag), 1)


class ApeTests(unittest.TestCase):
    def test_finds_the_better_prompt_and_reuses_the_users_run(self):
        replies = iter(range(1000))

        def meta(text):
            self.assertIn("I gave a friend an instruction.", text)
            self.assertIn("Input: {\"text\":", text)  # demos are the evaluated inputs with their references
            n = next(replies)
            return "GOOD: name the drug." if n == 7 else f"Variant {n}"
        cards, events, generate = run("ape", meta)
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0]["new_sentence"], "GOOD: name the drug.")
        self.assertEqual(cards[0]["old_sentence"], PROMPT)
        self.assertIn("100% vs the original's 38%", cards[0]["reason"])
        self.assertNotIn(PROMPT, generate.runs)  # the prompt's own score is the user's run
        self.assertEqual(len(generate.runs), 50 * 8)  # 50 proposals x 8 inputs, one round, no resampling
        done = [e for e in events if e.get("stage_id") == "select" and e["kind"] == "done"][0]["payload"]
        self.assertEqual((done["generate_calls"], done["optimization_calls"]), (400, 50))

    def test_more_rounds_resample_the_survivors(self):
        def meta(text):
            if text.startswith("Generate a variation"):
                self.assertIn("\n\nInput: ", text)  # the paper's resampling prompt
                return "GOOD resampled"
            return "Variant " + str(hash(text) % 7) if "friend" in text else ""
        cards, _events, _generate = run("ape", meta, {"ape_rounds": 2})
        self.assertEqual(cards[0]["new_sentence"], "GOOD resampled")

    def test_no_card_when_nothing_beats_the_prompt(self):
        cards, events, _ = run("ape", lambda text: "Worse")
        self.assertEqual(cards, [])
        self.assertEqual(events[-1], {"type": "done"})

    def test_needs_the_generate_model_and_scoring(self):
        events = []
        run_ape(provider="", model="", api_key="", base_url="", body=SimpleNamespace(prompt=PROMPT, comparison_rows=comparison_rows()),
                max_tokens=100, max_failed_inputs=30, is_cancelled=lambda: False, append_event=events.append, settings={})
        self.assertEqual(events[0]["type"], "error")
        self.assertIn("Generate", events[0]["detail"])


class EvoPromptTests(unittest.TestCase):
    def test_evolves_and_keeps_a_better_child(self):
        def meta(text):
            if text.startswith("Generate a variation"):
                return "Paraphrase " + str(abs(hash(text)) % 1000)
            self.assertIn("Basic Prompt:", text)
            return "4. ... Final Prompt: <prompt>GOOD evolved</prompt>"
        cards, events, generate = run("evoprompt", meta, {"evoprompt_generations": 1})
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0]["new_sentence"], "GOOD evolved")
        self.assertIn("on 8 dev input(s)", cards[0]["reason"])
        self.assertNotIn(PROMPT, generate.runs)
        iterations = [e for e in events if e.get("stage_id") == "evolve" and e["kind"] == "iteration"]
        self.assertEqual(len(iterations), 1)
        self.assertEqual(iterations[0]["payload"]["best_score"], 1.0)

    def test_a_reply_without_prompt_tags_is_a_failed_child(self):
        def meta(text):
            return "Paraphrase" if text.startswith("Generate a variation") else "no tags here GOOD"
        cards, _events, _ = run("evoprompt", meta, {"evoprompt_generations": 2})
        self.assertEqual(cards, [])

    def test_too_few_paraphrases_is_an_error(self):
        cards, events, _ = run("evoprompt", lambda text: "")
        self.assertEqual(cards, [])
        self.assertTrue(any(e["type"] == "error" and "paraphrases" in e["detail"] for e in events))


class RegistryAndSettingsTests(unittest.TestCase):
    def test_registered_with_their_settings(self):
        import review_methods
        from main import DEFAULT_SETTINGS, REVIEW_SETTINGS_OVERRIDE_KEYS, SettingsPatch
        ids = [m["id"] for m in review_methods.list_review_methods()]
        self.assertIn("ape", ids)
        self.assertIn("evoprompt", ids)
        self.assertEqual(ids[0], "annobio_engine_v2")
        self.assertEqual((DEFAULT_SETTINGS["ape_rounds"], DEFAULT_SETTINGS["evoprompt_generations"]), (1, 10))
        self.assertTrue({"ape_rounds", "evoprompt_generations"} <= REVIEW_SETTINGS_OVERRIDE_KEYS)
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            SettingsPatch(ape_rounds=0)
        with self.assertRaises(ValidationError):
            SettingsPatch(evoprompt_generations=51)


if __name__ == "__main__":
    unittest.main()
