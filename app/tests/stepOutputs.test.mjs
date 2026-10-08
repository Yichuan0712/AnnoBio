import test from 'node:test';
import assert from 'node:assert/strict';

import { stepOutputTable } from '../src/stepOutputs.js';
import { buildRunResultsTable } from '../src/runResultsExport.js';

const input = { headers: ['text'], rows: [['a'], ['b'], ['c']] };
const fields = [{ key: 'answer', type: 'str' }];
const results = [
  { row_index: 0, input_row_index: 0, output: { answer: 'A' } },
  { row_index: 1, input_row_index: 1, error: 'Timed out' },
  { row_index: 2, input_row_index: 2, output: {} },
];
const outputs = {
  left: { headers: ['id'], rows: [['1'], ['2']], rowIds: ['l-1'] },
  right: { headers: ['id'], rows: [['3']] },
};
const state = (run = {}, processNode = {}, dataset = {}) => ({
  nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: input, ...dataset },
    { type: 'dataset', nodeId: 'sample', name: 'Sample', subsetContent: { headers: ['text'], rows: [['b']] } },
    { type: 'prompt', nodeId: 'p', name: 'Extract', outputFormat: { returnShape: 'single', fields } },
    {
      type: 'run', nodeId: 'r', runCompleted: '1', historyRecordId: 'rec-r',
      runInputContent: JSON.stringify(input), runResults: JSON.stringify(results), ...run,
    },
    { type: 'process', nodeId: 'split', name: 'Split', historyRecordId: 'rec-p', dfResults: JSON.stringify({ outputs }), ...processNode },
  ],
  connections: [{ type: 'prompt-to-run', fromId: 'p', toId: 'r' }],
});

test('a Dataset gives its content, a Sampler subset included', () => {
  assert.equal(stepOutputTable(state(), { nodeId: 'raw' }).table, input);
  assert.deepEqual(stepOutputTable(state(), { nodeId: 'sample' }).table.rows, [['b']]);
  assert.deepEqual(stepOutputTable(state({}, {}, { resultMissing: true }), { nodeId: 'raw' }), { waiting: 'no-result' });
  assert.deepEqual(stepOutputTable(state(), { nodeId: 'deleted' }), { waiting: 'no-result' });
  assert.deepEqual(stepOutputTable(state(), null), { waiting: 'no-result' });
});

test('a completed Run gives the table Save results makes, failed rows included and counted', () => {
  const { table, errorRowCount } = stepOutputTable(state(), { nodeId: 'r', port: 'result' });
  const expected = buildRunResultsTable({ results, runContent: input, schemaFields: fields });
  assert.deepEqual(table, { ...expected, rowIds: ['rec-r:result:0', 'rec-r:result:1', 'rec-r:result:2'] });
  assert.deepEqual(table.rows[1].slice(-1), ['Timed out']);
  // An empty output is not an error in buildRunResultsTable (markEmptyOutputAsError keeps it), so it is not counted.
  assert.deepEqual(table.rows[2].slice(-1), ['—']);
  assert.equal(errorRowCount, 1);
});

test('a Run without a complete result makes its readers wait', () => {
  assert.deepEqual(stepOutputTable(state({ runPending: true }), { nodeId: 'r', port: 'result' }), { waiting: 'running' });
  assert.deepEqual(stepOutputTable(state({ runCompleted: undefined }), { nodeId: 'r', port: 'result' }), { waiting: 'no-result' });
  assert.deepEqual(stepOutputTable(state({ runCompleted: undefined, runResumable: '1' }), { nodeId: 'r', port: 'result' }), { waiting: 'stopped' });
  assert.deepEqual(stepOutputTable(state(), { nodeId: 'r', port: 'other' }), { waiting: 'missing-port' });
});

test('a Process gives one branch of its result', () => {
  assert.deepEqual(stepOutputTable(state(), { nodeId: 'split', port: 'left' }), {
    table: { headers: ['id'], rows: [['1'], ['2']], columnTypes: [], rowIds: ['l-1', 'rec-p:left:1'] },
  });
  assert.deepEqual(stepOutputTable(state(), { nodeId: 'split', port: 'gone' }), { waiting: 'missing-port' });
  assert.deepEqual(stepOutputTable(state({}, { processPending: true }), { nodeId: 'split', port: 'left' }), { waiting: 'running' });
  assert.deepEqual(stepOutputTable(state({}, { processResumable: true }), { nodeId: 'split', port: 'left' }), { waiting: 'stopped' });
  assert.deepEqual(stepOutputTable(state({}, { dfResults: undefined }), { nodeId: 'split', port: 'left' }), { waiting: 'no-result' });
  // A result saved before branches existed is the single output.
  const single = state({}, { dfResults: JSON.stringify({ headers: ['x'], rows: [['1']] }) });
  assert.deepEqual(stepOutputTable(single, { nodeId: 'split', port: 'result' }).table.rows, [['1']]);
});
