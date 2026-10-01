"""Export endpoint forwards the explicit boundary and all effective Run defaults."""
import sys
import os
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
with patch.dict(os.environ, {"LITELLM_LOCAL_MODEL_COST_MAP": "True"}):
    import main
from starlette.requests import Request


class PipelineExportApiTests(unittest.TestCase):
    def test_boundary_and_zero_retries_are_forwarded(self):
        body = main.PipelineExportRequest(name="Example", canvas_state={"nodes": []},
            route=[{"type": "dataset", "dataset_node_id": "start"}], input_dataset_ids=["start"])
        request = Request({"type": "http", "headers": []})
        with patch.object(main, "_load_settings", return_value={"run_max_retries": 0}), \
             patch.object(main, "_load_credentials", return_value=[]), \
             patch.object(main, "build_pipeline_archive", return_value=("example.zip", b"zip")) as build:
            response = main.export_python_pipeline(request, body)
        self.assertEqual(response.body, b"zip")
        self.assertEqual(build.call_args.kwargs["input_dataset_ids"], ["start"])
        self.assertEqual(build.call_args.kwargs["run_max_retries"], 0)
        self.assertEqual(response.media_type, "application/zip")

    def test_legacy_request_and_compile_error(self):
        body = main.PipelineExportRequest(canvas_state={}, route=[{"type": "dataset", "dataset_node_id": "start"}])
        self.assertIsNone(body.input_dataset_ids)
        with patch.object(main, "_load_settings", return_value={}), \
             patch.object(main, "_load_credentials", return_value=[]), \
             patch.object(main, "build_pipeline_archive", side_effect=main.PipelineExportError("missing dependency")):
            with self.assertRaises(main.HTTPException) as error:
                main.export_python_pipeline(Request({"type": "http", "headers": []}), body)
        self.assertEqual(error.exception.status_code, 400)
        self.assertIn("missing dependency", error.exception.detail)


if __name__ == "__main__":
    unittest.main()
