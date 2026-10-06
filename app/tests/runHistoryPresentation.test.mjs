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

test('Run history maps the live Dataset and each saved copy to its exact record', () => {
  const record = {
    id: 'run-current', kind: 'run', nodeId: 'run',
    inputs: { dataset: { name: 'Input' } }, results: { runResults: [{ output: {} }] },
  };
  const canvas = { nodes: [
    { type: 'dataset', nodeId: 'live', name: 'Extracted pairs', sourceRunNodeId: 'run', snapshotSourceRecordId: 'run-current' },
    { type: 'dataset', nodeId: 'copy-1', name: 'Extracted pairs (Copy 1)', sourceRunNodeId: 'run', savedCopy: true, snapshotSourceRecordId: 'run-old' },
    { type: 'dataset', nodeId: 'copy-2', name: 'Extracted pairs (Copy 2)', sourceRunNodeId: 'run', savedCopy: true, snapshotSourceRecordId: 'run-other' },
  ], connections: [] };
  const current = describeHistoryRecord(record, canvas, { currentRecordIds: { run: 'run-current' } });
  assert.equal(current.output, 'Output: Extracted pairs');
  const historical = describeHistoryRecord({ ...record, id: 'run-old' }, canvas, { currentRecordIds: { run: 'run-current' } });
  assert.equal(historical.output, 'Output: Extracted pairs (Copy 1)');
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

test('Process history maps the live Dataset and saved copies to their exact records', () => {
  const record = {
    id: 'process-current', kind: 'process', nodeId: 'process', inputs: { bindings: [] },
    results: { dfResults: { outputs: { result: { headers: ['answer'], rows: [['yes']] } } } },
  };
  const canvas = {
    nodes: [
      { type: 'dataset', nodeId: 'live', name: 'Matched pairs', processOutputName: 'result', snapshotSourceRecordId: 'process-current' },
      { type: 'dataset', nodeId: 'copy', name: 'Matched pairs (Copy)', processOutputName: 'result', savedCopy: true, snapshotSourceRecordId: 'process-old' },
    ],
    connections: [
      { type: 'process-to-dataset', fromId: 'process', toId: 'live' },
      { type: 'process-to-dataset-snapshot', fromId: 'process', toId: 'copy' },
    ],
  };
  const display = describeHistoryRecord(record, canvas, { currentRecordIds: { process: 'process-current' } });
  assert.equal(display.output, 'Output: Matched pairs');
  const historical = describeHistoryRecord({ ...record, id: 'process-old' }, canvas, {
    currentRecordIds: { process: 'process-current' },
  });
  assert.equal(historical.output, 'Output: Matched pairs (Copy)');
});

test('History shows one output when a current result also has a published copy', () => {
  const record = {
    id: 'process-current', kind: 'process', nodeId: 'process', inputs: { bindings: [] },
    results: { dfResults: { outputs: { result: { headers: ['answer'], rows: [['yes']] } } } },
  };
  const canvas = {
    nodes: [
      { type: 'dataset', nodeId: 'live', name: 'Matched pairs', processOutputName: 'result', snapshotSourceRecordId: 'process-current' },
      { type: 'dataset', nodeId: 'copy', name: 'Matched pairs (Copy)', processOutputName: 'result', savedCopy: true,
        snapshotSourceRecordId: 'process-current' },
    ],
    connections: [
      { type: 'process-to-dataset', fromId: 'process', toId: 'live' },
      { type: 'process-to-dataset-snapshot', fromId: 'process', toId: 'copy' },
    ],
  };
  const display = describeHistoryRecord(record, canvas, { currentRecordIds: { process: 'process-current' } });
  assert.equal(display.output, 'Output: Matched pairs');
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

test('a multi-input Process from an earlier Pipeline run names the copies that run published', () => {
  const pipelineRecord = (id, nodeId, kind, pipelineRunId) => ({ id, nodeId, kind, pipelineRunId });
  const records = new Map([
    pipelineRecord('check-1', 'check', 'process', 'run-1'), pipelineRecord('check-2', 'check', 'process', 'run-2'),
    pipelineRecord('search-1', 'search', 'process', 'run-1'), pipelineRecord('search-2', 'search', 'process', 'run-2'),
  ].map((record) => [record.id, record]));
  // Recorded under the original Datasets, as Pipeline runs did before every Process input moved onto its copy.
  const merge = (id, run) => ({
    id, kind: 'process', nodeId: 'merge', pipelineRunId: `run-${run}`,
    inputs: { bindings: [
      { nodeId: 'ready', name: 'Pairs ready', alias: 'df', upstreamPipelineRecordId: `check-${run}`,
        sourceRecordId: `check-${run}`, sourceNodeId: 'check', branch: 'ready' },
      { nodeId: 'candidates', name: 'Candidates', alias: 'df_candidates', upstreamPipelineRecordId: `search-${run}`,
        sourceRecordId: `search-${run}`, sourceNodeId: 'search', branch: 'result' },
    ] },
    results: { dfResults: { outputs: { result: { headers: ['pair'], rows: [] } } } },
  });
  const dataset = (nodeId, name, processOutputName, snapshotSourceRecordId, pipelineRunId) => ({
    type: 'dataset', nodeId, name, processOutputName, snapshotSourceRecordId,
    ...(pipelineRunId ? { savedCopy: true, pipelineRunId } : {}),
  });
  const canvas = {
    nodes: [
      dataset('ready', 'Pairs ready', 'ready', 'check-2'),
      dataset('ready-1', 'Pairs ready (Copy 1)', 'ready', 'check-1', 'run-1'),
      dataset('ready-2', 'Pairs ready (Copy 2)', 'ready', 'check-2', 'run-2'),
      dataset('rewrite-2', 'Pairs to rewrite (Copy 2)', 'rewrite', 'check-2', 'run-2'),
      dataset('candidates', 'Candidates', 'result', 'search-2'),
      dataset('candidates-1', 'Candidates (Copy 1)', 'result', 'search-1', 'run-1'),
      dataset('candidates-2', 'Candidates (Copy 2)', 'result', 'search-2', 'run-2'),
    ],
    connections: [
      ...['ready', 'ready-1', 'ready-2', 'rewrite-2'].map((toId) => ({ type: 'process-to-dataset-snapshot', fromId: 'check', toId })),
      ...['candidates', 'candidates-1', 'candidates-2'].map((toId) => ({ type: 'process-to-dataset-snapshot', fromId: 'search', toId })),
    ],
  };
  assert.equal(describeHistoryRecord(merge('merge-1', 1), canvas, { recordById: records }).input,
    'Input: Pairs ready (Copy 1), Candidates (Copy 1)');
  assert.equal(describeHistoryRecord(merge('merge-2', 2), canvas, { recordById: records }).input,
    'Input: Pairs ready (Copy 2), Candidates (Copy 2)');
  assert.equal(describeHistoryRecord(merge('merge-2', 2), canvas).input, 'Input: Pairs ready, Candidates');
});
