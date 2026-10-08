import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRunResultsTable } from '../src/runResultsExport.js';
import { resolveHistoryCanvasState } from '../src/runHistoryResolver.js';
import { planHistorySelection } from '../src/runHistorySelection.js';
import { captureHistoryInput, runningHistoryRecord } from '../src/runHistoryCapture.js';
import { pipelineInputDatasetIds } from '../src/pipelineInputAvailability.js';
import { planChangeSet } from '../src/agent/operations/changeSet.js';
import { recordGraph } from './historyGraphFixture.mjs';
import { upgradeCanvasState } from '../src/canvasFormat.js';

// Prompt → Run → saved output → Process, as in historyGraphFixture.mjs without the saved Process output.
const content = (value) => ({ headers: ['text'], rows: [[value]], columnTypes: ['text'], rowIds: [`row-${value}`] });
const prompt = { type: 'prompt', nodeId: 'prompt', name: 'Prompt', sections: [{ content: 'Say {{text}}' }], outputFormat: { returnShape: 'single', fields: [{ key: 'answer', type: 'str' }] }, inputTypes: {} };
const input = { type: 'dataset', nodeId: 'input', name: 'Input', datasetContent: content('hello') };
const runResults = [{ row_index: 0, input_row_index: 0, output: { answer: 'world' } }];
const run = { type: 'run', nodeId: 'run', runWorkingSetId: 'input', runInputToColumn: '{"text":"text"}', runInputContent: JSON.stringify(input.datasetContent), runResults: JSON.stringify(runResults), runCompleted: '1' };
const exported = buildRunResultsTable({ results: runResults, runContent: input.datasetContent, schemaFields: prompt.outputFormat.fields });
const runDataset = { type: 'dataset', nodeId: 'run-dataset', name: 'Run export', sourceRunNodeId: 'run', datasetContent: { ...exported, rowIds: ['generated-id'] } };
const process = { type: 'process', nodeId: 'process', name: 'Process', dfCode: 'return df', primaryDatasetId: 'run-dataset', dfResults: JSON.stringify({ outputs: { result: { headers: ['answer'], rows: [['processed']] } } }) };
const graph = upgradeCanvasState({
  nodes: [input, prompt, run, runDataset, process],
  connections: [
    { type: 'prompt-to-run', fromId: 'prompt', toId: 'run' },
    { type: 'dataset-to-process', fromId: 'run-dataset', toId: 'process' },
  ],
});

async function setup() {
  const migrated = await recordGraph(graph);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const index = { records: migrated.records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) };
  const resolve = (state) => resolveHistoryCanvasState(state, { index, loadRecord: async (id) => records[id] });
  return { migrated, records, index, resolve };
}
const asCopy = (state, rows) => {
  const next = structuredClone(state);
  const dataset = next.nodes.find((node) => node.nodeId === 'run-dataset');
  dataset.savedCopy = true;
  if (rows) dataset.datasetContent = { ...dataset.datasetContent, rows };
  return next;
};
const datasetIn = (state) => state.nodes.find((node) => node.nodeId === 'run-dataset');

test('History never rewrites a saved copy, even when its Run has no current result', async () => {
  const { migrated, resolve } = await setup();
  const edited = asCopy(migrated.state, [['hello', 'edited']]);
  const resolved = await resolve(edited);
  assert.deepEqual(datasetIn(resolved.state).datasetContent.rows, [['hello', 'edited']]);
  assert.equal(datasetIn(resolved.state).sourceRunNodeId, 'run');

  edited.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0] = 'changed';
  const noRunResult = await resolve(edited);
  assert.ok(noRunResult.missingResultNodeIds.includes('run'));
  assert.equal(noRunResult.missingDatasetIds.includes('run-dataset'), false);
  assert.equal(datasetIn(noRunResult.state).resultMissing, undefined);
  assert.deepEqual(datasetIn(noRunResult.state).datasetContent.rows, [['hello', 'edited']]);
});

test('a Process reading a saved copy is keyed by the copy\'s content', async () => {
  const { migrated, records, index, resolve } = await setup();
  const copy = asCopy(migrated.state);
  const capture = await captureHistoryInput(copy, 'process', { index, loadRecord: async (id) => records[id] });
  assert.equal(capture.inputs.bindings[0].sourceRecordId, undefined);
  const edited = await captureHistoryInput(asCopy(migrated.state, [['other']]), 'process', { index, loadRecord: async (id) => records[id] });
  assert.notEqual(capture.signature, edited.signature);
  // The Process record migrated from the History-following output no longer matches the copy.
  assert.ok((await resolve(copy)).missingResultNodeIds.includes('process'));
});

test('selecting a record made from a saved copy restores its table and keeps the pipeline link', async () => {
  const { migrated, records, index } = await setup();
  const copy = asCopy(migrated.state, [['hello', 'v1']]);
  const capture = await captureHistoryInput(copy, 'process', { index, loadRecord: async (id) => records[id] });
  const record = { ...runningHistoryRecord(capture, { createId: () => 'c'.repeat(32), now: () => '2026-10-02T00:00:00Z' }), status: 'completed' };
  const all = { ...records, [record.id]: record };
  const later = asCopy(migrated.state, [['hello', 'v2']]);
  const selected = await planHistorySelection(later, record.id, { loadRecord: async (id) => all[id] });
  const dataset = datasetIn(selected.state);
  assert.deepEqual(dataset.datasetContent.rows, [['hello', 'v1']]);
  assert.equal(dataset.sourceRunNodeId, 'run');
  assert.equal(dataset.savedCopy, true);
});

test('selecting a record made while the output still followed History makes it follow again', async () => {
  const { migrated, records } = await setup();
  const processRecord = migrated.records.find((record) => record.nodeId === 'process');
  const selected = await planHistorySelection(asCopy(migrated.state), processRecord.id, { loadRecord: async (id) => records[id] });
  assert.equal(datasetIn(selected.state).savedCopy, undefined);
  assert.equal(datasetIn(selected.state).sourceRunNodeId, 'run');
});

test('pipelines still treat a saved copy as produced by its Run', () => {
  const state = asCopy(graph);
  const route = [{ type: 'dataset', dataset_node_id: 'input' }, { type: 'prompt', run_node_id: 'run' }, { type: 'dataset', dataset_node_id: 'run-dataset' }];
  assert.deepEqual(pipelineInputDatasetIds(route, state), ['input']);
});

test('the Agent saves outputs as copies stamped with the source History record', () => {
  const extractInputFields = () => ['text'];
  const state = { ...structuredClone(graph), historyVersion: 1 };
  const runRecordId = 'a'.repeat(32);
  const processRecordId = 'b'.repeat(32);
  state.nodes.find((node) => node.nodeId === 'run').historyRecordId = runRecordId;
  state.nodes.find((node) => node.nodeId === 'process').historyRecordId = processRecordId;
  const saved = planChangeSet(state, [{ op: 'save_run_results', ref: '$out', run: 'run' }], { extractInputFields });
  const savedDataset = saved.state.nodes.find((node) => node.nodeId === saved.refs.$out);
  assert.equal(savedDataset.savedCopy, true);
  assert.equal(savedDataset.snapshotSourceRecordId, runRecordId);
  const savedProcess = planChangeSet(state, [{ op: 'save_process_output', ref: '$p', process: 'process' }], { extractInputFields });
  const savedProcessDataset = savedProcess.state.nodes.find((node) => node.nodeId === savedProcess.refs.$p);
  assert.equal(savedProcessDataset.savedCopy, true);
  assert.equal(savedProcessDataset.snapshotSourceRecordId, processRecordId);
  assert.throws(
    () => planChangeSet(structuredClone(graph), [{ op: 'save_run_results', ref: '$out', run: 'run' }], { extractInputFields }),
    /no History record/,
  );
  const edited = planChangeSet(state, [{ op: 'update', node: 'run-dataset', set: { columns: ['text', 'answer'], rows: [['x', 'y']] } }], { extractInputFields });
  const dataset = datasetIn(edited.state);
  assert.equal(dataset.savedCopy, true);
  assert.equal(dataset.sourceRunNodeId, 'run');
  assert.equal(dataset.snapshotSourceRecordId, runRecordId);
});
