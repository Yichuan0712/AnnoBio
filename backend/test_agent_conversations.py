"""Agent chats from before any project is open are stored apart from every project."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import project_store  # noqa: E402


def session(*titles):
    return project_store.AgentConversationsSave(
        format_version=2,
        activeConversationId="chat-1",
        conversations=[{"id": f"chat-{i}", "title": title, "messages": []} for i, title in enumerate(titles, 1)],
    )


class GlobalAgentConversationsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.patches = [
            mock.patch.object(project_store, "PROJECTS_DIR", root / "projects"),
            mock.patch.object(project_store, "AGENT_CONVERSATIONS_FILE", root / "agent_conversations.json"),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.tmp.cleanup()

    def test_empty_before_the_first_save(self):
        self.assertEqual(project_store.load_global_agent_conversations(), {"activeConversationId": "", "conversations": []})

    def test_round_trip(self):
        project_store.save_global_agent_conversations(session("Plan a pipeline"))
        self.assertEqual(project_store.load_global_agent_conversations(), session("Plan a pipeline").model_dump())

    def test_kept_apart_from_projects(self):
        project_id = project_store.create_project(project_store.ProjectCreate(name="A"))["id"]
        project_store.save_agent_conversations(project_id, session("In the project"))
        project_store.save_global_agent_conversations(session("Before any project"))
        self.assertEqual(project_store.get_agent_conversations(project_id)["conversations"][0]["title"], "In the project")
        self.assertEqual(project_store.load_global_agent_conversations()["conversations"][0]["title"], "Before any project")


if __name__ == "__main__":
    unittest.main()
