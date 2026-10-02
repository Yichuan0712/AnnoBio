"""History files survive project copy, bundle export/import, and canvas saves."""

import asyncio
import io
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi import HTTPException, UploadFile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import project_store  # noqa: E402


def record(node_id="run-1", signature="signature-1", status="completed"):
    return {
        "id": uuid.uuid4().hex,
        "nodeId": node_id,
        "kind": "run",
        "signature": signature,
        "inputs": {"prompt": "hello"},
        "status": status,
        "createdAt": 1,
        "updatedAt": 1,
        "results": [{"output": "world"}],
    }


class ProjectHistoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.patch = mock.patch.object(project_store, "PROJECTS_DIR", Path(self.tmp.name))
        self.patch.start()
        self.project_id = project_store.create_project(project_store.ProjectCreate(name="History"))["id"]

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def save(self, item, project_id=None):
        project_store.save_history_record(project_id or self.project_id, item["id"], project_store.HistoryRecordSave(record=item))

    def test_canvas_save_copy_and_bundle_round_trip_keep_history(self):
        item = record()
        self.save(item)
        state = {"historyVersion": 1, "nodes": [{"nodeId": "run-1"}, {"nodeId": "dataset-1"}],
                 "connections": [{"fromId": "run-1", "toId": "dataset-1", "type": "run-to-dataset-snapshot"}]}
        project_store.save_project(self.project_id, project_store.ProjectSave(state=state))
        session = project_store.AgentConversationsSave(
            format_version=2, activeConversationId="chat-1", conversations=[{"id": "chat-1", "messages": []}]
        )
        project_store.save_agent_conversations(self.project_id, session)
        copied = project_store.duplicate_project(self.project_id)["id"]
        self.assertEqual(project_store.get_history_record(copied, item["id"]), item)

        bundle = project_store.export_yc(self.project_id).body
        imported = asyncio.run(project_store.import_yc(UploadFile(file=io.BytesIO(bundle), filename="history.yc")))["id"]
        self.assertEqual(project_store.get_history_record(imported, item["id"]), item)
        self.assertEqual(len(project_store.get_history_index(imported)["records"]), 1)
        self.assertEqual(project_store.get_project(imported)["state"]["connections"], state["connections"])
        self.assertEqual(project_store.get_project(imported)["state"]["historyVersion"], 1)
        self.assertEqual(project_store.get_agent_conversations(imported), session.model_dump())

    def test_signature_is_unique_and_completed_record_is_immutable(self):
        item = record()
        self.save(item)
        with self.assertRaises(HTTPException) as duplicate:
            self.save(record())
        self.assertEqual(duplicate.exception.status_code, 409)

        changed = {**item, "results": [{"output": "different"}]}
        with self.assertRaises(HTTPException) as frozen:
            self.save(changed)
        self.assertEqual(frozen.exception.status_code, 409)

    def test_merge_keeps_both_history_records(self):
        first = record()
        self.save(first)
        other = project_store.create_project(project_store.ProjectCreate(name="Other"))["id"]
        second = record(node_id="run-2", signature="signature-2")
        self.save(second, other)
        project_store.merge_project(self.project_id, other)
        ids = {entry["id"] for entry in project_store.get_history_index(self.project_id)["records"]}
        self.assertEqual(ids, {first["id"], second["id"]})

    def test_asset_prune_retains_history_only_cells(self):
        item = record()
        item["inputs"] = {"dataset": {"content": {"rows": [[{"kind": "pdf", "assetIds": ["kept"]}]]}}}
        self.save(item)
        project = project_store._read_project(self.project_id)
        project["assets"] = {
            "kept": {"path": "originals/kept.pdf", "name": "kept.pdf", "bytes": 10},
            "orphan": {"path": "originals/orphan.pdf", "name": "orphan.pdf", "bytes": 20},
        }
        project_store._atomic_write_json(project_store._project_file(self.project_id), project)
        preview = project_store.prune_unused_assets(
            self.project_id, project_store.AssetPruneRequest(usedIds=[], dryRun=True)
        )
        self.assertEqual([entry["id"] for entry in preview["removed"]], ["orphan"])
        result = project_store.prune_unused_assets(
            self.project_id, project_store.AssetPruneRequest(usedIds=[], dryRun=False)
        )
        self.assertEqual([entry["id"] for entry in result["removed"]], ["orphan"])
        self.assertIn("kept", project_store._read_project(self.project_id)["assets"])

    def test_score_analysis_can_update_under_same_input_signature(self):
        item = record(node_id="score-1", signature="score-signature")
        item["kind"] = "score"
        item["inputs"] = {"runRecordId": "run-record-1"}
        item["results"] = {"scoreMatchResult": "old"}
        self.save(item)
        updated = {**item, "results": {"scoreMatchResult": "new"}}
        self.save(updated)
        self.assertEqual(project_store.get_history_record(self.project_id, item["id"])["results"], updated["results"])

    def test_delete_history_requires_exact_cascade_and_releases_assets(self):
        upstream = record()
        upstream["inputs"] = {"dataset": {"content": {"rows": [[{"kind": "pdf", "assetIds": ["old-asset"]}]]}}}
        dependent = record(node_id="process-1", signature="process-signature")
        dependent["kind"] = "process"
        dependent["sourceRecordIds"] = [upstream["id"]]
        independent = record(node_id="run-2", signature="other-signature")
        for item in (upstream, dependent, independent):
            self.save(item)
        body = project_store.HistoryDelete(record_id=upstream["id"], expected_ids=[upstream["id"]])
        with self.assertRaises(HTTPException) as mismatch:
            project_store.delete_history_records(self.project_id, body)
        self.assertEqual(mismatch.exception.status_code, 409)
        project = project_store._read_project(self.project_id)
        project["assets"] = {"old-asset": {"path": "originals/old.pdf", "name": "old.pdf", "bytes": 10}}
        project_store._atomic_write_json(project_store._project_file(self.project_id), project)
        result = project_store.delete_history_records(self.project_id, project_store.HistoryDelete(
            record_id=upstream["id"], expected_ids=[upstream["id"], dependent["id"]]
        ))
        self.assertEqual(set(result["removed"]), {upstream["id"], dependent["id"]})
        self.assertEqual([item["id"] for item in project_store.get_history_index(self.project_id)["records"]], [independent["id"]])
        prune = project_store.prune_unused_assets(self.project_id, project_store.AssetPruneRequest(usedIds=[], dryRun=True))
        self.assertEqual([item["id"] for item in prune["removed"]], ["old-asset"])


if __name__ == "__main__":
    unittest.main()
