import json
import unittest
from unittest.mock import patch

import main


class RunJobRecoveryTests(unittest.TestCase):
    def test_restarting_backend_stops_orphaned_run_and_preserves_progress(self):
        payload = {
            "jobs": {
                "running-id": {
                    "status": "running",
                    "run_node_id": "node-1",
                    "completed": 1,
                    "total": 2,
                    "results": [{"row_index": 0, "output": {"label": "positive"}, "error": None}],
                    "output_fields": [{"key": "label", "display": "label"}],
                },
                "done-id": {"status": "done", "run_node_id": "node-2", "results": []},
            },
            "by_node": {"node-1": "running-id", "node-2": "done-id"},
        }
        with patch.object(main, "RUN_JOBS_FILE") as job_file, \
             patch.object(main, "_persist_run_jobs") as persist, \
             patch.object(main, "_run_jobs", {}), \
             patch.object(main, "_run_jobs_by_node", {}), \
             patch.object(main, "_run_last_activity", {}):
            job_file.exists.return_value = True
            job_file.read_text.return_value = json.dumps(payload)
            main._load_run_jobs()

            response = main.get_run_result_by_node("node-1")
            self.assertEqual(response["status"], "cancelled")
            self.assertEqual(response["completed"], 1)
            self.assertEqual(response["total"], 2)
            self.assertEqual(response["results"][0]["output"], {"label": "positive"})
            self.assertIn("backend restarted", response["error"])
            self.assertEqual(main._run_jobs["done-id"]["status"], "done")
            persist.assert_called_once()


if __name__ == "__main__":
    unittest.main()
