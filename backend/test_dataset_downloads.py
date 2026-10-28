"""Explicit downloads, user deletion detection and hosted-mode protection."""
import io
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock

import httpx
import pyarrow as pa
import pyarrow.parquet as pq

import biomni_data_lake as lake
import biomni_downloads as downloads
import reference_import as ri


class DatasetDownloadTest(unittest.TestCase):
    def setUp(self):
        cache = Path(__file__).parent.parent / '.cache'
        cache.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='download-library-test-', dir=cache)
        self.root = Path(self.temp.name)
        self.env = mock.patch.dict(os.environ, {'ANNOBIO_BIOMNI_CACHE_DIR': str(self.root), 'ANNOBIO_BIOMNI_DATA_DIR': '', 'ANNOBIO_ENABLE_DATA_LAKE': '1'})
        self.env.start()
        lake._SCHEMAS.clear()
        self.name = 'msigdb_human_h_hallmark_geneset.parquet'
        stream = io.BytesIO()
        pq.write_table(pa.table({'gene': ['TP53', 'BRCA1'], 'score': [0, 1]}), stream)
        self.payload = stream.getvalue()
        self.metadata = mock.patch.dict(downloads.FILES, {self.name: {'bytes': len(self.payload), 'etag': 'fixture'}})
        self.metadata.start()
        self.requests = []
        def handler(request):
            self.requests.append(request)
            start, end = map(int, request.headers['range'].removeprefix('bytes=').split('-'))
            return httpx.Response(206, content=self.payload[start:end+1], headers={'Content-Range': f'bytes {start}-{end}/{len(self.payload)}', 'ETag': '"fixture"'})
        self.client = httpx.Client(transport=httpx.MockTransport(handler))

    def tearDown(self):
        self.client.close()
        self.metadata.stop()
        self.env.stop()
        self.temp.cleanup()

    def test_download_is_explicit_and_manual_deletion_invalidates_cached_columns(self):
        self.assertEqual(downloads.dataset_status(self.name)['status'], 'missing')
        with self.assertRaises(FileNotFoundError):
            lake.describe_snapshot_fields('lake_msigdb', {'dataset': self.name}, self.client)
        self.assertEqual(self.requests, [])
        progress = []
        downloads.download_dataset(self.client, self.name, on_progress=lambda *args: progress.append(args))
        self.assertEqual(progress[-1], (len(self.payload), len(self.payload)))
        schema = lake.describe_snapshot_fields('lake_msigdb', {'dataset': self.name}, self.client)
        self.assertIn('gene', schema['fields'])
        self.assertEqual(schema['fingerprint'], downloads.dataset_status(self.name)['fingerprint'])
        rows = lake.fetch_snapshot_records('lake_msigdb', [], ['gene'], {'dataset': self.name, 'limit': 1}, self.client)
        self.assertEqual(rows, [{'gene': 'TP53'}])
        requests_before = len(self.requests)
        (self.root / self.name).unlink()  # File-manager deletion bypasses app cache invalidation.
        self.assertEqual(downloads.dataset_status(self.name)['status'], 'missing')
        with self.assertRaises(FileNotFoundError):
            lake.describe_snapshot_fields('lake_msigdb', {'dataset': self.name}, self.client)
        with self.assertRaises(FileNotFoundError):
            lake.fetch_snapshot_records('lake_msigdb', [], ['gene'], {'dataset': self.name}, self.client)
        self.assertEqual(len(self.requests), requests_before, 'Reading must never silently redownload a deleted file')

    def test_changed_file_discards_old_schema_and_incomplete_files_cannot_be_read(self):
        downloads.download_dataset(self.client, self.name)
        before = lake.describe_snapshot_fields('lake_msigdb', {'dataset': self.name}, self.client)
        stream = io.BytesIO()
        pq.write_table(pa.table({'replacement': ['value']}), stream)
        self.payload = stream.getvalue()
        downloads.FILES[self.name] = {'bytes': len(self.payload), 'etag': 'fixture'}
        (self.root / self.name).write_bytes(self.payload)
        after = lake.describe_snapshot_fields('lake_msigdb', {'dataset': self.name}, self.client)
        self.assertNotEqual(before['fingerprint'], after['fingerprint'])
        self.assertIn('replacement', after['fields'])
        self.assertNotIn('gene', after['fields'])
        (self.root / self.name).write_bytes(b'partial')
        self.assertEqual(downloads.dataset_status(self.name)['status'], 'incomplete')
        with self.assertRaises(FileNotFoundError): next(lake.iter_dataset_rows(self.client, self.name))

    def test_remove_only_deletes_this_download_and_its_prepared_copy(self):
        downloads.download_dataset(self.client, self.name)
        prepared = self.root / 'prepared' / (self.name + '.parquet')
        prepared.parent.mkdir()
        prepared.write_bytes(b'prepared cache')
        unrelated = self.root / 'project.yc'
        unrelated.write_text('user data')
        result = downloads.delete_download(self.name)
        self.assertEqual(result['removed_bytes'], len(self.payload) + len(b'prepared cache'))
        self.assertEqual(result['download']['status'], 'missing')
        self.assertFalse(prepared.exists())
        self.assertEqual(unrelated.read_text(), 'user data')
        with self.assertRaises(ValueError): downloads.delete_download('../project.yc')

    def test_cancelled_transfer_cleans_partial_file_progress_and_locks(self):
        def cancel(*args): raise InterruptedError('cancelled after receiving bytes')
        with self.assertRaises(InterruptedError):
            downloads.download_dataset(self.client, self.name, on_progress=cancel)
        self.assertEqual(downloads.dataset_status(self.name)['status'], 'missing')
        self.assertFalse((self.root / (self.name + '.part')).exists())
        self.assertFalse(downloads._DOWNLOAD_LOCK.locked())
        downloads.download_dataset(self.client, self.name)
        self.assertEqual(downloads.dataset_status(self.name)['status'], 'downloaded')

    def test_in_use_download_cannot_be_removed_and_external_files_are_kept(self):
        downloads.download_dataset(self.client, self.name)
        entered, release = threading.Event(), threading.Event()
        def reader():
            with downloads.dataset_lock(self.name):
                entered.set()
                release.wait(5)
        worker = threading.Thread(target=reader)
        worker.start()
        self.assertTrue(entered.wait(5))
        try:
            with self.assertRaisesRegex(RuntimeError, 'in use'): downloads.delete_download(self.name)
        finally:
            release.set()
            worker.join()
        external = self.root / 'external'
        external.mkdir()
        (external / self.name).write_bytes(self.payload)
        with mock.patch.dict(os.environ, {'ANNOBIO_BIOMNI_DATA_DIR': str(external)}):
            downloads.delete_download(self.name)
            self.assertTrue((external / self.name).exists())
            self.assertFalse(downloads.dataset_status(self.name)['managed'])

    def test_automatic_row_cap_checks_one_extra_row(self):
        for count in (0, 3, 2001, 4999, 5000, 5001, 10000):
            with self.subTest(count=count):
                consumed, metadata = [], []
                def rows(*args):
                    for index in range(count):
                        consumed.append(index)
                        yield {'gene': str(index)}
                with mock.patch.object(lake, 'iter_dataset_rows', rows):
                    result = lake.fetch_snapshot_records('lake_msigdb', [], ['gene'], {'dataset': self.name}, self.client, on_metadata=metadata.append)
                self.assertEqual(len(result), min(count, 5000))
                self.assertEqual(len(consumed), min(count, 5001))
                self.assertEqual(metadata, [{'truncated': count > 5000, 'row_limit': 5000}])

    def test_snapshot_import_api_reports_automatic_truncation(self):
        import main
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        app = FastAPI()
        for route in main.app.routes:
            if '/import' in route.path: app.router.routes.append(route)
        client = TestClient(app)
        stream = io.BytesIO()
        pq.write_table(pa.table({'gene': [f'gene-{i}' for i in range(5001)]}), stream)
        payload = stream.getvalue()
        (self.root / self.name).write_bytes(payload)
        with mock.patch.dict(downloads.FILES, {self.name: {'bytes': len(payload), 'etag': 'fixture'}}), mock.patch.object(ri, '_client', lambda: httpx.Client(transport=self.client._transport)):
            started = client.post('/api/lake_msigdb/import', json={'fields': ['gene'], 'options': {'dataset': self.name}})
            self.assertEqual(started.status_code, 202)
            for _ in range(100):
                result = client.get('/api/lake_msigdb/import/result/' + started.json()['job_id']).json()
                if result['status'] != 'running': break
                time.sleep(0.01)
            self.assertEqual(result['status'], 'done')
            self.assertNotIn('error', result)
            self.assertEqual(len(result['rows']), 5000)
            self.assertEqual(result['rows'][0], ['gene-0'])
            self.assertEqual(result['rows'][-1], ['gene-4999'])
            self.assertTrue(result['truncated'])
            self.assertEqual(result['row_limit'], 5000)
            self.assertEqual(self.requests, [])

    def test_download_api_returns_progress_and_schema_and_blocks_hosted_access(self):
        import main
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        app = FastAPI()
        for route in main.app.routes:
            if '/import' in route.path: app.router.routes.append(route)
        client = TestClient(app)
        factory = lambda: httpx.Client(transport=self.client._transport)
        with mock.patch.object(ri, '_client', factory):
            missing = client.get('/api/reference/import/downloads?source=lake_msigdb').json()
            self.assertEqual(missing['directory'], str(self.root.resolve()))
            response = client.post('/api/reference/import/sources/lake_msigdb/download', json={'dataset': self.name})
            self.assertEqual(response.status_code, 202)
            job_id = response.json()['job_id']
            for _ in range(100):
                result = client.get('/api/lake_msigdb/import/result/' + job_id).json()
                if result['status'] != 'running': break
                time.sleep(0.01)
            self.assertIn('schema', result)
            self.assertEqual(result['download']['status'], 'downloaded')
            self.assertEqual(client.delete('/api/reference/import/downloads/' + self.name).status_code, 200)
        with mock.patch.dict(os.environ, {'ANNOBIO_ENABLE_DATA_LAKE': '0'}), mock.patch.object(ri, '_client') as network:
            self.assertEqual(client.get('/api/reference/import/downloads').status_code, 404)
            self.assertEqual(client.delete('/api/reference/import/downloads/' + self.name).status_code, 404)
            self.assertEqual(client.post('/api/reference/import/sources/lake_msigdb/download', json={'dataset': self.name}).status_code, 404)
            self.assertEqual(client.post('/api/reference/import/sources/lake_msigdb/schema', json={'dataset': self.name}).status_code, 404)
            network.assert_not_called()


if __name__ == '__main__': unittest.main()
