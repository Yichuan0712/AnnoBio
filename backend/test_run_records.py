"""Run to here records (Executions) are kept with a web project: canvas saves, copy, merge, bundle export/import."""

import asyncio
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import UploadFile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import project_store  # noqa: E402


def run_record(record_id, target="run-1"):
    return {"id": record_id, "createdAt": 1, "updatedAt": 2, "source": "user", "targetNodeId": target,
            "targetName": "Extract", "status": "completed", "inputs": [],
            "steps": [{"nodeId": target, "name": "Extract", "kind": "run", "action": "run", "status": "completed"}]}


class RunRecordsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.patch = mock.patch.object(project_store, "PROJECTS_DIR", Path(self.tmp.name))
        self.patch.start()
        self.project_id = project_store.create_project(project_store.ProjectCreate(name="Runs"))["id"]

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def save(self, records, project_id=None):
        project_store.save_run_records(project_id or self.project_id, project_store.RunRecordsSave(records=records))

    def test_a_new_project_has_none_and_saved_records_come_back(self):
        self.assertEqual(project_store.get_run_records(self.project_id), {"records": []})
        self.save([run_record("a")])
        self.assertEqual(project_store.get_run_records(self.project_id)["records"], [run_record("a")])

    def test_canvas_saves_keep_them_and_copy_export_import_carry_them(self):
        self.save([run_record("a")])
        project_store.save_project(self.project_id, project_store.ProjectSave(state={"nodes": [{"nodeId": "run-1"}]}))
        self.assertEqual(project_store.get_run_records(self.project_id)["records"], [run_record("a")])

        copied = project_store.duplicate_project(self.project_id)["id"]
        self.assertEqual(project_store.get_run_records(copied)["records"], [run_record("a")])

        bundle = project_store.export_yc(self.project_id).body
        imported = asyncio.run(project_store.import_yc(UploadFile(file=io.BytesIO(bundle), filename="runs.yc")))["id"]
        self.assertEqual(project_store.get_run_records(imported)["records"], [run_record("a")])

    def test_merge_adds_the_source_records_it_does_not_have(self):
        self.save([run_record("a")])
        source = project_store.create_project(project_store.ProjectCreate(name="Other"))["id"]
        project_store.save_project(source, project_store.ProjectSave(state={"nodes": [{"nodeId": "run-2"}]}))
        self.save([run_record("a"), run_record("b", "run-2")], source)
        project_store.merge_project(self.project_id, source)
        self.assertEqual([record["id"] for record in project_store.get_run_records(self.project_id)["records"]], ["a", "b"])


if __name__ == "__main__":
    unittest.main()
