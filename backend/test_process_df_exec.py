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

    def test_non_dataframe_branch_has_a_actionable_error(self):
        outcome = self.run_code("def process(df):\n    return {'accepted': ['not a dataframe']}\n")
        self.assertFalse(outcome["ok"])
        self.assertIn('branch "accepted" must be a pandas DataFrame', outcome["error"])


if __name__ == "__main__":
    unittest.main()
