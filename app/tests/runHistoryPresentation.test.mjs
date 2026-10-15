import test from 'node:test';
import assert from 'node:assert/strict';
import { describeHistoryRecord, historyStatusLabel } from '../src/runHistoryPresentation.js';

test('Run history shows the input name and clearly labels an output without a Dataset node', () => {
  const display = describeHistoryRecord({
    kind: 'run', nodeId: 'run', status: 'completed',
    inputs: { prompt: { name: 'Rewrite pair to UniProt names' }, dataset: { name: 'Pairs needing name rewrite', content: { rows: [] } } },
    results: { runResults: [] }, summary: { codeLine: 'def process(df):' },
  });
  assert.equal(display.title, 'Prompt: Rewrite pair to UniProt names');
  assert.equal(display.input, 'Input: Pairs needing name rewrite');
  assert.equal(display.output, 'Output: 0 rows (not exported as a Dataset node)');
  assert.equal(historyStatusLabel('completed'), 'Completed');
});

const saved = (nodeId, name, kind, recordId, port = 'result', extra = {}) => ({
  type: 'dataset', nodeId, name, savedFrom: { kind, nodeId: kind === 'process' ? 'process' : 'run', port, recordId, ...extra },
});

test('Run history names each Dataset saved from that record, and only those', () => {
  const record = {
    id: 'run-current', kind: 'run', nodeId: 'run',
    inputs: { dataset: { name: 'Input' } }, results: { runResults: [{ output: {} }] },
  };
  const canvas = { nodes: [
    saved('first', 'Extracted pairs', 'run', 'run-current'),
    saved('older', 'Extracted pairs (Copy 1)', 'run', 'run-old'),
    saved('second', 'Extracted pairs (Copy 2)', 'run', 'run-current'),
    { type: 'dataset', nodeId: 'plain', name: 'Input' },
  ], connections: [] };
  assert.equal(describeHistoryRecord(record, canvas).output, 'Output: Extracted pairs, Extracted pairs (Copy 2)');
  assert.equal(describeHistoryRecord({ ...record, id: 'run-old' }, canvas).output, 'Output: Extracted pairs (Copy 1)');
  assert.equal(describeHistoryRecord({ ...record, id: 'run-other' }, canvas).output, 'Output: 1 row (not exported as a Dataset node)');
});

test('Process history names saved branches and labels branches without one', () => {
  const display = describeHistoryRecord({
    id: 'process-current', kind: 'process', nodeId: 'process',
    inputs: { bindings: [{ name: 'Extracted pairs', content: { rows: [['one'], ['two']] } }] },
    results: { dfResults: { outputs: {
      ready_for_uniprot_matching: { headers: ['pair'], rows: [['one'], ['two']] },
      needs_name_rewrite: { headers: ['pair'], rows: [] },
    } } },
    summary: { codeLine: 'import requests', branchCount: 2 },
  }, {
    nodes: [
      saved('ready', 'Pairs ready for matching', 'process', 'process-current', 'ready_for_uniprot_matching'),
      saved('older', 'Older rewrite list', 'process', 'process-old', 'needs_name_rewrite'),
    ],
    connections: [],
  });
  assert.equal(display.title, '');
  assert.equal(display.input, 'Input: Extracted pairs');
  assert.equal(display.output, 'Output: Pairs ready for matching · needs name rewrite: 0 rows (not exported as a Dataset node)');
  assert.equal(display.output.includes('import requests'), false);
});

test('a single Process output uses the Dataset name when saved, or its row count when not', () => {
  const record = {
    id: 'process-current', kind: 'process', nodeId: 'process', inputs: { bindings: [] },
    results: { dfResults: { outputs: { result: { headers: ['answer'], rows: [] } } } },
  };
  assert.equal(describeHistoryRecord(record).output, 'Output: 0 rows (not exported as a Dataset node)');
  const display = describeHistoryRecord(record, { nodes: [saved('export', 'Processed pairs', 'process', 'process-current')], connections: [] });
  assert.equal(display.output, 'Output: Processed pairs');
});

test('a Dataset a Pipeline run added names the record it holds', () => {
  const record = {
    id: 'run-pipeline', kind: 'run', nodeId: 'run', pipelineRunId: 'p1',
    inputs: { dataset: { name: 'Input' } }, results: { runResults: [{ output: {} }] },
  };
  const canvas = { nodes: [saved('copy', 'Pipeline output', 'pipeline', 'run-pipeline', 'result', { pipelineRunId: 'p1' })], connections: [] };
  assert.equal(describeHistoryRecord(record, canvas).output, 'Output: Pipeline output');
});

test('an input is named as the Dataset it read, also in a record made before steps connected directly', () => {
  const merge = {
    id: 'merge-1', kind: 'process', nodeId: 'merge', pipelineRunId: 'run-1',
    inputs: { bindings: [
      { nodeId: 'ready', name: 'Pairs ready', alias: 'df', upstreamPipelineRecordId: 'check-1', sourceRecordId: 'check-1', sourceNodeId: 'check', branch: 'ready' },
      { nodeId: 'candidates', name: 'Candidates', alias: 'df_candidates', upstreamPipelineRecordId: 'search-1' },
    ] },
    results: { dfResults: { outputs: { result: { headers: ['pair'], rows: [] } } } },
  };
  const canvas = { nodes: [{ type: 'dataset', nodeId: 'ready-copy', name: 'Pairs ready (Copy 1)', savedFrom: { kind: 'pipeline', nodeId: 'check', port: 'ready', recordId: 'check-1', pipelineRunId: 'run-1' } }], connections: [] };
  assert.equal(describeHistoryRecord(merge, canvas).input, 'Input: Pairs ready, Candidates');
});
