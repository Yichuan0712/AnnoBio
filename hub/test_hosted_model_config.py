"""Private credential configuration and provider routing, without paid API calls."""
import json
import os
import unittest
from unittest import mock

import httpx
from hub import hosted_model_config as config
from hub import model_providers


class ModelConfigurationTests(unittest.TestCase):
    def setUp(self):
        environment = mock.patch.dict(os.environ, {}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

    def test_roles_select_independent_credentials_and_keys(self):
        credentials = {
            "ds": {"provider": "deepseek", "model": "deepseek-reasoner", "api_key_env": "DS_TEST_KEY"},
            "router": {"provider": "openrouter", "model": "vendor/task-model", "api_key_env": "ROUTER_TEST_KEY"},
            "claude": {"provider": "anthropic", "model": "claude-test", "api_key_env": "CLAUDE_TEST_KEY"},
        }
        roles = {"generate": "ds", "optimize": "router", "agent": "claude"}
        with mock.patch.dict(config.MODEL_CREDENTIALS, credentials, clear=True), mock.patch.dict(config.ROLE_MODELS, roles, clear=True), mock.patch.dict(os.environ, {"DS_TEST_KEY": "ds-key", "ROUTER_TEST_KEY": "router-key", "CLAUDE_TEST_KEY": "claude-key"}):
            generate = config.credential_for_role("generate")
            optimize = config.credential_for_role("optimize")
            agent = config.credential_for_role("agent")
            self.assertEqual((generate["provider"], generate["api_key"], generate["tokenizer"]), ("deepseek", "ds-key", "deepseek"))
            self.assertEqual((optimize["provider"], optimize["base_url"], optimize["api_key"], optimize["tokenizer"]), ("openrouter", "https://openrouter.ai/api/v1", "router-key", "cl100k_base"))
            self.assertEqual((agent["provider"], agent["model"], agent["api_key"]), ("anthropic", "claude-test", "claude-key"))
            config.MODEL_CREDENTIALS["router"] = {**credentials["router"], "model": "vendor/replacement"}
            self.assertEqual(config.credential_for_role("optimize")["model"], "vendor/replacement")
            self.assertEqual(config.credential_for_role("generate")["model"], "deepseek-reasoner")

    def test_missing_named_key_never_falls_back_to_another_provider_key(self):
        with mock.patch.dict(os.environ, {"ANNOBIO_HOSTED_API_KEY": "deepseek-platform-key"}), mock.patch.dict(config.MODEL_CREDENTIALS, {"router": {"provider": "openrouter", "model": "vendor/model", "api_key_env": "MISSING_ROUTER_KEY"}}), mock.patch.dict(config.ROLE_MODELS, {"agent": "router"}):
            self.assertEqual(config.credential_for_role("agent")["api_key"], "")

    def test_legacy_environment_and_custom_endpoints_still_work(self):
        with mock.patch.dict(os.environ, {"ANNOBIO_HOSTED_API_KEY": "test-key", "ANNOBIO_HOSTED_AGENT_MODEL": "private-model", "ANNOBIO_HOSTED_API_BASE": "https://private.test/v1/"}):
            item = config.credential_for_role("agent")
            self.assertEqual((item["model"], item["base_url"], item["api_key"]), ("private-model", "https://private.test/v1", "test-key"))
        with mock.patch.dict(config.MODEL_CREDENTIALS, {"custom": {"provider": "openai", "model": "private-model", "base_url": "https://other.test/v1", "api_key_env": "CUSTOM_KEY"}}), mock.patch.dict(config.ROLE_MODELS, {"generate": "custom"}):
            self.assertEqual(config.credential_for_role("generate")["base_url"], "https://other.test/v1")

    def test_invalid_provider_and_unselected_credentials_fail_closed(self):
        with mock.patch.dict(config.MODEL_CREDENTIALS, {"broken": {"provider": "invalid", "model": "x"}}), mock.patch.dict(config.ROLE_MODELS, {"agent": "broken"}):
            with self.assertRaises(ValueError):
                config.credential_for_role("agent")
        with self.assertRaises(ValueError):
            config.credential_for_role("invalid")

    def test_generic_tokenizer_admits_normal_agent_sized_text_without_a_byte_count_limit(self):
        from hub.hosted_model import input_reservation
        prompt = {"messages": [{"role": "user", "content": "word " * 20000}]}
        reservation = input_reservation(prompt, "cl100k_base")
        self.assertGreater(len(json.dumps(prompt).encode()), 100000)
        self.assertGreater(reservation, 20000)
        self.assertLess(reservation + 8192, 50000)


class ProviderTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_compatible_providers_keep_their_own_keys_and_urls(self):
        real_client = httpx.AsyncClient
        observed = []
        def provider(request):
            observed.append((str(request.url), request.headers["authorization"], json.loads(request.content)))
            return httpx.Response(200, json={"model": "private-model", "choices": []})
        with mock.patch.object(model_providers.httpx, "AsyncClient", side_effect=lambda **_: real_client(transport=httpx.MockTransport(provider))):
            for name in ("openai", "openrouter", "deepseek"):
                credential = {"provider": name, "base_url": f"https://{name}.test/v1", "api_key": name + "-key", "model": "private-model"}
                payload = {"model": "private-model", "messages": [{"role": "assistant", "content": "previous", "reasoning_content": "prior reasoning"}]}
                response, client = await model_providers.open_completion(credential, payload)
                await response.aread()
                await response.aclose(); await client.aclose()
        self.assertEqual([url for url, _, _ in observed], [f"https://{name}.test/v1/chat/completions" for name in ("openai", "openrouter", "deepseek")])
        self.assertEqual([key for _, key, _ in observed], ["Bearer " + name + "-key" for name in ("openai", "openrouter", "deepseek")])
        self.assertNotIn("reasoning_content", observed[0][2]["messages"][0])
        self.assertIn("reasoning_content", observed[-1][2]["messages"][0])

    async def test_native_providers_use_desktop_prefixes_and_disable_hidden_retries(self):
        import litellm
        payload = {"model": "private-model", "messages": [{"role": "user", "content": "Hello"}], "max_tokens": 100, "stream": False}
        with mock.patch.object(litellm, "acompletion", new_callable=mock.AsyncMock, return_value={"model": "private-model", "choices": [], "usage": {"total_tokens": 12}}) as call:
            for provider in ("anthropic", "gemini", "bedrock"):
                credential = {"provider": provider, "model": "private-model", "api_key": provider + "-key", "base_url": ""}
                response, client = await model_providers.open_completion(credential, payload)
                self.assertEqual(call.call_args.kwargs["model"], provider + "/private-model")
                self.assertEqual(call.call_args.kwargs["api_key"], provider + "-key")
                self.assertEqual(call.call_args.kwargs["num_retries"], 0)
                self.assertEqual(json.loads(await response.aread())["usage"]["total_tokens"], 12)
                await response.aclose(); await client.aclose()

    async def test_native_stream_preserves_tools_and_usage_and_is_closed(self):
        import litellm
        closed = mock.Mock()
        async def stream():
            try:
                yield {"model": "private", "choices": [{"delta": {"tool_calls": [{"id": "call-1"}]}}]}
                yield {"model": "private", "choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 20}}
            finally:
                closed()
        with mock.patch.object(litellm, "acompletion", new_callable=mock.AsyncMock, return_value=stream()):
            response, client = await model_providers.open_completion({"provider": "anthropic", "model": "private", "api_key": "test-key", "base_url": ""}, {"model": "private", "messages": [], "stream": True, "stream_options": {"include_usage": True}})
            lines = [line async for line in response.aiter_lines()]
            await response.aclose(); await client.aclose()
        self.assertTrue(any("tool_calls" in line for line in lines))
        self.assertTrue(any('"completion_tokens": 20' in line for line in lines))
        self.assertIn("data: [DONE]", lines)
        closed.assert_called_once()


if __name__ == "__main__":
    unittest.main()
