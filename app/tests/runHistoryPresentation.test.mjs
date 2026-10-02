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

test('Run history names its exported Dataset node', () => {
  const display = describeHistoryRecord({
    kind: 'run', nodeId: 'run', inputs: { dataset: { name: 'Input' } }, results: { runResults: [{ output: {} }] },
  }, { nodes: [{ type: 'dataset', nodeId: 'export', name: 'Run output', sourceRunNodeId: 'run' }] });
  assert.equal(display.output, 'Output: Run output');
});

test('Process history names exported nodes and labels branches without one', () => {
  const display = describeHistoryRecord({
    kind: 'process', nodeId: 'process',
    inputs: { bindings: [{ name: 'Extracted pairs', content: { rows: [['one'], ['two']] } }] },
    results: { dfResults: { outputs: {
      ready_for_uniprot_matching: { headers: ['pair'], rows: [['one'], ['two']] },
      needs_name_rewrite: { headers: ['pair'], rows: [] },
    } } },
    summary: { codeLine: 'import requests', branchCount: 2 },
  }, {
    nodes: [{ type: 'dataset', nodeId: 'ready', name: 'Pairs ready for matching', processOutputName: 'ready_for_uniprot_matching' }],
    connections: [{ type: 'process-to-dataset', fromId: 'process', toId: 'ready' }],
  });
  assert.equal(display.title, '');
  assert.equal(display.input, 'Input: Extracted pairs');
  assert.equal(display.output, 'Output: Pairs ready for matching · needs name rewrite: 0 rows (not exported as a Dataset node)');
  assert.equal(display.output.includes('import requests'), false);
});

test('a single Process output uses the Dataset name when exported, or its row count when not', () => {
  const record = {
    kind: 'process', nodeId: 'process', inputs: { bindings: [] },
    results: { dfResults: { outputs: { result: { headers: ['answer'], rows: [] } } } },
  };
  const withoutExport = describeHistoryRecord(record);
  assert.equal(withoutExport.output, 'Output: 0 rows (not exported as a Dataset node)');
  const display = describeHistoryRecord({
    ...record,
  }, {
    nodes: [{ type: 'dataset', nodeId: 'export', name: 'Processed pairs' }],
    connections: [{ type: 'process-to-dataset', fromId: 'process', toId: 'export' }],
  });
  assert.equal(display.output, 'Output: Processed pairs');
});

test('a legacy single named Process branch can use its exported node without saved branch metadata', () => {
  const display = describeHistoryRecord({
    kind: 'process', nodeId: 'process', inputs: { bindings: [] },
    results: { dfResults: { outputs: { selected: { headers: ['answer'], rows: [['yes']] } } } },
  }, {
    nodes: [{ type: 'dataset', nodeId: 'export', name: 'Selected pairs' }],
    connections: [{ type: 'process-to-dataset', fromId: 'process', toId: 'export' }],
  });
  assert.equal(display.output, 'Output: Selected pairs');
});
