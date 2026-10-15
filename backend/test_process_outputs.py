"""Static detection of the output branches Process code returns."""

from __future__ import annotations

import textwrap
import unittest

from backend.process_outputs import BRANCH_NAME_ERROR, detect_process_outputs


def detect(code: str) -> dict:
    return detect_process_outputs(textwrap.dedent(code))


def known(*ports: str) -> dict:
    return {"ok": True, "ports": list(ports), "dynamic": False}


DYNAMIC = {"ok": True, "ports": [], "dynamic": True}


class ProcessOutputDetectionTests(unittest.TestCase):
    def test_a_returned_dataframe_is_the_single_result_output(self):
        self.assertEqual(detect("""
            def process(df):
                return df[df["score"] > 0.5]
        """), known("result"))

    def test_a_returned_dict_names_one_output_per_key(self):
        self.assertEqual(detect("""
            def process(df):
                return {"accepted": df, "needs_review": df.head(0)}
        """), known("accepted", "needs_review"))

    def test_several_dict_returns_combine_their_branches_in_source_order(self):
        self.assertEqual(detect("""
            def process(df):
                if df.empty:
                    return {"empty": df}
                return {"kept": df, "empty": df.head(0)}
        """), known("empty", "kept"))

    def test_returns_of_nested_helpers_lambdas_and_classes_are_ignored(self):
        self.assertEqual(detect("""
            def process(df):
                def label(value):
                    return {"not": "a branch"}
                class Helper:
                    def run(self):
                        return 1
                key = lambda row: {"also": "ignored"}
                return {"labelled": df.assign(label=df["x"].map(label))}
        """), known("labelled"))

    def test_mixing_a_dataframe_and_a_dict_is_dynamic(self):
        self.assertEqual(detect("""
            def process(df):
                if df.empty:
                    return df
                return {"kept": df}
        """), DYNAMIC)

    def test_dict_comprehension_is_dynamic(self):
        self.assertEqual(detect("""
            def process(df):
                return {name: group for name, group in df.groupby("kind")}
        """), DYNAMIC)

    def test_dict_unpacking_is_dynamic(self):
        self.assertEqual(detect("""
            def process(df):
                extra = {"b": df}
                return {"a": df, **extra}
        """), DYNAMIC)

    def test_non_constant_key_is_dynamic(self):
        self.assertEqual(detect("""
            def process(df):
                name = "kept"
                return {name: df}
        """), DYNAMIC)

    def test_conditional_expression_of_two_dicts_combines_both(self):
        self.assertEqual(detect("""
            def process(df):
                return {"a": df} if len(df) else {"b": df}
        """), known("a", "b"))

    def test_conditional_expression_of_dict_and_dataframe_is_dynamic(self):
        self.assertEqual(detect("""
            def process(df):
                return {"a": df} if len(df) else df
        """), DYNAMIC)

    def test_branch_names_are_stripped_and_deduplicated(self):
        self.assertEqual(detect("""
            def process(df):
                if df.empty:
                    return {" kept ": df}
                return {"kept": df, "dropped": df}
        """), known("kept", "dropped"))

    def test_empty_or_non_string_branch_names_are_errors(self):
        for key in ('"   "', "1"):
            with self.subTest(key=key):
                self.assertEqual(detect(f"""
                    def process(df):
                        return {{{key}: df}}
                """), {"ok": False, "error": BRANCH_NAME_ERROR})

    def test_syntax_error_reports_its_line(self):
        outcome = detect("""
            def process(df):
                return {"a": df
        """)
        self.assertFalse(outcome["ok"])
        self.assertTrue(outcome["error"].startswith("SyntaxError:"))
        self.assertIn("(line ", outcome["error"])

    def test_code_without_a_top_level_process_is_an_error(self):
        for code in ("", "def other(df):\n    return df\n", "class A:\n    def process(self, df):\n        return df\n"):
            with self.subTest(code=code):
                self.assertEqual(detect_process_outputs(code), {"ok": False, "error": "No top-level process() function"})

    def test_the_last_top_level_process_is_the_one_python_calls(self):
        self.assertEqual(detect("""
            def process(df):
                return {"old": df}

            def process(df):
                return {"new": df}
        """), known("new"))

    def test_async_process_is_read_the_same_way(self):
        self.assertEqual(detect("""
            async def process(df):
                return {"a": df}
        """), known("a"))

    def test_a_function_without_return_value_is_the_single_result_output(self):
        self.assertEqual(detect("""
            def process(df):
                print(df)
        """), known("result"))

    def test_check_uniprot_availability_style_code(self):
        self.assertEqual(detect("""
            import pandas as pd

            def process(df):
                def uniprot_candidates(name):
                    if not name:
                        return []
                    candidates = []
                    for item in lookup(name):
                        candidates.append({"accession": item["primaryAccession"]})
                    return candidates

                out = df.copy()
                out["kinase_candidates"] = out["kinase"].map(uniprot_candidates)
                has_candidates = out["kinase_candidates"].map(bool)
                return {
                    "ready_for_uniprot_matching": out.loc[has_candidates].reset_index(drop=True),
                    "needs_name_rewrite": out.loc[~has_candidates].reset_index(drop=True),
                }
        """), known("ready_for_uniprot_matching", "needs_name_rewrite"))

    def test_resolve_chosen_accessions_style_code(self):
        self.assertEqual(detect("""
            def process(df):
                out = df.copy()

                def pick(block, index):
                    lines = [line for line in str(block).splitlines() if line.strip()]
                    position = int(float(index))
                    return lines[position] if 0 <= position < len(lines) else ""

                def accession(line):
                    parts = [part.strip() for part in str(line).split("|")]
                    return parts[1] if len(parts) > 1 else ""

                out["kinase_accession"] = [accession(pick(b, i)) for b, i in zip(df["a"], df["b"])]
                has_full_text = out["FullText"].fillna("").astype(str).str.strip().ne("")
                return {
                    "needs_full_text_site_extraction": out.loc[has_full_text].reset_index(drop=True),
                    "missing_full_text": out.loc[~has_full_text].reset_index(drop=True),
                }
        """), known("needs_full_text_site_extraction", "missing_full_text"))

    def test_uniprot_search_style_code_with_a_string_returning_helper(self):
        self.assertEqual(detect("""
            def process(df):
                def candidates(name):
                    lines = [f"{i}. {hit}" for i, hit in enumerate(search(name))]
                    return "\\n".join(lines)
                out = df.copy()
                out["kinase_candidates"] = out["kinase"].map(candidates)
                return out
        """), known("result"))


if __name__ == "__main__":
    unittest.main()
