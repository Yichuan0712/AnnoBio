"""No provider calls: exercise accounting, task routing, streaming and cancellation."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import httpx
from hub import hosted_model_config as model_config

spec = importlib.util.spec_from_file_location("hub.hosted_model_tests_target", Path(__file__).with_name("hosted_model.py"))
gateway = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gateway
spec.loader.exec_module(gateway)


class HostedAccountingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = mock.patch.object(gateway, "DB_PATH", Path(self.temp.name) / "usage.db")
        self.path.start(); self.addCleanup(self.path.stop)
        self.environment = mock.patch.dict(os.environ, {"PROMPT_STUDIO_SESSION_SECRET": "unit-test-secret", "ANNOBIO_HOSTED_DAILY_TOKENS": "50000"})
        self.environment.start(); self.addCleanup(self.environment.stop)

    def test_tokens_are_account_scoped_and_forgery_is_rejected(self):
        token = gateway.account_token(7)
        self.assertEqual(gateway.account_from_token(token), 7)
        for invalid in (token.replace("7.", "8.", 1), token + "bad", "not-a-token", "-1.invalid"):
            with self.assertRaises(Exception):
                gateway.account_from_token(invalid)

    def test_concurrent_reservations_cannot_spend_the_same_allowance(self):
        def attempt(_):
            try:
                return gateway.reserve(1, 100, 900)[0]
            except gateway.QuotaExceeded:
                return None
        with ThreadPoolExecutor(max_workers=12) as workers:
            reservations = list(workers.map(attempt, range(65)))
        self.assertEqual(len([item for item in reservations if item]), 50)
        self.assertEqual(gateway.usage(1)["remaining"], 0)
        self.assertEqual(gateway.usage(2)["remaining"], 50000)

    def test_actual_usage_releases_unused_reservation_and_settles_once(self):
        reservation, _ = gateway.reserve(1, 2000, 8000)
        gateway.settle(reservation, 1200)
        gateway.settle(reservation, 30000)
        self.assertEqual(gateway.usage(1)["used"], 1200)
        self.assertEqual(gateway.usage(1)["remaining"], 48800)
        self.assertEqual(gateway.usage(1)["reserved"], 0)

    def test_unknown_usage_is_conservative_rejection_is_free_and_new_day_resets(self):
        first, _ = gateway.reserve(1, 1000, 2000)
        gateway.settle(first, None)
        second, _ = gateway.reserve(1, 1000, 2000)
        gateway.settle(second, None, rejected=True)
        self.assertEqual(gateway.usage(1)["used"], 3000)
        self.assertEqual(gateway.usage(1)["estimated"], 3000)
        with mock.patch.object(gateway, "day_key", return_value="2099-01-01"):
            self.assertEqual(gateway.usage(1)["remaining"], 50000)

    def test_output_is_clamped_to_available_allowance(self):
        reservation, _ = gateway.reserve(1, 1000, 48000)
        gateway.settle(reservation, 49000)
        _, maximum = gateway.reserve(1, 800, 8000)
        self.assertEqual(maximum, 200)
        with self.assertRaises(gateway.QuotaExceeded):
            gateway.reserve(1, 1, 1)

    def test_tokenizer_counts_large_text_as_tokens_instead_of_bytes(self):
        from tokenizers import Tokenizer, models, pre_tokenizers
        tokenizer = Tokenizer(models.WordLevel({"[UNK]": 0, "word": 1}, unk_token="[UNK]"))
        tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
        path = Path(self.temp.name) / "tokenizer.json"
        tokenizer.save(str(path))
        body = {"messages": [{"role": "user", "content": "word " * 20000}]}
        with mock.patch.dict(os.environ, {"ANNOBIO_HOSTED_TOKENIZER_MODEL": "deepseek", "ANNOBIO_HOSTED_TOKENIZER_PATH": str(path)}):
            bound = gateway.input_reservation(body)
        self.assertGreater(len(json.dumps(body).encode()), 100000)
        self.assertGreater(bound, 20000)
        self.assertLess(bound, 30000)
        _, maximum = gateway.reserve(1, bound, 8192)
        self.assertEqual(maximum, 8192)


class HostedGatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        patch = mock.patch.object(gateway, "DB_PATH", Path(self.temp.name) / "usage.db")
        patch.start(); self.addCleanup(patch.stop)
        env = mock.patch.dict(os.environ, {"ANNOBIO_HOSTED_API_KEY": "platform-secret", "ANNOBIO_HOSTED_DAILY_TOKENS": "50000", "ANNOBIO_HOSTED_GENERATE_MODEL": "private-generate", "ANNOBIO_HOSTED_OPTIMIZE_MODEL": "private-optimize", "ANNOBIO_HOSTED_AGENT_MODEL": "private-agent", "ANNOBIO_HOSTED_TOKENIZER_MODEL": "bytes"})
        env.start(); self.addCleanup(env.stop)
        auth = mock.patch.object(gateway, "authenticated_account", return_value=1)
        auth.start(); self.addCleanup(auth.stop)
        self.real_client = httpx.AsyncClient

    def client_patch(self, handler):
        return mock.patch.object(gateway.httpx, "AsyncClient", side_effect=lambda **_: self.real_client(transport=httpx.MockTransport(handler)))

    def request(self, **overrides):
        body = {"messages": [{"role": "user", "content": "Hello"}], "max_tokens": 100, **overrides}
        return SimpleNamespace(body=mock.AsyncMock(return_value=json.dumps(body).encode()))

    async def test_all_three_tasks_use_private_mapping_and_one_shared_budget(self):
        calls = []
        def provider(request):
            data = json.loads(request.content)
            calls.append(data)
            self.assertEqual(request.headers["authorization"], "Bearer platform-secret")
            self.assertNotIn("api_key", data)
            return httpx.Response(200, json={"model": data["model"], "choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 40, "completion_tokens_details": {"reasoning_tokens": 30}}})
        with self.client_patch(provider):
            for role in ("generate", "optimize", "agent"):
                response = await gateway.completion(role, self.request(model="spoofed-model", api_key="attacker-key", base_url="http://attacker"))
                self.assertEqual(response.status_code, 200)
                self.assertEqual(json.loads(response.body)["model"], "annobio-free")
                self.assertNotIn(b"private-", response.body)
                self.assertNotIn(b"platform-secret", response.body)
        self.assertEqual([call["model"] for call in calls], ["private-generate", "private-optimize", "private-agent"])
        self.assertEqual(gateway.usage(1)["used"], 420)

    async def test_stream_usage_is_settled_and_model_identity_is_hidden(self):
        def provider(request):
            self.assertTrue(json.loads(request.content)["stream_options"]["include_usage"])
            data = [{"model": "private-agent", "choices": [{"delta": {"reasoning_content": "reasoning"}}]},
                    {"model": "private-agent", "choices": [{"delta": {"content": "Hello"}}]},
                    {"model": "private-agent", "choices": [], "usage": {"prompt_tokens": 80, "completion_tokens": 20, "total_tokens": 100}}]
            return httpx.Response(200, text="".join("data: " + json.dumps(item) + "\n\n" for item in data) + "data: [DONE]\n\n")
        with self.client_patch(provider):
            response = await gateway.completion("agent", self.request(stream=True))
            text = "".join([part async for part in response.body_iterator])
        self.assertIn("reasoning_content", text)
        self.assertNotIn("private-agent", text)
        self.assertEqual(gateway.usage(1)["used"], 100)
        self.assertEqual(gateway.usage(1)["reserved"], 0)

    async def test_cancelled_stream_does_not_refund_unobserved_provider_usage(self):
        def provider(_):
            return httpx.Response(200, text='data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n')
        with self.client_patch(provider):
            response = await gateway.completion("agent", self.request(stream=True))
            await anext(response.body_iterator)
            await response.body_iterator.aclose()
        self.assertGreater(gateway.usage(1)["used"], 0)
        self.assertEqual(gateway.usage(1)["used"], gateway.usage(1)["estimated"])

    async def test_exhaustion_blocks_provider_and_explains_openrouter(self):
        reservation, _ = gateway.reserve(1, 1000, 49000)
        gateway.settle(reservation, 50000)
        with self.client_patch(lambda _: self.fail("Provider must not be contacted")):
            response = await gateway.completion("generate", self.request())
        self.assertEqual(response.status_code, 429)
        self.assertIn(b"OpenRouter", response.body)
        self.assertIn(b"free_quota_exhausted", response.body)

    async def test_provider_rejection_does_not_charge_or_leak_private_error(self):
        with self.client_patch(lambda _: httpx.Response(400, json={"error": {"message": "private-agent rejected platform-secret"}})):
            response = await gateway.completion("agent", self.request())
        self.assertEqual(response.status_code, 400)
        self.assertNotIn(b"private-agent", response.body)
        self.assertNotIn(b"platform-secret", response.body)
        self.assertEqual(gateway.usage(1)["remaining"], 50000)

    async def test_multiple_completions_and_invalid_task_are_rejected(self):
        with self.client_patch(lambda _: self.fail("Provider must not be contacted")):
            self.assertEqual((await gateway.completion("agent", self.request(n=2))).status_code, 400)
            with self.assertRaises(Exception):
                await gateway.completion("invalid", self.request())

    async def test_malformed_provider_response_releases_hold_with_conservative_charge(self):
        with self.client_patch(lambda _: httpx.Response(200, json=[])):
            response = await gateway.completion("generate", self.request())
        self.assertEqual(response.status_code, 502)
        self.assertEqual(gateway.usage(1)["reserved"], 0)
        self.assertGreater(gateway.usage(1)["estimated"], 0)

    async def test_missing_tokenizer_blocks_provider_without_using_allowance(self):
        with mock.patch.dict(os.environ, {"ANNOBIO_HOSTED_TOKENIZER_MODEL": "deepseek", "ANNOBIO_HOSTED_TOKENIZER_PATH": str(Path(self.temp.name) / "missing.json")}):
            with self.client_patch(lambda _: self.fail("Provider must not be contacted")):
                response = await gateway.completion("generate", self.request())
        self.assertEqual(response.status_code, 503)
        self.assertEqual(gateway.usage(1)["remaining"], 50000)

    async def test_remote_images_cannot_bypass_the_text_token_budget(self):
        messages = [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://example.test/large-image.png"}}]}]
        with self.client_patch(lambda _: self.fail("Provider must not be contacted")):
            response = await gateway.completion("generate", self.request(messages=messages))
        self.assertEqual(response.status_code, 400)
        self.assertIn(b"OpenRouter", response.body)
        self.assertEqual(gateway.usage(1)["remaining"], 50000)

    async def test_capability_rejection_preserves_fallback_hint_without_private_details(self):
        with self.client_patch(lambda _: httpx.Response(400, json={"error": {"message": "private-generate response_format json_schema is unavailable now"}})):
            response = await gateway.completion("generate", self.request())
        self.assertIn(b"response_format is not supported", response.body)
        self.assertNotIn(b"private-generate", response.body)
        self.assertEqual(gateway.usage(1)["remaining"], 50000)

    async def test_native_model_switch_keeps_stream_metering_and_public_identity(self):
        import litellm
        async def chunks():
            yield {"model": "private-native-agent", "choices": [{"delta": {"content": "Hello"}}]}
            yield {"model": "private-native-agent", "choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 20}}
        native = {"provider": "anthropic", "model": "private-native-agent", "base_url": "", "api_key_env": "ANNOBIO_HOSTED_API_KEY"}
        with mock.patch.dict(model_config.MODEL_CREDENTIALS, {"native": native}), mock.patch.dict(model_config.ROLE_MODELS, {"agent": "native"}), mock.patch.object(litellm, "acompletion", new_callable=mock.AsyncMock, return_value=chunks()) as call:
            response = await gateway.completion("agent", self.request(stream=True))
            result = "".join([part async for part in response.body_iterator])
        self.assertEqual(call.call_args.kwargs["model"], "anthropic/private-agent")  # existing environment override remains supported
        self.assertEqual(call.call_args.kwargs["api_key"], "platform-secret")
        self.assertNotIn("private-", result)
        self.assertIn("annobio-free", result)
        self.assertEqual(gateway.usage(1)["used"], 30)
        self.assertEqual(gateway.usage(1)["reserved"], 0)

    async def test_native_stream_failure_is_sanitized_and_charged_conservatively(self):
        import litellm
        async def chunks():
            yield {"model": "private-native-agent", "choices": [{"delta": {"content": "Hello"}}]}
            raise RuntimeError("private-native-agent failed with platform-secret")
        native = {"provider": "gemini", "model": "private-native-agent", "base_url": "", "api_key_env": "ANNOBIO_HOSTED_API_KEY"}
        with mock.patch.dict(model_config.MODEL_CREDENTIALS, {"native": native}), mock.patch.dict(model_config.ROLE_MODELS, {"agent": "native"}), mock.patch.object(litellm, "acompletion", new_callable=mock.AsyncMock, return_value=chunks()):
            response = await gateway.completion("agent", self.request(stream=True))
            result = "".join([part async for part in response.body_iterator])
        self.assertIn("stream was interrupted", result)
        self.assertNotIn("platform-secret", result)
        self.assertNotIn("private-", result)
        self.assertGreater(gateway.usage(1)["estimated"], 0)
        self.assertEqual(gateway.usage(1)["reserved"], 0)


if __name__ == "__main__":
    unittest.main()
