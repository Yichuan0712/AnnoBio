"""
Parity of backend/score_engine.py with the app's JavaScript scoring.

The fixture is written by the real frontend code (node app/tests/scoreParityFixture.mjs); every case holds the
arguments Verify passed to evaluateScoreOutputGt, the embedding / concept values the stub backend served, the
"Match by code" requests it made, and the verdicts it returned. Each case must come out identical here.
"""

import gzip
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import score_engine as se

FIXTURE = Path(__file__).resolve().parent / "test_fixtures" / "score_parity_cases.json.gz"
# Messages of errors both sides raise on purpose (other JS errors are runtime TypeErrors; only raising matters).
OWN_ERRORS = {"No Evaluate output->gt rules configured.", "Invalid array length"}

_fixture = None


def fixture() -> dict:
    global _fixture
    if _fixture is None:
        with gzip.open(FIXTURE, "rt", encoding="utf-8") as fh:
            _fixture = json.load(fh)
    return _fixture


def canon(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def call(case: dict, **extra) -> dict:
    a = case["args"]
    return se.evaluate_score_output_gt(
        score_mapping=a.get("scoreMapping"),
        score_match_code=a.get("scoreMatchCode", ""),
        results=a.get("results"),
        input_entries=a.get("inputEntries"),
        output_fields=a.get("outputFields"),
        run_ws=a.get("runWs"),
        gt_content=a.get("gtContent"),
        **extra,
    )


def static_maps(case: dict) -> dict:
    return {"embedding_cosines": case["embeddingCosines"], "concept_ids": case["concepts"]}


def compare(case: dict, run) -> str | None:
    """None when the backend reaches the recorded verdict, else a short description of the difference."""
    expected = case["expected"]
    try:
        got = run()
    except Exception as error:  # noqa: BLE001 - a raised error is a verdict too
        if "error" not in expected:
            return f"raised {type(error).__name__}: {error}"
        if expected["error"] in OWN_ERRORS and str(error) != expected["error"]:
            return f"raised {error!r}, expected {expected['error']!r}"
        return None
    if "error" in expected:
        return f"returned a result, expected error {expected['error']!r}"
    mine = {"verifyRows": got["verifyRows"], "matchedCount": got["matchedCount"], "total": got["total"]}
    if canon(mine) != canon(expected):
        for k, (a, b) in enumerate(zip(mine["verifyRows"], expected["verifyRows"])):
            if canon(a) != canon(b):
                return f"verifyRows[{k}]: got {canon(a)} expected {canon(b)}"
        return f"got {canon(mine)[:300]} expected {canon(expected)[:300]}"
    return None


def replay_runner(code_runs: list, seen: list):
    """match_exec.run_match_pairs stand-in that returns the outcomes the JavaScript side received."""
    runs = iter(code_runs)

    def runner(python_path, code, run_rows, gt_rows, on_row, is_cancelled):
        recorded = next(runs)
        seen.append((run_rows, gt_rows, recorded))
        for index, outcome in enumerate(recorded["outcomes"]):
            on_row(index, outcome)

    return runner


class ScoreParityTests(unittest.TestCase):
    def cases(self, code: bool):
        return [c for c in fixture()["cases"] if (c["category"] == "code") == code]

    def assert_no_mismatch(self, failures: list, total: int):
        if failures:
            self.fail(f"{len(failures)} of {total} cases differ from the JavaScript; first ones:\n" + "\n".join(failures[:8]))

    def test_fixture_covers_every_category(self):
        categories = {c["category"] for c in fixture()["cases"]}
        self.assertTrue({"golden", "primitives", "numeric", "number-format", "trees", "tables", "smart",
                         "legacy-bundle", "prototype-keys", "errors", "code"} <= categories)
        self.assertGreater(len(fixture()["cases"]), 1500)

    def test_rules_cases_match_javascript_with_prefetched_maps(self):
        cases = self.cases(code=False)
        failures = []
        for case in cases:
            problem = compare(case, lambda: call(case, **static_maps(case)))
            if problem:
                failures.append(f"case {case['id']} ({case['category']}): {problem}")
        self.assert_no_mismatch(failures, len(cases))

    def test_rules_cases_request_the_same_embeddings_and_concepts_as_javascript(self):
        """Without prefetched maps the engine asks its providers for exactly what Verify asks the backend for."""
        cases = self.cases(code=False)
        failures = []
        for case in cases:
            served_pairs = {(a, b): c for a, b, c in case["embeddingCosines"]}
            served_terms = {(s, t): r for s, t, r in case["concepts"]}
            asked_pairs, asked_terms = [], []

            def embeddings(pairs):
                asked_pairs.extend(pairs)
                return [served_pairs[p] for p in pairs]

            def concepts(source, terms):
                asked_terms.extend((source, t) for t in terms)
                return {t: served_terms[(source, t)] for t in terms}

            problem = compare(case, lambda: call(case, embedding_provider=embeddings, concept_provider=concepts))
            if not problem and "error" not in case["expected"]:
                if sorted(asked_pairs) != sorted(served_pairs):
                    problem = f"embedding pairs differ: asked {len(asked_pairs)}, JS asked {len(served_pairs)}"
                elif sorted(asked_terms) != sorted(served_terms):
                    problem = f"concept terms differ: asked {len(asked_terms)}, JS asked {len(served_terms)}"
            if problem:
                failures.append(f"case {case['id']} ({case['category']}): {problem}")
        self.assert_no_mismatch(failures, len(cases))

    def test_code_cases_send_the_same_rows_to_match_code(self):
        """Code mode builds the same input_row / output_row / gt_row dictionaries as the JavaScript client."""
        cases = self.cases(code=True)
        self.assertGreater(len(cases), 10)
        failures = []
        for case in cases:
            seen: list = []
            problem = compare(case, lambda: call(case, python_path="python",
                                                 match_runner=replay_runner(case.get("codeRuns", []), seen)))
            for run_rows, gt_rows, recorded in seen:
                if canon(run_rows) != canon(recorded["runRows"]):
                    problem = problem or f"run rows differ: {canon(run_rows)[:200]} vs {canon(recorded['runRows'])[:200]}"
                if canon(gt_rows) != canon(recorded["gtRows"]):
                    problem = problem or f"gt rows differ: {canon(gt_rows)[:200]} vs {canon(recorded['gtRows'])[:200]}"
            if len(seen) != len(case.get("codeRuns", [])):
                problem = problem or f"ran match code {len(seen)} times, JS ran it {len(case.get('codeRuns', []))}"
            if problem:
                failures.append(f"case {case['id']} ({case['codeName']}): {problem}")
        self.assert_no_mismatch(failures, len(cases))

    def test_code_cases_through_match_exec_reach_the_same_verdicts(self):
        """The case's Python match() really runs (this interpreter, no Settings needed) and pairs like the
        JavaScript equivalent the fixture used."""
        cases = self.cases(code=True)
        failures = []
        for case in cases:
            outcomes: list = []

            def runner(python_path, code, run_rows, gt_rows, on_row, is_cancelled):
                from match_exec import run_match_pairs

                def record(index, outcome):
                    outcomes.append(outcome)
                    on_row(index, outcome)

                run_match_pairs(python_path, code, run_rows, gt_rows, record, is_cancelled)

            problem = compare(case, lambda: call(case, python_path=sys.executable, match_runner=runner))
            expected_outcomes = [o for run in case.get("codeRuns", []) for o in run["outcomes"]]
            simplified = [(o.get("ok"), o.get("matched_gt_index")) for o in outcomes]
            if not problem and simplified != [(o.get("ok"), o.get("matched_gt_index")) for o in expected_outcomes]:
                problem = f"outcomes {simplified} vs {expected_outcomes}"
            if problem:
                failures.append(f"case {case['id']} ({case['codeName']}): {problem}")
        self.assert_no_mismatch(failures, len(cases))

    def test_code_mode_needs_an_interpreter(self):
        case = next(c for c in self.cases(code=True) if c.get("codeRuns"))
        with self.assertRaisesRegex(ValueError, "Python interpreter"):
            call(case, python_path="  ")


class GoldenScoreTests(unittest.TestCase):
    """Hand-written cases with hand-written verdicts (score_input: one input given plainly)."""

    @staticmethod
    def bundle(*rules, ops=None):
        children = [{"type": "rule", "outputKey": k, "gtColumns": cols, "matchType": mt, "matchFlags": flags}
                    for k, cols, mt, flags in rules]
        return {"v": 2, "input": {"type": "group", "ops": [], "children": []},
                "output": {"type": "group", "ops": ops or ["AND"] * (len(children) - 1), "children": children}}

    def test_flags_and_numeric_modes(self):
        cases = [
            (("answer", ["answer"], "exact", {"ignoreCase": True, "ignoreWhitespace": True}), "  Hello   World ", "hello world", True),
            (("answer", ["answer"], "exact", {"ignoreSymbols": True}), "基因 TP53!", "TP53", True),  # JS \w is ASCII-only
            (("answer", ["answer"], "exact", {"contains": True}), "TP53 gene", "tp53", False),
            (("answer", ["answer"], "contains", {}), "the TP53 gene", "TP53", True),  # legacy type -> exact + contains
            (("answer", ["answer"], "exact", {"semanticAlign": True}), "hello world", "helo world", True),
            (("answer", ["answer"], "exact", {"semanticAlign": True, "ignoreCase": True}), "ABC", "abd", False),
            (("answer", ["answer"], "numeric", {"numericMode": "abs", "numericAbsEpsilon": "0.01"}), "1.005", "1", True),
            (("answer", ["answer"], "numeric", {"numericMode": "rel", "numericRelEpsilon": 0.01}), "101", "100", True),
            (("answer", ["answer"], "numeric", {"numericMode": "decimals", "numericDecimalPlaces": 2}), "1.005", "1.01", False),  # 1.005*100 = 100.49999
            (("answer", ["answer"], "numeric", {}), "1e3 mg", "1000", True),
            (("answer", ["answer"], "numeric", {}), "N/A", " N/A ", True),  # not numbers: trimmed text equality
            (("answer", ["answer"], "numeric", {}), "٣", "3", False),  # parseFloat takes ASCII digits only
        ]
        for rule, output, gt, expected in cases:
            with self.subTest(rule=rule, output=output, gt=gt):
                result = se.score_input(score_mapping=self.bundle(rule), run_rows=[{"output": {"answer": output}}],
                                        gt_headers=["answer"], gt_rows=[[gt]])
                self.assertEqual(result["verifyRows"][0]["matched"], expected)
                self.assertEqual((result["matchedCount"], result["total"]), (int(expected), 1))

    def test_table_output_pairs_greedily_and_reports_rows(self):
        mapping = self.bundle(("answer", ["answer"], "exact", {}), ("gene", ["gene"], "exact", {}), ops=["OR"])
        result = se.score_input(
            score_mapping=json.dumps(mapping),
            run_rows=[{"output": {"answer": "a", "gene": "g2"}}, {"output": {"answer": "a", "gene": "g1"}},
                      {"output": {"answer": "z", "gene": "z"}}],
            gt_headers=["answer", "gene"], gt_rows=[["a", "g1"], ["b", "g2"], ["c", "g3"], ["d", "g4"]],
        )
        self.assertEqual([r["matched"] for r in result["verifyRows"]], [True, True, False, False])
        self.assertEqual([r["gtNum"] for r in result["verifyRows"]], [2, 1, 3, 4])  # unpaired rows get leftover GT
        self.assertEqual((result["matchedCount"], result["total"]), (2, 4))
        self.assertEqual([(r["rowIndex"], r["gtRowIndex"], r["paired"], r["rules"]) for r in result["runRows"]],
                         [(0, 1, True, [False, True]), (1, 0, True, [True, True]), (2, None, False, None)])
        self.assertEqual([(g["gtRowIndex"], g["runRowIndex"], g["matched"]) for g in result["gtRows"]],
                         [(0, 1, True), (1, 0, True), (2, None, False), (3, None, False)])

    def test_paired_but_failing_the_and_tree_is_not_matched(self):
        mapping = self.bundle(("answer", ["answer"], "exact", {}), ("gene", ["gene"], "exact", {}))
        result = se.score_input(score_mapping=mapping, run_rows=[{"output": {"answer": "x", "gene": "TP53"}}],
                                gt_headers=["answer", "gene"], gt_rows=[["y", "TP53"]])
        self.assertEqual(result["runRows"][0]["paired"], True)
        self.assertEqual(result["verifyRows"][0]["matched"], False)

    def test_several_gt_columns_any_one_matches(self):
        mapping = self.bundle(("answer", ["answer", "alt"], "exact", {}))
        result = se.score_input(score_mapping=mapping, run_rows=[{"output": {"answer": "B"}}],
                                gt_headers=["answer", "alt"], gt_rows=[["A", "B"]])
        self.assertTrue(result["verifyRows"][0]["matched"])
        self.assertEqual(result["verifyRows"][0]["gt"], {"answer": "A", "alt": "B"})

    def test_embedding_and_concept_maps(self):
        emb = self.bundle(("answer", ["answer"], "exact", {"embeddingSimilarity": True}))
        for cosine, expected in ((0.76, True), (0.7599, False), (None, False)):
            result = se.score_input(score_mapping=emb, run_rows=[{"output": {"answer": "heart attack"}}],
                                    gt_headers=["answer"], gt_rows=[["myocardial infarction"]],
                                    embedding_cosines=[["heart attack", "myocardial infarction", cosine]])
            self.assertEqual(result["verifyRows"][0]["matched"], expected)
        concept = self.bundle(("answer", ["answer"], "exact", {"rxnormMatch": True}))
        concepts = {("rxnorm", "Aspirin"): {"concept_id": "1191", "source": "rxnorm"},
                    ("rxnorm", "acetylsalicylic acid"): {"concept_id": "1191", "source": "rxnorm"},
                    ("rxnorm", "cold"): {"concept_id": "1191", "status": "ambiguous"}}
        for output, expected in (("acetylsalicylic acid", True), ("cold", False), ("unknown", False)):
            result = se.score_input(score_mapping=concept, run_rows=[{"output": {"answer": output}}],
                                    gt_headers=["answer"], gt_rows=[["Aspirin"]], concept_ids=concepts)
            self.assertEqual(result["verifyRows"][0]["matched"], expected, output)

    def test_gt_only_input_and_missing_fields(self):
        mapping = self.bundle(("answer", ["answer"], "exact", {}))
        result = se.score_input(score_mapping=mapping, run_rows=[], gt_headers=["answer"], gt_rows=[["a"], ["b"]])
        self.assertEqual([(r["output"], r["gtNum"], r["matched"]) for r in result["verifyRows"]],
                         [(None, 1, False), (None, 2, False)])
        result = se.score_input(score_mapping=mapping, run_rows=[{"output": {}}], gt_headers=["answer"], gt_rows=[[None]])
        self.assertTrue(result["verifyRows"][0]["matched"])  # missing output field and empty GT cell are both ""

    def test_no_rules_and_no_code_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "No Evaluate output->gt rules configured."):
            se.score_input(score_mapping="{}", run_rows=[{"output": {"a": "b"}}], gt_headers=["a"], gt_rows=[["b"]])

    def test_code_mode_with_match_exec(self):
        code = "def match(input_row, output_row, gt_row):\n    return output_row['answer'] == gt_row['answer']\n"
        result = se.score_input(score_match_code=code, python_path=sys.executable,
                                run_rows=[{"output": {"answer": "b"}}, {"output": {"answer": "a"}}],
                                gt_headers=["answer"], gt_rows=[["a"], ["b"], ["c"]])
        self.assertEqual([(r["gtNum"], r["matched"]) for r in result["verifyRows"]], [(2, True), (1, True), (3, False)])
        self.assertEqual(result["verifyRows"][2]["gt"], {"answer": "c"})


class JsSemanticsTests(unittest.TestCase):
    def test_number_to_string(self):
        for value, text in ((1.0, "1"), (1e21, "1e+21"), (1e-7, "1e-7"), (123456789012345678901234, "1.2345678901234569e+23"),
                            (0.000001, "0.000001"), (-0.0, "0"), (2**53 + 1, "9007199254740992"), (1.5e300, "1.5e+300"),
                            (123e-20, "1.23e-18"), (100.0, "100"), (0.1 + 0.2, "0.30000000000000004")):
            self.assertEqual(se.js_number_to_string(value), text)

    def test_number_and_parse_float(self):
        self.assertEqual(se.js_to_number(""), 0)
        self.assertEqual(se.js_to_number(" 0x1F "), 31)
        self.assertNotEqual(se.js_to_number("1_0"), se.js_to_number("1_0"))  # NaN
        self.assertEqual(se.js_parse_float("﻿ 12.5e1x"), 125)
        self.assertNotEqual(se.js_parse_float("٣"), se.js_parse_float("٣"))  # NaN
        self.assertEqual(se.js_math_round(0.49999999999999994), 0)
        self.assertEqual(se.js_math_round(-2.5), -2)


if __name__ == "__main__":
    unittest.main()
