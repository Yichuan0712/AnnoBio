"""Pipeline runner endpoints forward project ownership and preserve HTTP error semantics."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
with patch.dict(os.environ, {"LITELLM_LOCAL_MODEL_COST_MAP": "True"}):
    import main


class PipelineRunnerApiTests(unittest.TestCase):
    def test_compile_and_start_forward_frozen_request(self):
        runner = Mock()
        runner.compile.return_value = {"spec": {"format_version": 1}, "diagnostics": []}
        runner.start.return_value = {"run_id": "abc", "status": "pending"}
        runner.revise.return_value = {"run_id": "def", "status": "pending", "revision": 2}
        compile_body = main.PipelineCompileRequest(
            canvas_state={"nodes": []}, route=[{"type": "dataset", "dataset_node_id": "raw"}],
            input_dataset_ids=["raw"],
        )
        start_body = main.PipelineStartRequest(
            project_id="project-a", project_session_id="assets-a", request_id="request-a",
            canvas_state=compile_body.canvas_state, route=compile_body.route, input_dataset_ids=["raw"],
        )
        with patch.object(main, "_get_pipeline_runner", return_value=runner):
            compiled = main.compile_current_pipeline(compile_body)
            response = main.start_pipeline_run(start_body)
            revision = main.revise_pipeline_run("abc", start_body)
        self.assertEqual(compiled["spec"]["format_version"], 1)
        self.assertEqual(response.status_code, 202)
        self.assertEqual(runner.start.call_args.kwargs["project_id"], "project-a")
        self.assertEqual(runner.start.call_args.kwargs["project_session_id"], "assets-a")
        self.assertEqual(runner.start.call_args.kwargs["request_id"], "request-a")
        self.assertEqual(runner.start.call_args.kwargs["input_dataset_ids"], ["raw"])
        self.assertEqual(revision.status_code, 202)
        self.assertEqual(runner.revise.call_args.args[:2], ("project-a", "abc"))

    def test_status_cancel_resume_results_and_error_mapping(self):
        runner = Mock()
        runner.status.return_value = {"status": "running"}
        runner.cancel.return_value = {"status": "cancelling"}
        runner.resume.return_value = {"status": "pending"}
        runner.results.return_value = {"outputs": []}
        with patch.object(main, "_get_pipeline_runner", return_value=runner):
            self.assertEqual(main.get_pipeline_run("run-a", "project-a")["status"], "running")
            self.assertEqual(main.cancel_pipeline_run("run-a", "project-a")["status"], "cancelling")
            resumed = main.resume_pipeline_run(
                "run-a", main.PipelineResumeRequest(project_id="project-a", project_session_id="fresh"),
            )
            self.assertEqual(resumed.status_code, 202)
            self.assertEqual(main.get_pipeline_run_results(
                "run-a", "project-a", "dataset:out", False,
            )["outputs"], [])
        runner.status.side_effect = main.PipelineRunNotFound("missing")
        with patch.object(main, "_get_pipeline_runner", return_value=runner):
            with self.assertRaises(main.HTTPException) as caught:
                main.get_pipeline_run("missing", "project-a")
        self.assertEqual(caught.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
