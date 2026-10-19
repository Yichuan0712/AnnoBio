"""Progress responses must reach the browser before the upstream request finishes."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import httpx
from starlette.responses import StreamingResponse


class ProxyStreamingTests(unittest.IsolatedAsyncioTestCase):
    async def test_ndjson_and_agent_events_are_streamed_without_buffering(self):
        for content_type in ("application/x-ndjson", "text/event-stream"):
            containers = SimpleNamespace(ensure_running=lambda user: "backend", BACKEND_PORT=8000,
                CapacityExceeded=type("CapacityExceeded", (Exception,), {}),
                BackendUnavailable=type("BackendUnavailable", (Exception,), {}))
            database = SimpleNamespace(touch_container=mock.Mock())
            spec = importlib.util.spec_from_file_location("hub_progress_proxy", Path(__file__).with_name("proxy.py"))
            proxy = importlib.util.module_from_spec(spec)
            with mock.patch.dict("sys.modules", {"containers": containers, "db": database}):
                spec.loader.exec_module(proxy)
            async def chunks():
                yield b'{"type":"result"}\n'
                yield b'{"type":"done"}\n'
            upstream = SimpleNamespace(headers={"content-type": content_type}, status_code=200,
                aiter_bytes=chunks, aread=mock.AsyncMock(), aclose=mock.AsyncMock())
            client = SimpleNamespace(send=mock.AsyncMock(return_value=upstream), aclose=mock.AsyncMock(),
                build_request=lambda *args, **kwargs: httpx.Request("POST", "http://backend:8000/api/terminology/normalize"))
            request = SimpleNamespace(url=SimpleNamespace(path="/api/terminology/normalize", query=""),
                method="POST", headers={}, body=mock.AsyncMock(return_value=b'{}'))
            with mock.patch.object(proxy.httpx, "AsyncClient", return_value=client):
                response = await proxy.proxy_request(request, {"id": 1})
            self.assertIsInstance(response, StreamingResponse)
            upstream.aread.assert_not_awaited()
            self.assertEqual(await anext(response.body_iterator), b'{"type":"result"}\n')
            await response.background()
            upstream.aclose.assert_awaited_once()
            client.aclose.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
