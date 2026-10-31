"""Progress responses must reach the browser before the upstream request finishes."""
import asyncio
import importlib.util
import threading
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import httpx
from starlette.responses import StreamingResponse


class ProxyStreamingTests(unittest.IsolatedAsyncioTestCase):
    async def test_cold_workspace_start_does_not_block_the_event_loop(self):
        entered = threading.Event()
        release = threading.Event()

        def start(_user):
            entered.set()
            if not release.wait(2):
                raise RuntimeError('The event loop was blocked by Docker startup')
            return 'backend'

        containers = SimpleNamespace(ensure_running=start, BACKEND_PORT=8000,
            CapacityExceeded=type('CapacityExceeded', (Exception,), {}),
            BackendUnavailable=type('BackendUnavailable', (Exception,), {}))
        spec = importlib.util.spec_from_file_location('hub_cold_start_proxy', Path(__file__).with_name('proxy.py'))
        proxy = importlib.util.module_from_spec(spec)
        with mock.patch.dict('sys.modules', {'containers': containers, 'db': SimpleNamespace(touch_container=mock.Mock())}):
            spec.loader.exec_module(proxy)
        upstream = SimpleNamespace(headers={}, status_code=200,
            aread=mock.AsyncMock(return_value=b'{}'), aclose=mock.AsyncMock())
        client = SimpleNamespace(send=mock.AsyncMock(return_value=upstream), aclose=mock.AsyncMock(),
            build_request=lambda *args, **kwargs: httpx.Request('GET', 'http://backend:8000/api/projects'))
        request = SimpleNamespace(url=SimpleNamespace(path='/api/projects', query=''), method='GET',
            headers={}, body=mock.AsyncMock(return_value=b''))
        with mock.patch.object(proxy.httpx, 'AsyncClient', return_value=client):
            pending = asyncio.create_task(proxy.proxy_request(request, {'id': 1}))
            try:
                # This coroutine must run while startup is still waiting in the worker.
                for _ in range(100):
                    if entered.is_set():
                        break
                    await asyncio.sleep(0.01)
                self.assertTrue(entered.is_set())
                self.assertFalse(pending.done())
            finally:
                release.set()
            response = await pending
        self.assertEqual(response.status_code, 200)

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
