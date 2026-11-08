"""review_engine_v2 with a scripted optimization model: the event stream and card fields the Optimize panel reads."""
from __future__ import annotations

import json
from types import SimpleNamespace
import unittest

from review_engine_v2 import build_inputs, run_engine_v2

PROMPT = "Extract the drug name. Return JSON."


def rows():
    """Three inputs: input 1 matched, input 2 failed (one scoring row), input 3 two rows, one failed."""
    common = {"comparison_types": ["drug: exact (ignore case)"], "gt_only": False}
    return [
        {"row_index": 0, "input_row_index": 0, "matched": True, "run_output": {"drug": "aspirin"},
         "ground_truth_output": {"drug": "Aspirin"}, "row_input": {"text": "Took aspirin."}, **common},
        {"row_index": 1, "input_row_index": 1, "matched": False, "run_output": {"drug": "pain"},
         "ground_truth_output": {"drug": "ibuprofen"}, "row_input": {"text": "Ibuprofen for pain."}, **common},
        {"row_index": 2, "input_row_index": 2, "matched": True, "run_output": {"drug": "metformin"},
         "ground_truth_output": {"drug": "metformin"}, "row_input": {"text": "Metformin and insulin."}, **common},
        {"row_index": 3, "input_row_index": 2, "matched": False, "run_output": {},
         "ground_truth_output": {"drug": "insulin"}, "row_input": {"text": "Metformin and insulin."},
         "comparison_types": ["drug: exact (ignore case)"], "gt_only": True},
    ]


class Model:
    def __init__(self):
        self.calls = []
        self.rewrites = 0

    def __call__(self, request):
        self.calls.append(request)
        if request.stage == "diagnose":
            return {"card_title": "Missed drug", "issue_summary": "The output names a symptom, not the drug.",
                    "rough_modification_opinion": "Say: return every drug name.", "problem_category_hint": "drug",
                    "gt_suspect_note": ""}
        if request.stage == "rewrite":
            self.rewrites += 1
            return {"name": f"Rewrite {self.rewrites}", "prompt": PROMPT + f" List every drug (v{self.rewrites}).",
                    "reason": "cover all drugs"}
        raise AssertionError(request.stage)


def run(settings=None, comparison_rows=None, cancelled=lambda: False):
    model, events = Model(), []
    body = SimpleNamespace(prompt=PROMPT, comparison_rows=rows() if comparison_rows is None else comparison_rows)
    run_engine_v2(provider="", model="", api_key="", base_url="", body=body, max_tokens=1000, max_failed_inputs=30,
                  is_cancelled=cancelled, append_event=events.append, settings=settings or {}, llm_call=model)
    return model, events


class EngineV2MethodTests(unittest.TestCase):
    def test_event_stream_and_cards(self):
        model, events = run({"engine_num_proposals": 2})
        kinds = [e["type"] for e in events]
        self.assertEqual(kinds[0], "plan")
        self.assertEqual(kinds[-1], "done")
        self.assertEqual(events[0]["diagnosis_total"], 2)
        diagnoses = [e for e in events if e["type"] == "diagnosis_row"]
        self.assertEqual(sorted(d["input_index"] for d in diagnoses), [2, 3])
        self.assertEqual({tuple(d["row_indices"]) for d in diagnoses}, {(1,), (2, 3)})
        for d in diagnoses:
            self.assertEqual(set(d["opinion"]), {"card_title", "issue_summary", "rough_modification_opinion",
                                                 "problem_category_hint", "gt_suspect_note"})
        suggestions = next(e for e in events if e["type"] == "suggestions")["suggestions"]
        self.assertEqual(len(suggestions), 2)  # 每次给出的修改方案数
        for s in suggestions:
            self.assertEqual(s["old_sentence"], PROMPT)  # whole-prompt card
            self.assertTrue(s["new_sentence"].startswith(PROMPT))
            self.assertTrue(1 <= len(s["phase1_addresses"]) <= 3)
            self.assertTrue(all(0 < len(a) <= 500 for a in s["phase1_addresses"]))
            self.assertEqual(s["target_score_row_indices"], [1, 2, 3])  # every row of each failed input
            self.assertTrue(s["name"] and s["reason"])
        self.assertEqual(len({s["new_sentence"] for s in suggestions}), 2)

    def test_matching_rules_reach_the_optimization_model(self):
        model, _ = run()
        diagnose = next(c for c in model.calls if c.stage == "diagnose")
        self.assertIn("drug: exact (ignore case)", diagnose.payload["evaluation"]["feedback"])
        self.assertIn("matched", json.dumps(diagnose.payload["evaluation"]["details"]))

    def test_failed_input_cap(self):
        model, events = run({"engine_failed_inputs": 1, "engine_num_proposals": 1})
        self.assertEqual(events[0]["diagnosis_total"], 1)
        self.assertEqual(sum(1 for c in model.calls if c.stage == "diagnose"), 1)

    def test_nothing_failed(self):
        all_matched = [dict(r, matched=True, gt_only=False) for r in rows()]
        model, events = run(comparison_rows=all_matched)
        self.assertEqual([e["type"] for e in events], ["plan", "done"])
        self.assertEqual(model.calls, [])

    def test_cancel_stops_without_done(self):
        _, events = run(cancelled=lambda: True)
        self.assertNotIn("done", [e["type"] for e in events])

    def test_inputs_follow_the_app_rule(self):
        examples, observations, rows_of, number_of = build_inputs(rows())
        self.assertEqual([e.id for e in examples], ["input-1", "input-2", "input-3"])
        third = observations[2].evaluation
        self.assertEqual((third.matched_count, third.total_count), (1, 2))  # fails: not every row matched
        self.assertEqual(rows_of["input-3"], [2, 3])
        self.assertEqual(number_of["input-3"], 3)


class EngineSettingsTests(unittest.TestCase):
    def test_defaults_and_validation(self):
        from pydantic import ValidationError
        from main import DEFAULT_SETTINGS, SettingsPatch
        self.assertEqual((DEFAULT_SETTINGS["engine_failed_inputs"], DEFAULT_SETTINGS["engine_num_proposals"],
                          DEFAULT_SETTINGS["engine_offer_examples"]), (10, 3, True))
        patch = SettingsPatch(engine_failed_inputs=25, engine_num_proposals=5, engine_offer_examples=False)
        self.assertEqual(patch.model_dump(exclude_none=True),
                         {"engine_failed_inputs": 25, "engine_num_proposals": 5, "engine_offer_examples": False})
        for bad in ({"engine_failed_inputs": 0}, {"engine_num_proposals": 11}):
            with self.assertRaises(ValidationError):
                SettingsPatch(**bad)

    def test_engine_is_the_default_method_and_the_old_ones_stay(self):
        import review_methods
        ids = [m["id"] for m in review_methods.list_review_methods()]
        self.assertEqual(ids[0], "annobio_engine_v2")
        self.assertIn("issue_analysis_suggestions", ids)
        self.assertEqual(review_methods.get_review_method(None).id, "annobio_engine_v2")
        self.assertTrue(review_methods.get_review_method(None).supports_segment_optimization)


class SchemaModelTests(unittest.TestCase):
    def test_every_engine_schema_becomes_a_response_model(self):
        from annobio_optimize.engine.prompts import SCHEMAS
        from review_engine_v2 import _schema_model

        def sample(schema):
            kind = schema.get("type")
            if kind == "object":
                return {k: sample(v) for k, v in schema.get("properties", {}).items()}
            if kind == "array":
                return [sample(schema.get("items", {"type": "string"}))]
            if "enum" in schema:
                return schema["enum"][0]
            return {"number": 1.0, "integer": 1, "boolean": True}.get(kind, "text")
        for stage, schema in SCHEMAS.items():
            model = _schema_model(f"Engine_{stage}", schema)
            value = sample(schema)
            self.assertEqual(model(**value).model_dump(), value, stage)

    def test_model_callback_sends_one_prompt_and_returns_a_dict(self):
        import review_engine_v2
        from annobio_optimize.engine import prompts
        seen = {}

        def fake(**kwargs):
            seen.update(kwargs)
            return kwargs["response_model"](explanation="because"), False
        original = review_engine_v2.llm_run_structured
        review_engine_v2.llm_run_structured = fake
        try:
            call = review_engine_v2.make_model_callback("p", "m", "k", "u", 123)
            out = call(prompts.request("explain", {"prompt": "P", "input": {"x": 1}, "reference": "y"}))
        finally:
            review_engine_v2.llm_run_structured = original
        self.assertEqual(out, {"explanation": "because"})
        self.assertIn("response_schema=", seen["prompt"])
        self.assertIn("payload=", seen["prompt"])
        self.assertEqual(seen["max_tokens"], 123)


if __name__ == "__main__":
    unittest.main()
