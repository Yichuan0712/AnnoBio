"""Regression tests for Process DataFrame outputs and named branches."""

from __future__ import annotations

import sys
import unittest

from backend.process_df_exec import run_process_df_code


class ProcessDataframeExecutionTests(unittest.TestCase):
    def run_code(self, code: str) -> dict:
        return run_process_df_code(
            sys.executable,
            code,
            ["score", "label"],
            [[0.9, "keep"], [0.2, "review"]],
        )

    def test_single_dataframe_is_returned_as_the_default_branch(self):
        outcome = self.run_code("def process(df):\n    return df[df['score'] >= 0.8]\n")
        self.assertTrue(outcome["ok"])
        self.assertEqual(outcome["outputs"], {"result": [{"score": 0.9, "label": "keep"}]})

    def test_named_dataframe_outputs_preserve_each_branch(self):
        outcome = self.run_code(
            "def process(df):\n"
            "    return {\n"
            "        'accepted': df[df['score'] >= 0.8],\n"
            "        'needs_review': df[df['score'] < 0.8],\n"
            "    }\n"
        )
        self.assertTrue(outcome["ok"])
        self.assertEqual(set(outcome["outputs"]), {"accepted", "needs_review"})
        self.assertEqual(outcome["outputs"]["accepted"][0]["label"], "keep")
        self.assertEqual(outcome["outputs"]["needs_review"][0]["label"], "review")

    def test_secondary_datasets_are_available_without_implicit_row_merge(self):
        outcome = run_process_df_code(
            sys.executable,
            "def process(df):\n    return df_reference_2.assign(primary_rows=len(df))\n",
            ["value"],
            [["primary"]],
            input_datasets={
                "df": {"headers": ["value"], "rows": [["primary"]]},
                "df_reference_2": {"headers": ["value"], "rows": [["reference"]]},
            },
            primary_dataset_id="df",
        )
        self.assertTrue(outcome["ok"])
        self.assertEqual(outcome["outputs"]["result"], [{"value": "reference", "primary_rows": 1}])

    def test_alias_from_numeric_dataset_name_is_available_to_process_code(self):
        outcome = run_process_df_code(
            sys.executable,
            "def process(df):\n    return df_13_explain_sentiment_results\n",
            ["value"],
            [["primary"]],
            input_datasets={
                "df": {"headers": ["value"], "rows": [["primary"]]},
                "df_13_explain_sentiment_results": {"headers": ["value"], "rows": [["reference"]]},
            },
            primary_dataset_id="df",
        )
        self.assertTrue(outcome["ok"])
        self.assertEqual(outcome["outputs"]["result"], [{"value": "reference"}])

    def test_non_dataframe_branch_has_a_actionable_error(self):
        outcome = self.run_code("def process(df):\n    return {'accepted': ['not a dataframe']}\n")
        self.assertFalse(outcome["ok"])
        self.assertIn('branch "accepted" must be a pandas DataFrame', outcome["error"])


if __name__ == "__main__":
    unittest.main()
