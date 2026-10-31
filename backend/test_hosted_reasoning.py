from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm
import hosted_model


class HostedReasoningTests(unittest.TestCase):
    def test_real_clients_route_generate_optimize_and_agent_through_the_gateway(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append((self.path, body))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
                self.end_headers()
                base = {"id": "chatcmpl-test", "created": 1, "model": "annobio-free"}
                if body.get("stream"):
                    chunk = {**base, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": "Answer", "reasoning_content": "New reasoning"}, "finish_reason": "stop"}]}
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode())
                else:
                    payload = {**base, "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant", "content": "Answer"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
                    self.wfile.write(json.dumps(payload).encode())

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with mock.patch.dict(os.environ, {"ANNOBIO_HOSTED_MODE": "1", "ANNOBIO_HOSTED_TOKEN": "test-scoped-token", "ANNOBIO_HOSTED_GATEWAY_URL": f"http://127.0.0.1:{server.server_port}/internal/hosted-model"}):
                def resolved(role):
                    item = hosted_model.resolve(hosted_model.credential(), role)
                    return {key: item[key] for key in ("provider", "model", "api_key", "base_url")}

                self.assertEqual(llm.chat(**resolved("generate"), messages=[{"role": "user", "content": "Hello"}], max_tokens=100), "Answer")
                from review_dspy_shared import build_dspy_lm
                optimizer = build_dspy_lm(**resolved("optimize"), max_tokens=100)
                self.assertEqual(optimizer(messages=[{"role": "user", "content": "Hello"}], cache=False), ["Answer"])
                messages = [{"role": "assistant", "content": "Previous", "reasoning_content": "Prior reasoning"}, {"role": "user", "content": "Continue"}]
                events = list(llm.stream_chat_with_tools(**resolved("agent"), messages=messages, tools=[], max_tokens=100, max_retries=0))
            self.assertEqual([path for path, _ in requests], [f"/internal/hosted-model/{role}/v1/chat/completions" for role in ("generate", "optimize", "agent")])
            self.assertTrue(all(body["model"] == "annobio-free" for _, body in requests))
            self.assertEqual(requests[-1][1]["messages"][0]["reasoning_content"], "Prior reasoning")
            self.assertIn({"type": "reasoning", "delta": "New reasoning"}, events)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

    def test_reasoning_is_forwarded_for_hosted_model_and_streamed_separately(self):
        messages = [{"role":"assistant","content":"Previous answer", "reasoning_content":"previous reasoning"}, {"role":"user","content":"Continue"}]
        chunks = [SimpleNamespace(choices=[SimpleNamespace(finish_reason=None, delta=SimpleNamespace(reasoning_content="next reasoning", content=None, tool_calls=[]))]),
                  SimpleNamespace(choices=[SimpleNamespace(finish_reason="stop", delta=SimpleNamespace(content="Answer", tool_calls=[]))])]
        with mock.patch.object(llm, "completion", return_value=iter(chunks)) as completion:
            events = list(llm.stream_chat_with_tools(provider="openai", model="annobio-free", api_key="scoped-token", base_url="http://hub:8080/internal/hosted-model/agent/v1", messages=messages, tools=[], max_tokens=100))
        self.assertEqual(completion.call_args.kwargs["messages"][0]["reasoning_content"], "previous reasoning")
        self.assertEqual(events[0], {"type":"reasoning","delta":"next reasoning"})
        self.assertEqual(events[1], {"type":"text","delta":"Answer"})
        self.assertNotIn("reasoning_content", llm._normalize_tool_messages(messages)[0])

    def test_free_quota_exhaustion_is_not_retried(self):
        error = RuntimeError('429 free_quota_exhausted: Connect OpenRouter')
        error.status_code = 429
        self.assertFalse(llm._is_retryable_error(error))

    def test_gateway_refusal_is_raised_once_with_its_own_message(self):
        message = "This request is larger than what is left of today's free allowance. Shorten it, wait for the reset at 00:00 UTC, or add an OpenRouter credential under New credential in LLM settings."
        calls = []

        def refuse():
            calls.append(1)
            error = RuntimeError(f"litellm.RateLimitError: RateLimitError: OpenAIException - {message}")
            error.status_code = 429
            raise error

        with self.assertRaises(llm.HostedModelError) as raised:
            llm._retry_invoke(refuse, max_retries=3)
        self.assertEqual(str(raised.exception), message)
        self.assertEqual(len(calls), 1)

    def test_gateway_json_error_body_is_unwrapped(self):
        error = RuntimeError('litellm.ServiceUnavailableError: OpenAIException - {"error": {"message": "The free model is temporarily unavailable.", "code": "hosted_model_error"}}')
        self.assertEqual(str(llm._hosted_model_error(error)), "The free model is temporarily unavailable.")

    def test_other_rate_limits_are_still_retried(self):
        error = RuntimeError("litellm.RateLimitError: RateLimitError: OpenAIException - Rate limit reached for requests")
        error.status_code = 429
        self.assertIsNone(llm._hosted_model_error(error))
        self.assertTrue(llm._is_retryable_error(error))


if __name__ == "__main__":
    unittest.main()
