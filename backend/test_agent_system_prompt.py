"""The Agent's system prompt with and without a project open."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from agent.system_prompt import NO_PROJECT_SECTION, build_system_prompt  # noqa: E402


class AgentSystemPromptTest(unittest.TestCase):
    def test_project_open_is_the_default_and_adds_nothing(self):
        prompt = build_system_prompt("Pipelines: none", "Goal: extract sites")
        self.assertEqual(prompt, build_system_prompt("Pipelines: none", "Goal: extract sites", project_open=True))
        self.assertNotIn("# No project is open", prompt)

    def test_no_project_section_comes_before_the_workspace(self):
        prompt = build_system_prompt("No project is open.", project_open=False)
        self.assertIn(NO_PROJECT_SECTION, prompt)
        self.assertLess(prompt.index("# No project is open"), prompt.index("# Current workspace"))
        self.assertTrue(prompt.rstrip().endswith("No project is open."))


if __name__ == "__main__":
    unittest.main()
