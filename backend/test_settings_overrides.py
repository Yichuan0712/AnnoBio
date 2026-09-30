"""Per-node settings_overrides on Run and Review requests (Run settings / Review settings dialogs).

Each request may only override its own job's settings, within the same ranges Settings allows.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parent))

import main  # noqa: E402  (needs backend/ on sys.path for its own sibling imports)

_SAMPLES = [{"content": [{"type": "text", "text": "x"}]}]


def _run(**overrides):
    return main.RunRequest(credential_id="c", samples=_SAMPLES, output_schema={"fields": []}, **overrides)


class RunSettingsOverridesTest(unittest.TestCase):
    def test_missing_means_none(self):
        self.assertIsNone(_run().settings_overrides)

    def test_keeps_set_values_and_drops_nulls(self):
        req = _run(settings_overrides={"run_max_tokens": 1024, "run_concurrency": None})
        self.assertEqual(req.settings_overrides, {"run_max_tokens": 1024})

    def test_rejects_out_of_range(self):
        with self.assertRaises(ValidationError):
            _run(settings_overrides={"run_max_retries": 9})

    def test_rejects_review_keys(self):
        with self.assertRaises(ValidationError):
            _run(settings_overrides={"review_max_tokens": 1024})


class ReviewSettingsOverridesTest(unittest.TestCase):
    def test_accepts_method_knobs(self):
        req = main.ReviewRequest(credential_id="c", prompt_sections=[], settings_overrides={"gepa_max_iterations": 20, "copro_depth": 2})
        self.assertEqual(req.settings_overrides, {"gepa_max_iterations": 20, "copro_depth": 2})

    def test_rejects_run_keys(self):
        with self.assertRaises(ValidationError):
            main.ReviewRequest(credential_id="c", prompt_sections=[], settings_overrides={"run_concurrency": 2})


if __name__ == "__main__":
    unittest.main()
