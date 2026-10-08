"""The Process outputs endpoint returns the static detection result."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
with patch.dict(os.environ, {"LITELLM_LOCAL_MODEL_COST_MAP": "True"}):
    import main


class ProcessOutputsApiTests(unittest.TestCase):
    def test_endpoint_returns_detected_branches(self):
        body = main.ProcessOutputsRequest(code="def process(df):\n    return {'kept': df, 'dropped': df}\n")
        self.assertEqual(main.detect_process_outputs_endpoint(body), {"ok": True, "ports": ["kept", "dropped"], "dynamic": False})

    def test_endpoint_reports_unreadable_code_without_raising(self):
        outcome = main.detect_process_outputs_endpoint(main.ProcessOutputsRequest(code="def process(df:\n"))
        self.assertFalse(outcome["ok"])
        self.assertTrue(outcome["error"].startswith("SyntaxError:"))

    def test_missing_code_is_treated_as_empty(self):
        self.assertEqual(main.detect_process_outputs_endpoint(main.ProcessOutputsRequest()),
                         {"ok": False, "error": "No top-level process() function"})


if __name__ == "__main__":
    unittest.main()
