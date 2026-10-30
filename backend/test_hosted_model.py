"""Hosted identity stays virtual and unmodifiable; desktop behavior is unchanged."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import main
import hosted_model
from fastapi.testclient import TestClient


class HostedBackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        for patch in (mock.patch.object(main, "DATA_DIR", self.data),
                      mock.patch.object(main, "CREDENTIALS_FILE", self.data / "credentials.json"),
                      mock.patch.object(main, "SETTINGS_FILE", self.data / "settings.json"),
                      mock.patch.dict(os.environ, {"ANNOBIO_HOSTED_MODE": "1", "ANNOBIO_HOSTED_TOKEN": "account-scoped-token", "ANNOBIO_HOSTED_GATEWAY_URL": "http://hub:8080/internal/hosted-model"})):
            patch.start(); self.addCleanup(patch.stop)
        self.client = TestClient(main.app)
        self.stored = [{"id": "local", "model": "local-model", "provider": "openai", "api_key": "user-local-key"},
                       {"id": "router", "model": "user-model", "provider": "openrouter", "api_key": "user-router-key"}]
        main.CREDENTIALS_FILE.write_text(json.dumps(self.stored))

    def test_virtual_model_is_default_and_returns_no_provider_key_or_private_route(self):
        response = self.client.get("/api/credentials")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["id"] for item in response.json()], ["annobio-free", "router"])
        builtin = response.json()[0]
        self.assertTrue(builtin["builtin"])
        self.assertTrue(builtin["last_check_ok"])
        self.assertTrue(builtin["agent_check_ok"])
        self.assertEqual(self.client.get("/api/credentials/annobio-free").json()["api_key"], "")
        for key in ("default_run_credential_id", "default_review_credential_id", "default_agent_credential_id"):
            self.assertEqual(self.client.get("/api/settings").json()[key], "annobio-free")
        self.assertNotIn("account-scoped-token", response.text)
        self.assertNotIn("deepseek", response.text.lower())
        self.assertNotIn("/internal/", response.text)

    def test_managed_model_cannot_be_deleted_tested_or_revealed(self):
        self.assertEqual(self.client.delete("/api/credentials/annobio-free").status_code, 403)
        self.assertEqual(self.client.post("/api/credentials/annobio-free/test").status_code, 403)
        self.assertEqual(self.client.post("/api/credentials/annobio-free/agent-check").status_code, 403)
        self.assertEqual(self.client.get("/api/credentials/annobio-free/run-params").json(), {"params": []})

    def test_task_resolution_is_private_and_different_for_each_purpose(self):
        generate = main._pipeline_credential("annobio-free")
        agent, _ = main._resolve_chat_credential("annobio-free")
        optimize = main._credential_for_task(hosted_model.credential(), "optimize")
        for role, item in (("generate", generate), ("agent", agent), ("optimize", optimize)):
            self.assertTrue(item["base_url"].endswith(f"/{role}/v1"))
            self.assertEqual(item["api_key"], "account-scoped-token")
            self.assertEqual(item["provider"], "openai")

    def test_web_rejects_litellm_and_does_not_erase_old_local_credentials(self):
        payload = {"model": "anything", "api_key": "test-only", "provider": "openai"}
        self.assertEqual(self.client.post("/api/credentials", json=payload).status_code, 403)
        self.assertEqual(self.client.post("/api/credentials/detect", json=payload).status_code, 403)
        self.assertEqual(self.client.get("/api/credentials/litellm/catalog").status_code, 403)
        payload["provider"] = "openrouter"
        self.assertEqual(self.client.post("/api/credentials", json=payload).status_code, 200)
        stored = json.loads(main.CREDENTIALS_FILE.read_text())
        self.assertIn("local", [item["id"] for item in stored])
        self.assertNotIn("annobio-free", [item["id"] for item in stored])

    def test_desktop_has_no_managed_identity_or_restriction(self):
        with mock.patch.dict(os.environ, {"ANNOBIO_HOSTED_MODE": "0"}):
            self.assertEqual([item["id"] for item in self.client.get("/api/credentials").json()], ["local", "router"])
            self.assertEqual(self.client.get("/api/hosted-model").json(), {"enabled": False})
            self.assertFalse(self.client.get("/api/settings").json()["default_run_credential_id"])


if __name__ == "__main__":
    unittest.main()
