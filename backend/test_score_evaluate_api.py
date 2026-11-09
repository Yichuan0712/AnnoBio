"""POST /api/score/evaluate and score_engine.score_inputs (the backend scoring API, step 2 of the scoring plan)."""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import main
import score_engine
from fastapi.testclient import TestClient
from test_score_engine import canon, fixture


def bundle(*rules, ops=None):
    children = [{"type": "rule", "outputKey": k, "gtColumns": cols, "matchType": mt, "matchFlags": flags}
                for k, cols, mt, flags in rules]
    return {"v": 2, "input": {"type": "group", "ops": [], "children": []},
            "output": {"type": "group", "ops": ops or ["AND"] * (len(children) - 1), "children": children}}


ANSWER_RULE = ("answer", ["answer"], "exact", {"ignoreCase": True})
MATCH_CODE = "def match(input_row, output_row, gt_row):\n    return output_row.get('answer') == gt_row.get('answer')\n"


class ScoreEvaluateApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def post(self, body):
        return self.client.post("/api/score/evaluate", json=body)

    def test_batch_of_inputs_scores_each_input(self):
        response = self.post({
            "score_mapping": bundle(ANSWER_RULE),
            "gt_headers": ["answer"],
            "inputs": [
                {"run_rows": [{"output": {"answer": "YES"}}], "gt_rows": [["yes"]]},
                {"run_rows": [{"output": {"answer": "a"}}, {"output": {"answer": "b"}}], "gt_rows": [["b"], ["c"]]},
                {"run_rows": [], "gt_rows": [["x"]]},
            ],
        })
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual([[r["matched"] for r in item["verifyRows"]] for item in data["results"]],
                         [[True], [False, True], [False]])
        self.assertEqual((data["matchedCount"], data["total"]), (2, 4))
        second = data["results"][1]
        self.assertEqual([(r["rowIndex"], r["gtRowIndex"], r["paired"]) for r in second["runRows"]],
                         [(0, None, False), (1, 0, True)])
        self.assertEqual([r["gtNum"] for r in second["verifyRows"]], [2, 1])

    def test_verify_form_returns_what_the_javascript_returned(self):
        cases = [c for c in fixture()["cases"] if c["category"] in ("tables", "smart") and "error" not in c["expected"]][:25]
        for case in cases:
            a = case["args"]
            response = self.post({
                "score_mapping": a.get("scoreMapping"), "results": a["results"], "input_entries": a["inputEntries"],
                "run_ws": a["runWs"], "gt_content": a["gtContent"], "output_fields": a["outputFields"],
                "embedding_cosines": case["embeddingCosines"], "concepts": case["concepts"],
            })
            self.assertEqual(response.status_code, 200, (case["id"], response.text))
            data = response.json()
            got = {k: data[k] for k in ("verifyRows", "matchedCount", "total")}
            self.assertEqual(canon(got), canon(case["expected"]), case["id"])

    def test_embedding_and_concept_rules_use_given_maps_or_compute_them_in_process(self):
        body = {
            "score_mapping": bundle(("answer", ["answer"], "exact", {"embeddingSimilarity": True})),
            "gt_headers": ["answer"],
            "inputs": [{"run_rows": [{"output": {"answer": "heart attack"}}], "gt_rows": [["myocardial infarction"]]}],
        }
        given = self.post({**body, "embedding_cosines": [["heart attack", "myocardial infarction", 0.8]]})
        self.assertTrue(given.json()["results"][0]["verifyRows"][0]["matched"])
        with mock.patch.object(score_engine, "default_embedding_provider", return_value=[0.5]) as provider:
            computed = self.post(body)
        provider.assert_called_once_with([("heart attack", "myocardial infarction")])
        self.assertFalse(computed.json()["results"][0]["verifyRows"][0]["matched"])
        concept_body = {**body, "score_mapping": bundle(("answer", ["answer"], "exact", {"meshMatch": True}))}
        with mock.patch.object(score_engine, "default_concept_provider",
                               side_effect=lambda source, terms: {t: {"concept_id": "D009203", "source": source} for t in terms}) as provider:
            response = self.post(concept_body)
        self.assertEqual(provider.call_args.args[0], "mesh")
        self.assertTrue(response.json()["results"][0]["verifyRows"][0]["matched"])

    def test_an_unavailable_embedding_model_is_a_503(self):
        with mock.patch.object(score_engine, "default_embedding_provider", side_effect=RuntimeError("no fastembed")):
            response = self.post({
                "score_mapping": bundle(("answer", ["answer"], "exact", {"embeddingSimilarity": True})),
                "gt_headers": ["answer"], "inputs": [{"run_rows": [{"output": {"answer": "a"}}], "gt_rows": [["b"]]}],
            })
        self.assertEqual(response.status_code, 503)

    def test_validation(self):
        one = {"run_rows": [{"output": {"answer": "a"}}], "gt_rows": [["a"]]}
        for body in (
            {"score_mapping": bundle(ANSWER_RULE)},  # neither form
            {"score_mapping": bundle(ANSWER_RULE), "inputs": [one], "results": []},  # both forms
            {"score_mapping": bundle(ANSWER_RULE), "results": []},  # results without input_entries
            {"score_mapping": bundle(ANSWER_RULE), "inputs": [{"gt_rows": ["not a row"]}]},
            {"score_mapping": bundle(ANSWER_RULE), "inputs": [one], "embedding_cosines": [["a", "b"]]},
            {"score_mapping": bundle(ANSWER_RULE), "inputs": [one], "concepts": [["mesh", 5, None]]},
        ):
            self.assertEqual(self.post(body).status_code, 422, body)
        with mock.patch.object(main, "SCORE_EVALUATE_MAX_INPUTS", 2):
            self.assertEqual(self.post({"score_mapping": bundle(ANSWER_RULE), "inputs": [one] * 3}).status_code, 422)
        response = self.post({"score_mapping": "{}", "gt_headers": ["answer"], "inputs": [one]})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "No Evaluate output->gt rules configured.")

    def test_code_mode_uses_the_settings_interpreter(self):
        body = {"score_match_code": MATCH_CODE, "gt_headers": ["answer"],
                "inputs": [{"run_rows": [{"output": {"answer": "b"}}], "gt_rows": [["a"], ["b"]]}]}
        with mock.patch.object(main, "_load_settings", return_value={"python_path": sys.executable}):
            response = self.post(body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([(r["gtNum"], r["matched"]) for r in response.json()["results"][0]["verifyRows"]],
                         [(2, True), (1, False)])
        with mock.patch.object(main, "_load_settings", return_value={"python_path": ""}):
            response = self.post(body)
        self.assertEqual(response.status_code, 400)
        self.assertIn("Python interpreter", response.json()["detail"])


class ScoreInputsTests(unittest.TestCase):
    def test_batch_shares_one_embedding_cache(self):
        calls = []

        def provider(pairs):
            calls.append(list(pairs))
            return [0.9 for _ in pairs]

        result = score_engine.score_inputs(
            [{"run_rows": [{"output": {"answer": "x"}}], "gt_rows": [["y"]]},
             {"run_rows": [{"output": {"answer": "x"}}], "gt_rows": [["y"]]},
             {"run_rows": [{"output": {"answer": "x"}}], "gt_rows": [["z"]]}],
            score_mapping=bundle(("answer", ["answer"], "exact", {"embeddingSimilarity": True})),
            gt_headers=["answer"], embedding_provider=provider,
        )
        self.assertEqual(calls, [[("x", "y")], [("x", "z")]])
        self.assertEqual((result["matchedCount"], result["total"]), (3, 3))


if __name__ == "__main__":
    unittest.main()
