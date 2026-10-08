import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRunResultsTable } from '../src/runResultsExport.js';
import { resolveHistoryCanvasState } from '../src/runHistoryResolver.js';
import { captureHistoryInput } from '../src/runHistoryCapture.js';
import { graph, indexOf, prompt, recordGraph } from './historyGraphFixture.mjs';

test('stopped Run and Process records restore an explicit Resume state', async () => {
  const migrated = await recordGraph(graph);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, { ...record, status: 'stopped' }]));
  const index = indexOf(Object.values(records));
  const resolved = await resolveHistoryCanvasState(migrated.state, { index, loadRecord: async (id) => records[id] });
  assert.equal(resolved.state.nodes.find((node) => node.nodeId === 'run').runResumable, true);
  assert.equal(resolved.state.nodes.find((node) => node.nodeId === 'process').processResumable, true);
});

test('a completed zero-row Run and its empty Process output remain live history results', async () => {
  const changed = structuredClone(graph);
  const empty = { headers: ['text'], rows: [], columnTypes: ['text'], rowIds: [] };
  Object.assign(changed.nodes.find((node) => node.nodeId === 'input'), { datasetContent: empty });
  const runNode = changed.nodes.find((node) => node.nodeId === 'run');
  runNode.runInputContent = JSON.stringify(empty);
  runNode.runResults = '[]';
  runNode.runCompleted = '1';
  changed.nodes.find((node) => node.nodeId === 'run-dataset').datasetContent = {
    ...buildRunResultsTable({ results: [], runContent: empty, schemaFields: prompt.outputFormat.fields }), rowIds: [],
  };
  changed.nodes.find((node) => node.nodeId === 'process').dfResults = JSON.stringify({ outputs: { result: { headers: ['answer'], rows: [] } } });
  changed.nodes.find((node) => node.nodeId === 'process-dataset').datasetContent = { headers: ['answer'], rows: [], columnTypes: ['text'], rowIds: [] };
  const captured = await captureHistoryInput(changed, 'run', { index: { records: [] }, loadRecord: async () => null });
  assert.deepEqual(captured.inputs.dataset.content.rows, []);
  const migrated = await recordGraph(changed);
  assert.equal(migrated.records.length, 2);
  const runRecord = migrated.records.find((record) => record.nodeId === 'run');
  assert.equal(runRecord.status, 'completed');
  assert.deepEqual(runRecord.results.runResults, []);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const resolved = await resolveHistoryCanvasState(migrated.state, { index: indexOf(migrated.records), loadRecord: async (id) => records[id] });
  assert.deepEqual(resolved.missingDatasetIds, []);
  assert.deepEqual(resolved.missingResultNodeIds, []);
  assert.deepEqual(Object.keys(resolved.currentRecordIds).sort(), ['process', 'run']);
});

test('current input signatures restore matching results and clear downstream after input changes', async () => {
  const migrated = await recordGraph(graph);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const index = indexOf(migrated.records);
  const resolve = (state) => resolveHistoryCanvasState(state, { index, loadRecord: async (id) => records[id] });

  const original = await resolve(migrated.state);
  assert.deepEqual(original.missingResultNodeIds, []);
  assert.deepEqual(original.missingDatasetIds, []);
  assert.deepEqual(Object.keys(original.currentRecordIds).sort(), ['process', 'run']);
  assert.deepEqual(original.state.nodes.find((node) => node.nodeId === 'process-dataset').datasetContent.rows, [['processed']]);

  const changed = structuredClone(migrated.state);
  changed.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0] = 'changed';
  const noMatch = await resolve(changed);
  assert.deepEqual(new Set(noMatch.missingResultNodeIds), new Set(['run', 'process']));
  assert.deepEqual(new Set(noMatch.missingDatasetIds), new Set(['run-dataset', 'process-dataset']));
  assert.equal(noMatch.state.nodes.find((node) => node.nodeId === 'run').runResults, undefined);
  assert.deepEqual(noMatch.state.nodes.find((node) => node.nodeId === 'process-dataset').datasetContent.rows, []);
  assert.equal(noMatch.state.nodes.find((node) => node.nodeId === 'run-dataset').resultMissing, true);
  assert.equal(noMatch.state.nodes.find((node) => node.nodeId === 'process-dataset').resultMissing, true);

  const restored = await resolve(migrated.state);
  assert.equal(restored.state.nodes.find((node) => node.nodeId === 'run').runCompleted, '1');
  assert.deepEqual(restored.state.nodes.find((node) => node.nodeId === 'process-dataset').datasetContent.rows, [['processed']]);
  assert.equal(restored.state.nodes.find((node) => node.nodeId === 'process-dataset').resultMissing, undefined);
});

test('a completed Run with zero rows produces a valid empty Dataset', async () => {
  const migrated = await recordGraph(graph);
  const runRecord = migrated.records.find((record) => record.kind === 'run');
  runRecord.results.runResults = [];
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const resolved = await resolveHistoryCanvasState(migrated.state, { index: indexOf(migrated.records), loadRecord: async (id) => records[id] });
  const derived = resolved.state.nodes.find((node) => node.nodeId === 'run-dataset');
  assert.deepEqual(derived.datasetContent.rows, []);
  assert.equal(derived.resultMissing, undefined);
  assert.ok(derived.datasetContent.headers.length > 0);
});

test('matching index entry with a missing record fails instead of adopting stale canvas results', async () => {
  const migrated = await recordGraph(graph);
  await assert.rejects(
    resolveHistoryCanvasState(migrated.state, { index: indexOf(migrated.records), loadRecord: async () => null }),
    /History record is missing or invalid/,
  );
});
