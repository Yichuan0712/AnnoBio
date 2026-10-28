"""Pinned Biomni coverage and table readers, with no external requests."""
import io
import json
import os
from pathlib import Path
import pickle
import tempfile
import unittest
from unittest import mock

import httpx
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

import biomni_data_lake as lake
import biomni_database_importers as online
import reference_import as ri
from agent.source_search import describe_sources

FIXTURES = json.loads((Path(__file__).parent / 'test_fixtures/biomni_database_imports.json').read_text(encoding='utf-8'))


class BiomniCoverageTest(unittest.TestCase):
    def test_hosted_mode_hides_and_blocks_snapshots_before_reading_or_downloading(self):
        from database_availability import data_lake_enabled
        from biomni_coverage import describe_coverage
        with mock.patch.dict(os.environ, {'ANNOBIO_ENABLE_DATA_LAKE': '0'}), mock.patch.object(ri, '_client') as client:
            self.assertFalse(data_lake_enabled())
            self.assertFalse(describe_coverage()['data_lake_enabled'])
            sources = ri.describe_importers()
            self.assertFalse(any(item.get('kind') == 'snapshot' for item in sources.values()))
            self.assertIn('pubchem', sources)
            self.assertIn('screen', sources)
            with self.assertRaisesRegex(ValueError, 'disabled on this server'):
                ri.fetch_records('lake_genebass', [], ['id'])
            with self.assertRaisesRegex(ValueError, 'disabled on this server'):
                lake.describe_snapshot_fields('lake_msigdb', {}, None)
            with self.assertRaisesRegex(ValueError, 'disabled on this server'):
                next(lake.iter_dataset_rows(None, 'gwas_catalog.pkl'))
            client.assert_not_called()

    def test_every_pinned_tool_and_file_has_a_real_import_route(self):
        manifest = lake.MANIFEST
        self.assertEqual(len(manifest['database_tools']), 40)
        self.assertEqual(set(manifest['database_tools']), set(manifest['tool_sources']))
        self.assertTrue(set(manifest['tool_sources'].values()) <= set(describe_sources()))
        files = [filename for group in lake.GROUPS.values() for filename in group['files']]
        self.assertEqual(len(files), 76)
        self.assertEqual(len(set(files)), 76)
        self.assertEqual(set(files), set(lake.FILES))
        self.assertTrue(set(lake.GROUPS) <= ri.REFERENCE_IMPORTERS.keys())
        for source, entry in ri.describe_importers().items():
            if entry.get('kind') != 'snapshot':
                self.assertTrue(entry['default_fields'])
                self.assertTrue(set(entry['default_fields']) <= entry['fields'].keys())
        # The frontend must expose the same sources, not a separate list of dead buttons.
        metadata_text = (Path(__file__).parent.parent / 'app/src/biomniDatabaseCatalog.js').read_text()
        metadata = json.loads(metadata_text[metadata_text.index('['):].rstrip(';\n'))
        expected = set(online.build_biomni_database_importers(ri._get)) | set(lake.GROUPS)
        self.assertEqual({item['source'] for item in metadata}, expected)

    def test_new_public_adapters_parse_real_reduced_responses(self):
        for source, fixture in FIXTURES.items():
            with self.subTest(source=source):
                entry = ri.REFERENCE_IMPORTERS[source]
                identifier = 'hg38/chr1:100000-150000' if source == 'remap' else entry['example']
                record = fixture['record']
                if source == 'kegg':
                    payload = None
                    text = record['ENTRY'][0] if 'ENTRY' in record else ''
                    text = ''.join(f'{key:<12}{value}\n' for key, values in record.items() for value in values)
                else:
                    payload = {'paleobiology': {'records': [record]}, 'mpd': {'measures_info': [record]},
                               'unichem': {'compounds': [record]}, 'quickgo': {'results': [record]}}.get(source, record)
                    text = None
                def handler(request):
                    if source == 'remap': self.assertEqual(request.headers['accept'], 'application/json')
                    if source == 'unichem': self.assertEqual(json.loads(request.content)['compound'], identifier)
                    return httpx.Response(200, text=text) if text is not None else httpx.Response(200, json=payload)
                factory = lambda: httpx.Client(transport=httpx.MockTransport(handler))
                with mock.patch.object(ri, '_client', factory), mock.patch.object(ri, '_pace'):
                    rows = ri.fetch_records(source, [identifier], ['id', 'name', 'source_url'])
                self.assertEqual(rows[0]['id'], fixture['expected_id'])
                self.assertEqual(rows[0]['name'], fixture['expected_name'])
                self.assertTrue(rows[0]['source_url'].startswith('https://'))

    def test_authentication_headers_and_current_screen_schema(self):
        for source, header, expected, payload in [
            ('iucn', 'Authorization', 'secret', {'taxon': {'scientific_name': 'Panthera tigris'}}),
            ('gtopdb', 'GTP-API-Key', 'secret', {'name': 'target'}),
            ('synapse', 'Authorization', 'Bearer secret', {'id': 'syn9702085', 'name': 'test'}),
            ('screen', 'Authorization', 'Bearer secret', {'data': {'cCREQuery': [{'accession': 'EH38E1516980'}]}}),
        ]:
            with self.subTest(source=source):
                def handler(request):
                    self.assertEqual(request.headers[header], expected)
                    self.assertNotIn('secret', str(request.url))
                    if source == 'screen':
                        body = json.loads(request.content)
                        self.assertEqual(body['variables']['assembly'], 'grch38')
                        self.assertIn('nearby_genes', body['query'])
                    return httpx.Response(200, json=payload)
                factory = lambda: httpx.Client(transport=httpx.MockTransport(handler))
                with mock.patch.object(ri, '_client', factory), mock.patch.object(ri, '_pace'):
                    rows = ri.fetch_records(source, [ri.REFERENCE_IMPORTERS[source]['example']], ['name'], options={'api_key': 'secret'})
                self.assertTrue(rows)
        with mock.patch.dict(os.environ, {}, clear=True):
            for source in ('iucn', 'gtopdb', 'screen'):
                with self.assertRaisesRegex(ValueError, 'requires an API key'):
                    ri.fetch_records(source, [ri.REFERENCE_IMPORTERS[source]['example']], ['id'])

    def test_blast_waits_polls_and_parses_hits_without_a_real_sequence_search(self):
        requests = []
        def handler(request):
            requests.append(request)
            if request.method == 'POST': return httpx.Response(200, text='RID = TESTRID\nRTOE = 30')
            if request.url.params.get('FORMAT_OBJECT'): return httpx.Response(200, text='Status=READY')
            return httpx.Response(200, text='<BlastOutput><Hit><Hit_accession>P53_HUMAN</Hit_accession><Hit_def>p53</Hit_def><Hsp><Hsp_evalue>1e-20</Hsp_evalue></Hsp></Hit></BlastOutput>')
        heartbeats = []
        factory = lambda: httpx.Client(transport=httpx.MockTransport(handler))
        with mock.patch.object(ri, '_client', factory), mock.patch.object(online.time, 'sleep'), mock.patch.object(ri, '_pace'):
            rows = ri.fetch_records('blast', ['MEEPQSDPSVEPPLSQETFSDLWKLLPENNVLSPLPSQAMDD'], ['hits'],
                                    options={'program': 'blastp'}, on_batch=lambda *args: heartbeats.append(args))
        self.assertIn('P53_HUMAN', rows[0]['hits'])
        self.assertGreaterEqual(len(heartbeats), 70)
        self.assertEqual(len(requests), 3)

    def test_blast_pending_rid_is_preserved_without_resubmitting(self):
        seen = []
        def handler(request):
            seen.append(request)
            self.assertEqual(request.method, 'GET')
            self.assertEqual(request.url.params['RID'], 'TESTRID')
            return httpx.Response(200, text='Status=WAITING')
        factory = lambda: httpx.Client(transport=httpx.MockTransport(handler))
        with mock.patch.object(ri, '_client', factory), mock.patch.object(online.time, 'sleep'), mock.patch.object(ri, '_pace'):
            rows = ri.fetch_records('blast', ['RID:TESTRID'], ['id', 'status', 'description', 'hits', 'source_url'])
        self.assertEqual(rows[0]['status'], 'running')
        self.assertEqual(rows[0]['id'], 'TESTRID')
        self.assertIn('RID:TESTRID', rows[0]['description'])
        self.assertEqual(rows[0]['hits'], '')
        self.assertEqual(len(seen), 10)

    def test_blast_wait_can_be_cancelled_before_polling_upstream(self):
        def handler(request): return httpx.Response(200, text='RID = TESTRID')
        def stop(*args): raise InterruptedError('cancelled')
        factory = lambda: httpx.Client(transport=httpx.MockTransport(handler))
        with mock.patch.object(ri, '_client', factory), mock.patch.object(online.time, 'sleep'), mock.patch.object(ri, '_pace'):
            with self.assertRaises(InterruptedError):
                ri.fetch_records('blast', ['MEEPQSDPSVEPPLSQETFSDLWKLLPENNVLSPLPSQAMDD'], ['id'], on_batch=stop)


class BiomniTableTest(unittest.TestCase):
    def setUp(self):
        cache = Path(__file__).parent.parent / '.cache'
        cache.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='biomni-test-', dir=cache)
        self.root = Path(self.temp.name)
        self.env = mock.patch.dict(os.environ, {'ANNOBIO_BIOMNI_DATA_DIR': str(self.root), 'ANNOBIO_BIOMNI_CACHE_DIR': str(self.root / 'cache')})
        self.env.start()
        lake._SCHEMAS.clear()
        self.client = httpx.Client(transport=httpx.MockTransport(lambda request: self.fail('Unexpected network access')))

    def tearDown(self):
        self.client.close()
        self.env.stop()
        self.temp.cleanup()

    def test_snapshot_exact_filter_limit_and_provenance(self):
        name = 'evebio_compound_table.csv'
        (self.root / name).write_text('id,name\n1,aspirin\n2,caffeine\n3,caffeine\n', encoding='utf-8')
        info = lake.describe_snapshot_fields('lake_evebio', {'dataset': name}, self.client)
        self.assertIn('name', info['filter_columns'])
        batches = []
        rows = lake.fetch_snapshot_records('lake_evebio', ['caffeine', 'missing'], ['id', 'name', '__source_dataset'],
            {'dataset': name, 'filter_column': 'name', 'limit': 100}, self.client, lambda *args: batches.append(args))
        self.assertEqual([row['id'] for row in rows], ['2', '3'])
        self.assertEqual(rows[0]['__source_dataset'], name)
        self.assertEqual(batches[-1][1], ['missing'])
        rows = lake.fetch_snapshot_records('lake_evebio', [], ['id'], {'dataset': name, 'limit': 1}, self.client)
        self.assertEqual(rows, [{'id': '1'}])
        with self.assertRaisesRegex(ValueError, 'filter column'):
            lake.fetch_snapshot_records('lake_evebio', ['caffeine'], ['id'], {'dataset': name}, self.client)
        for value in (0, 2001):
            with self.assertRaises(ValueError):
                lake.fetch_snapshot_records('lake_evebio', [], ['id'], {'dataset': name, 'limit': value}, self.client)

    def test_ontology_json_obo_and_duplicate_text_headers(self):
        rows = list(lake._text_rows('go-plus.json', io.BytesIO(b'{"graphs":[{"nodes":[{"id":"GO:1","lbl":"test"}]}]}')))
        self.assertEqual(rows[0]['id'], 'GO:1')
        rows = list(lake._text_rows('hp.obo', io.BytesIO(b'[Term]\nid: HP:1\nname: test\nsynonym: first\nsynonym: second\n[Typedef]\nid: skip\n')))
        self.assertEqual(rows, [{'id': 'HP:1', 'name': 'test', 'synonym': 'first; second'}])
        rows = list(lake._text_rows('test.tsv', io.BytesIO(b'id\tid\t\n1\t2\t3\n')))
        self.assertEqual(rows, [{'id': '1', 'id (2)': '2', 'Column 3': '3'}])
        (self.root / 'hp.obo').write_text('[Term]\nid: HP:1\nname: root\n[Term]\nid: HP:2\nis_a: HP:1\nsynonym: child\n', encoding='utf-8')
        schema = lake.describe_snapshot_fields('lake_hpo', {}, self.client)
        self.assertIn('is_a', schema['fields'])
        self.assertIn('synonym', schema['filter_columns'])

    def test_parquet_range_reads_and_ignored_range_rejection(self):
        stream = io.BytesIO()
        pq.write_table(pa.table({'gene': ['TP53', 'BRCA1'], 'value': [0, 1]}), stream)
        payload = stream.getvalue()
        name = 'gene_info.parquet'
        metadata = {'bytes': len(payload), 'etag': 'fixture'}
        def handler(request):
            start, end = map(int, request.headers['range'].removeprefix('bytes=').split('-'))
            return httpx.Response(206, content=payload[start:end+1], headers={'Content-Range': f'bytes {start}-{end}/{len(payload)}', 'ETag': '"fixture"'})
        with mock.patch.dict(lake.FILES, {name: metadata}), httpx.Client(transport=httpx.MockTransport(handler)) as client:
            self.assertEqual(next(lake.iter_dataset_rows(client, name))['gene'], 'TP53')
        with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=payload))) as client:
            with self.assertRaisesRegex(ValueError, 'byte range'):
                lake.RangeFile(client, name).read(5)

    def test_allowlisted_dataframe_and_prepared_parquet_preserve_row_ids(self):
        name = 'gwas_catalog.pkl'
        frame = pd.DataFrame({'trait': ['height', 'BMI']}, dtype=object, index=pd.Index(['rs1', 'rs2'], dtype=object, name='variant'))
        frame.columns = pd.Index(['trait'], dtype=object)
        (self.root / name).write_bytes(pickle.dumps(frame, protocol=4))
        self.assertEqual(next(lake.iter_dataset_rows(self.client, name)), {'variant': 'rs1', 'trait': 'height'})
        from prepare_biomni_data import prepare
        target, count = prepare(name, self.root)
        self.assertEqual(count, 2)
        self.assertTrue(target.is_file())
        (self.root / name).unlink()
        self.assertEqual(next(lake.iter_dataset_rows(self.client, name)), {'variant': 'rs1', 'trait': 'height'})

    def test_restricted_pickle_and_file_allowlist_reject_untrusted_inputs(self):
        with self.assertRaisesRegex(pickle.UnpicklingError, 'Unsupported dataset constructor'):
            lake.RestrictedDatasetUnpickler(io.BytesIO(b'cos\nsystem\n.')).load()
        with self.assertRaises(ValueError): lake.resolve_dataset('lake_msigdb', {'dataset': '../../secret'})
        with self.assertRaises(ValueError): next(lake.iter_dataset_rows(self.client, '../../secret'))

    def test_cancellation_removes_partial_download_and_releases_lock(self):
        name = 'enamine_cloud_library_smiles.pkl'
        payload = pickle.dumps(['CCC'])
        def stop(): raise InterruptedError('cancelled')
        with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=payload))) as client:
            with self.assertRaises(InterruptedError): lake._pickle_path(client, name, stop)
        self.assertFalse((self.root / 'cache' / (name + '.part')).exists())
        self.assertFalse(lake._DOWNLOAD_LOCK.locked())

    def test_pickle_download_uses_verified_ranges_and_reuses_complete_cache(self):
        name = 'enamine_cloud_library_smiles.pkl'
        payload = pickle.dumps(['CCC', 'COC'])
        requests = []
        def handler(request):
            requests.append(request)
            return httpx.Response(206, content=payload, headers={'Content-Range': f'bytes 0-{len(payload)-1}/{len(payload)}', 'ETag': '"fixture"'})
        with mock.patch.dict(lake.FILES, {name: {'bytes': len(payload), 'etag': 'fixture'}}), httpx.Client(transport=httpx.MockTransport(handler)) as client:
            self.assertEqual(next(lake.iter_dataset_rows(client, name)), {'row': 0, 'value': 'CCC'})
            self.assertEqual(next(lake.iter_dataset_rows(client, name)), {'row': 0, 'value': 'CCC'})
        self.assertEqual(len(requests), 1)
        self.assertFalse((self.root / 'cache' / (name + '.part')).exists())


if __name__ == '__main__':
    unittest.main()
