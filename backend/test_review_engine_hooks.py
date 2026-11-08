"""The worked-example card end to end with the real backend scoring (score_engine), a scripted Generate model."""
from __future__ import annotations

from types import SimpleNamespace
import unittest

from review_engine_hooks import dense_table, input_entries_by_example, make_score_input
from review_engine_v2 import run_engine_v2

PROMPT = "Extract the drug name. Return JSON."
DRUGS = ["aspirin", "ibuprofen", "metformin", "insulin", "warfarin", "heparin", "statin", "codeine"]
BUNDLE = {"v": 2, "input": {"type": "group", "ops": [], "children": []},
          "output": {"type": "group", "ops": [], "children": [
              {"type": "rule", "outputKey": "drug", "gtColumns": ["drug"], "matchType": "exact",
               "matchFlags": {"ignoreCase": True}}]}}


def comparison_rows():
    return [{"row_index": i, "input_row_index": i, "matched": i < 3, "run_output": {"drug": d if i < 3 else "pain"},
             "ground_truth_output": {"drug": d}, "row_input": {"text": f"Patient took {d}."},
             "comparison_types": ["drug: exact (ignore case)"], "gt_only": False, "source_gt_row_index": i}
            for i, d in enumerate(DRUGS)]


def tables():
    return {"input_headers": ["text"], "input_rows": [[i, [f"Patient took {d}."]] for i, d in enumerate(DRUGS)],
            "gt_headers": ["drug"], "gt_rows": [[i, [d.upper()]] for i, d in enumerate(DRUGS)]}


class Model:
    def __init__(self):
        self.n = 0

    def __call__(self, request):
        if request.stage == "diagnose":
            return {"card_title": "Missed drug", "issue_summary": "Names a symptom.", "rough_modification_opinion": "Name the drug.",
                    "problem_category_hint": "drug", "gt_suspect_note": ""}
        if request.stage == "rewrite":
            self.n += 1
            return {"name": "Rewrite", "prompt": PROMPT + f" ({self.n})", "reason": "fix"}
        if request.stage == "explain":
            return {"explanation": "The drug is named."}
        raise AssertionError(request.stage)


class HookTests(unittest.TestCase):
    def test_dense_table_keeps_original_indices(self):
        self.assertEqual(dense_table(["h"], [[2, ["c"]], [0, ["a"]]]), {"headers": ["h"], "rows": [["a"], [], ["c"]]})

    def test_input_entries_follow_verify(self):
        rows = [{"input_row_index": 4, "source_gt_row_index": 1, "ground_truth_output": {}},
                {"input_row_index": 4, "source_gt_row_index": 1, "ground_truth_output": {"x": 1}},
                {"input_row_index": 4, "source_gt_row_index": 3, "ground_truth_output": {"x": 2}},
                {"input_row_index": None, "source_gt_row_index": 0, "ground_truth_output": {}}]
        self.assertEqual(input_entries_by_example(rows),
                         {"input-5": [4, {"gtRows": [{"gtNum": 2, "gtRowIndex": 1}, {"gtNum": 4, "gtRowIndex": 3}]}]})

    def test_score_input_is_verifys_verdict(self):
        score = make_score_input(comparison_rows=comparison_rows(), score_mapping=BUNDLE, score_match_code="",
                                 score_tables=tables(), output_fields=[{"display": "drug", "key": "drug"}],
                                 python_path=None, project_session_id=None)
        self.assertEqual(score("input-2", [{"drug": "Ibuprofen"}]), (1, 1))  # ignore case
        self.assertEqual(score("input-2", [{"drug": "pain"}]), (0, 1))
        self.assertEqual(score.scorable, {f"input-{i + 1}" for i in range(8)})

    def test_example_card_with_real_scoring(self):
        runs = []

        def run_row(template, values):
            runs.append(template)
            drug = values["text"].split("took ")[1].rstrip(".")
            return [{"drug": drug if "WORKED_EXAMPLES" in template else "pain"}]
        score = make_score_input(comparison_rows=comparison_rows(), score_mapping=BUNDLE, score_match_code="",
                                 score_tables=tables(), output_fields=[{"display": "drug", "key": "drug"}],
                                 python_path=None, project_session_id=None)
        events = []
        body = SimpleNamespace(prompt=PROMPT, comparison_rows=comparison_rows())
        run_engine_v2(provider="", model="", api_key="", base_url="", body=body, max_tokens=100, max_failed_inputs=30,
                      is_cancelled=lambda: False, append_event=events.append,
                      settings={"engine_num_proposals": 1, "_run_row": run_row, "_score_input": score}, llm_call=Model())
        cards = [s for e in events if e["type"] == "suggestions" for s in e["suggestions"]]
        demos = [c for c in cards if c.get("engine_card_kind") == "demos"]
        self.assertEqual(len(demos), 1)
        self.assertIn("1.00 with these examples vs 0.", demos[0]["reason"])  # examples fix every held-out input
        self.assertNotIn(PROMPT, runs)

    def test_request_accepts_the_fields_and_validates_run_settings(self):
        from pydantic import ValidationError
        from main import ReviewRequest
        body = ReviewRequest(credential_id="opt", prompt=PROMPT, run_credential_id="gen", run_settings={"run_max_tokens": 512},
                             score_match_code="", score_tables=tables())
        self.assertEqual(body.run_settings, {"run_max_tokens": 512})
        with self.assertRaises(ValidationError):
            ReviewRequest(credential_id="opt", prompt=PROMPT, run_settings={"run_params": {}})
        self.assertIsNone(ReviewRequest(credential_id="opt", prompt=PROMPT).score_tables)  # older frontends


if __name__ == "__main__":
    unittest.main()
