"""Agent row filters, bounded snapshot scans and online field projection."""
import os
import unittest
from unittest import mock

import biomni_data_lake as lake
import reference_import as ri
from agent.source_search import describe_sources
from record_filters import compile_filters


class RecordFiltersTest(unittest.TestCase):
    def test_text_numeric_missing_and_in_filters(self):
        fields = {'gene': '', 'score': '', 'empty': '', 'tags': ''}
        row = {'gene': 'BRCA1', 'score': '7.5', 'empty': None, 'tags': ['cancer', 'human']}
        for rule in (
            {'column': 'gene', 'value': 'brca1'},
            {'column': 'gene', 'op': 'in', 'values': ['tp53', 'brca1']},
            {'column': 'gene', 'op': 'not_equals', 'value': 'tp53'},
            {'column': 'tags', 'op': 'contains', 'value': 'CANCER'},
            {'column': 'score', 'op': 'gte', 'value': 7.5},
            {'column': 'score', 'op': 'gt', 'value': 7},
            {'column': 'score', 'op': 'lt', 'value': 8},
            {'column': 'score', 'op': 'lte', 'value': 7.5},
            {'column': 'empty', 'op': 'is_empty'},
            {'column': 'gene', 'op': 'not_empty'},
        ):
            with self.subTest(rule=rule): self.assertTrue(compile_filters([rule], fields)(row))
        self.assertFalse(compile_filters([{'column': 'gene', 'value': 'brca1', 'case_sensitive': True}], fields)(row))
        self.assertFalse(compile_filters([{'column': 'score', 'op': 'gt', 'value': 0}], fields)({'score': 'NaN'}))
        self.assertFalse(compile_filters([{'column': 'score', 'op': 'gt', 'value': 0}], fields)({'score': None}))
        self.assertFalse(compile_filters([{'column': 'gene', 'value': 'brca1'}, {'column': 'score', 'op': 'gte', 'value': 10}], fields)(row))

    def test_invalid_filters_are_rejected(self):
        for filters in ({}, [{}], [{'column': 'missing', 'value': 'x'}], [{'column': 'x', 'op': 'exec'}], [{'column': 'x', 'op': 'gte', 'value': 'nan'}], [{'column': 'x', 'op': 'gt', 'value': None}], [{'column': 'x', 'op': 'in', 'values': []}], [{'column': 'x'}] * 11):
            with self.subTest(filters=filters), self.assertRaises(ValueError): compile_filters(filters, {'x': ''})

    def test_snapshot_filters_run_before_the_row_cap(self):
        rows = [{'gene': 'wrong', 'score': 100}] * 5100 + [{'gene': 'BRCA1', 'score': i} for i in range(5)]
        options = {'dataset': 'msigdb_human_h_hallmark_geneset.parquet', 'limit': 2, 'filters': [{'column': 'gene', 'value': 'brca1'}, {'column': 'score', 'op': 'gte', 'value': 1}]}
        metadata, batches = [], []
        with mock.patch.object(lake, 'describe_snapshot_fields', return_value={'fields': {'gene': 'Gene', 'score': 'Score'}}), mock.patch.object(lake, 'iter_dataset_rows', lambda *args: (row for row in rows)):
            result = lake.fetch_snapshot_records('lake_msigdb', [], ['gene'], options, None, lambda *args: batches.append(args), metadata.append)
        self.assertEqual(result, [{'gene': 'BRCA1'}, {'gene': 'BRCA1'}])
        self.assertEqual(metadata, [{'truncated': True, 'row_limit': 2}])
        self.assertTrue(batches)

    def test_online_filters_fetch_unselected_columns_without_leaking_them(self):
        batch = mock.Mock(return_value={'1': {'id': '1', 'mass': '100'}, '2': {'id': '2', 'mass': '500'}})
        importer = {'fields': {'id': 'ID', 'mass': 'Mass'}, 'key': str, 'batch_size': 10, 'batch': batch}
        batches = []
        with mock.patch.dict(ri.REFERENCE_IMPORTERS, {'fixture_filter': importer}):
            result = ri.fetch_records('fixture_filter', ['1', '2'], ['id'], options={'filters': [{'column': 'mass', 'op': 'gt', 'value': 200}]}, on_batch=lambda *args: batches.append(args))
        self.assertEqual(batch.call_args.args[-1], ['id', 'mass'])
        self.assertEqual(result, [{'id': '2'}])
        self.assertEqual(batches[-1][1], [])  # Filtered records are not reported as missing IDs.

    def test_agent_discovery_respects_hosted_policy(self):
        with mock.patch.dict(os.environ, {'ANNOBIO_ENABLE_DATA_LAKE': '0'}):
            hosted = describe_sources()
            self.assertFalse(any(source.get('kind') == 'snapshot' for source in hosted.values()))
            self.assertTrue(hosted['pubchem']['row_filters'])
            self.assertFalse(hosted['pubmed']['row_filters'])
        with mock.patch.dict(os.environ, {'ANNOBIO_ENABLE_DATA_LAKE': '1'}):
            local = describe_sources()
            snapshots = [source for source in local.values() if source.get('kind') == 'snapshot']
            self.assertEqual(len(snapshots), 28)
            self.assertEqual(sum(len(source['datasets']) for source in snapshots), 76)


if __name__ == '__main__': unittest.main()
