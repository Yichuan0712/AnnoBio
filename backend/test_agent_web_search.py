"""Offline coverage for bounded web lookups, public-address fetching and text extraction."""
import json
import socket
import subprocess
import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from agent import web_search as service
from agent import web_search_worker as worker
from agent.web_search_routes import router


class PublicPageTests(unittest.TestCase):
    def test_rejects_private_credentials_ports_and_non_web_urls(self):
        for url in ['file:///etc/passwd', 'javascript:alert(1)', 'http://localhost/', 'http://127.1/',
                'http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/',
                'http://[::1]/', 'https://user:password@example.org/', 'https://example.org:8443/',
                'https://example.org\\@localhost/', 'https://example.org/\r\nHost:x', 'http://hub:8080/']:
            with self.subTest(url=url), self.assertRaises(worker.WebLookupError):
                # Unusual IPv4 spellings are rejected when resolved, before connect.
                normalized = worker.public_url(url)
                host = worker.urlsplit(normalized).hostname
                with mock.patch.object(socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 80))]):
                    worker.resolve_public(host, 80)

    def test_mixed_public_private_dns_is_rejected(self):
        addresses = [(2, 1, 6, '', (ip, 443)) for ip in ['93.184.216.34', '192.168.1.1']]
        with mock.patch.object(socket, 'getaddrinfo', return_value=addresses), self.assertRaises(worker.WebLookupError):
            worker.resolve_public('example.org', 443)

    def test_tls_uses_the_validated_ip_and_original_hostname(self):
        sock = mock.Mock()
        context = mock.Mock()
        with mock.patch.object(socket, 'create_connection', return_value=sock) as connect, \
                mock.patch.object(worker.ssl, 'create_default_context', return_value=context):
            connection = worker.PinnedHTTPS('example.org', 443, '93.184.216.34')
            connection.connect()
        connect.assert_called_once_with(('93.184.216.34', 443), timeout=4)
        context.wrap_socket.assert_called_once_with(sock, server_hostname='example.org')

    def response(self, status=200, headers=None, body=b''):
        return mock.Mock(status=status, getheader=lambda name, default=None: (headers or {}).get(name, default),
            read=mock.Mock(side_effect=[body, b'']))

    def test_redirect_revalidates_dns_before_any_private_connection(self):
        connection = mock.Mock()
        connection.getresponse.return_value = self.response(302, {'Location': 'https://internal.example.org/secret'})
        with mock.patch.object(worker, 'resolve_public', side_effect=[['93.184.216.34'], worker.WebLookupError('private address')]), \
                mock.patch.object(worker, 'PinnedHTTPS', return_value=connection) as connections, \
                self.assertRaisesRegex(worker.WebLookupError, 'private'):
            worker.fetch_page('https://example.org/')
        self.assertEqual(connections.call_count, 1)
        connection.close.assert_called_once()

    def test_response_limits_and_content_type(self):
        for headers, body in [({'Content-Type': 'application/pdf'}, b'%PDF'),
                ({'Content-Type': 'text/html', 'Content-Length': str(worker.MAX_BYTES + 1)}, b''),
                ({'Content-Type': 'text/html'}, b'x' * (worker.MAX_BYTES + 1))]:
            connection = mock.Mock()
            connection.getresponse.return_value = self.response(headers=headers, body=body)
            with mock.patch.object(worker, 'resolve_public', return_value=['93.184.216.34']), \
                    mock.patch.object(worker, 'PinnedHTTPS', return_value=connection), self.assertRaises(worker.WebLookupError):
                worker.fetch_page('https://example.org/')
            connection.close.assert_called_once()

    def test_extracts_article_and_excludes_navigation_scripts_and_hidden_content(self):
        title, content = worker.extract_html(b'<html><head><title>Example &amp; evidence</title></head><body>'
            b'<nav>MENU</nav><main><h1>Article</h1><p>Useful evidence.</p><p>Second paragraph.</p>'
            b'<script>STEAL_SECRETS()</script><span hidden>HIDDEN</span></main><footer>FOOTER</footer></body></html>')
        self.assertEqual(title, 'Example & evidence')
        self.assertIn('Useful evidence.', content)
        self.assertIn('\n', content)
        for unwanted in ['MENU', 'STEAL_SECRETS', 'HIDDEN', 'FOOTER']:
            self.assertNotIn(unwanted, content)

    def test_dynamic_verification_shell_is_not_reported_as_read(self):
        for text in ['Please enable JavaScript. ' * 10,
                'UniProt website fallback message. If you are not seeing anything on this page, your browser may be outdated.']:
            with self.subTest(text=text), mock.patch.object(worker, 'fetch_page', return_value=('https://example.org/', '', text)), \
                    self.assertRaisesRegex(worker.WebLookupError, 'article was not read'):
                worker.run({'kind': 'read', 'url': 'https://example.org/'})

    def test_search_filters_unsafe_results_and_handles_blocked_providers(self):
        from ddgs.exceptions import DDGSException
        with mock.patch('ddgs.DDGS') as ddgs:
            ddgs.return_value.text.return_value = [
                {'title': 'bad', 'href': 'javascript:alert(1)'},
                {'title': 'private', 'href': 'http://127.0.0.1/'},
                {'title': 'Example', 'href': 'https://example.org/', 'body': 'Evidence'},
            ]
            result = worker.search('example', 5)
            self.assertEqual(result['results'], [{'title': 'Example', 'url': 'https://example.org/', 'snippet': 'Evidence'}])
            ddgs.return_value.text.side_effect = DDGSException('No results found.')
            with self.assertRaisesRegex(worker.WebLookupError, 'providers returned no usable results'):
                worker.search('example', 5)

    def test_readable_page_is_capped_and_marked_untrusted(self):
        with mock.patch.object(worker, 'fetch_page', return_value=('https://example.org/', 'Title', 'a' * 60000)):
            result = worker.run({'kind': 'read', 'url': 'https://example.org/'})
        self.assertEqual(len(result['content']), 48000)
        self.assertTrue(result['truncated'])
        self.assertIn('Untrusted', result['note'])


class WebServiceTests(unittest.TestCase):
    def setUp(self):
        service._cache.clear()

    def test_cached_search_skips_the_worker_and_retains_source_metadata(self):
        response = {'query': 'test', 'results': [{'title': 'Example', 'url': 'https://example.org/', 'snippet': 'Evidence'}]}
        with mock.patch.object(service.subprocess, 'run', return_value=mock.Mock(returncode=0, stdout=json.dumps(response))) as run:
            first = service.search_web('test')
            second = service.search_web('test')
        self.assertEqual(first['results'], second['results'])
        self.assertFalse(first['cached'])
        self.assertTrue(second['cached'])
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.kwargs['timeout'], 12)
        self.assertNotIn('shell', run.call_args.kwargs)

    def test_worker_timeout_is_a_soft_cached_error(self):
        with mock.patch.object(service.subprocess, 'run', side_effect=subprocess.TimeoutExpired('worker', 12)) as run:
            result = service.search_web('blocked')
            again = service.search_web('blocked')
        self.assertEqual(result['code'], 'timeout')
        self.assertTrue(again['cached'])
        self.assertEqual(run.call_count, 1)

    def test_expired_cache_and_busy_lookups_do_not_start_extra_workers(self):
        response = mock.Mock(returncode=0, stdout='{"results": []}')
        with mock.patch.object(service.time, 'monotonic', return_value=10), mock.patch.object(service.subprocess, 'run', return_value=response):
            service.search_web('expire')
        with mock.patch.object(service.time, 'monotonic', return_value=400), mock.patch.object(service.subprocess, 'run', return_value=response) as run:
            self.assertFalse(service.search_web('expire')['cached'])
            self.assertEqual(run.call_count, 1)
        service._slots.acquire()
        service._slots.acquire()
        try:
            with mock.patch.object(service.subprocess, 'run') as run:
                self.assertEqual(service.search_web('busy')['code'], 'busy')
                run.assert_not_called()
        finally:
            service._slots.release()
            service._slots.release()

    def test_page_windows_share_the_cache_and_report_truncation(self):
        response = mock.Mock(returncode=0, stdout=json.dumps({'url': 'https://example.org/', 'content': '0123456789' * 1000}))
        with mock.patch.object(service.subprocess, 'run', return_value=response) as run:
            first = service.read_webpage('https://example.org/', 0, 100)
            second = service.read_webpage('https://example.org/', 100, 100)
        self.assertEqual(len(first['content']), 100)
        self.assertEqual(second['offset'], 100)
        self.assertEqual(second['total_chars'], 10000)
        self.assertTrue(second['cached'])
        self.assertTrue(second['truncated'])
        self.assertEqual(run.call_count, 1)

    def test_routes_validate_input_and_return_soft_provider_failures(self):
        app = FastAPI()
        app.include_router(router)
        with TestClient(app) as client:
            for path, payload in [('/api/agent/web-search', {'query': ''}),
                    ('/api/agent/web-search', {'query': 'x', 'limit': 100}),
                    ('/api/agent/webpage', {'url': 'https://example.org', 'max_chars': 100000})]:
                self.assertEqual(client.post(path, json=payload).status_code, 422)
            with mock.patch.object(service.subprocess, 'run', side_effect=subprocess.TimeoutExpired('worker', 12)):
                response = client.post('/api/agent/web-search', json={'query': 'timeout'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['code'], 'timeout')


if __name__ == '__main__':
    unittest.main()
