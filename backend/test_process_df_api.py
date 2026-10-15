"""A single-node Process run returns each branch's columns, so a branch without rows keeps them."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
with patch.dict(os.environ, {"LITELLM_LOCAL_MODEL_COST_MAP": "True"}):
    import main


class ProcessDfRunResultTests(unittest.TestCase):
    def test_empty_branch_keeps_its_columns(self):
        body = main.ProcessDfRunRequest(
            python_path=sys.executable,
            code="def process(df):\n    return {'kept': df, 'dropped': df[df['label'] == 'none']}\n",
            input_datasets={"df": {"headers": ["text", "label"], "rows": [["a", "pos"]]}},
            primary_dataset_id="df",
        )
        with patch.object(main, "_persist_process_df_jobs"):
            main._do_process_df_work("test-empty-branch", body)
        try:
            result = main.get_process_df_run_result("test-empty-branch")
        finally:
            main._process_df_jobs.pop("test-empty-branch", None)
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["outputs"]["dropped"], [])
        self.assertEqual(result["output_columns"], {"kept": ["text", "label"], "dropped": ["text", "label"]})

    def test_older_jobs_without_columns_still_read(self):
        main._process_df_jobs["test-old-job"] = {"status": "done", "outputs": {"result": [{"a": 1}]}}
        try:
            result = main.get_process_df_run_result("test-old-job")
        finally:
            main._process_df_jobs.pop("test-old-job", None)
        self.assertEqual(result, {"status": "done", "outputs": {"result": [{"a": 1}]}, "output_columns": {}})


if __name__ == "__main__":
    unittest.main()
