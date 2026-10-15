import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveHistoryCanvasState } from '../src/runHistoryResolver.js';
import { captureHistoryInput } from '../src/runHistoryCapture.js';
import { stepOutputTable } from '../src/stepOutputs.js';
import { graph, indexOf, recordGraph } from './historyGraphFixture.mjs';

test('stopped Run and Process records restore an explicit Resume state', async () => {
  const migrated = await recordGraph(graph);
  const resolveStopped = (kind) => {
    const records = Object.fromEntries(migrated.records.map((record) => [record.id, { ...record, status: record.kind === kind ? 'stopped' : record.status }]));
    return resolveHistoryCanvasState(migrated.state, { index: indexOf(Object.values(records)), loadRecord: async (id) => records[id] });
  };
  const run = (await resolveStopped('run')).state.nodes;
  assert.equal(run.find((node) => node.nodeId === 'run').runResumable, true);
  // The Process reads the stopped Run's output, so it waits for the Run to finish.
  assert.equal(run.find((node) => node.nodeId === 'process').waitingForUpstream, true);
  const process = (await resolveStopped('process')).state.nodes;
  assert.equal(process.find((node) => node.nodeId === 'process').processResumable, true);
});

test('a completed zero-row Run and its empty Process output remain live history results', async () => {
  const changed = structuredClone(graph);
  const empty = { headers: ['text'], rows: [], columnTypes: ['text'], rowIds: [] };
  Object.assign(changed.nodes.find((node) => node.nodeId === 'input'), { datasetContent: empty });
  const runNode = changed.nodes.find((node) => node.nodeId === 'run');
  runNode.runInputContent = JSON.stringify(empty);
  runNode.runResults = '[]';
  runNode.runCompleted = '1';
  changed.nodes.find((node) => node.nodeId === 'process').dfResults = JSON.stringify({ outputs: { result: { headers: ['answer'], rows: [] } } });
  const captured = await captureHistoryInput(changed, 'run', { index: { records: [] }, loadRecord: async () => null });
  assert.deepEqual(captured.inputs.dataset.content.rows, []);
  const migrated = await recordGraph(changed);
  assert.equal(migrated.records.length, 2);
  const runRecord = migrated.records.find((record) => record.nodeId === 'run');
  assert.equal(runRecord.status, 'completed');
  assert.deepEqual(runRecord.results.runResults, []);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const resolved = await resolveHistoryCanvasState(migrated.state, { index: indexOf(migrated.records), loadRecord: async (id) => records[id] });
  assert.deepEqual(resolved.missingResultNodeIds, []);
  assert.deepEqual(Object.keys(resolved.currentRecordIds).sort(), ['process', 'run']);
});

test('current input signatures restore matching results and clear downstream after input changes', async () => {
  const migrated = await recordGraph(graph);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const index = indexOf(migrated.records);
  const resolve = (state) => resolveHistoryCanvasState(state, { index, loadRecord: async (id) => records[id] });

  const original = await resolve(migrated.state);
  const processOf = (resolved) => resolved.state.nodes.find((node) => node.nodeId === 'process');
  assert.deepEqual(original.missingResultNodeIds, []);
  assert.deepEqual(Object.keys(original.currentRecordIds).sort(), ['process', 'run']);
  assert.deepEqual(JSON.parse(processOf(original).dfResults).outputs.result.rows, [['processed']]);

  const changed = structuredClone(migrated.state);
  changed.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0] = 'changed';
  const noMatch = await resolve(changed);
  assert.deepEqual(new Set(noMatch.missingResultNodeIds), new Set(['run', 'process']));
  assert.equal(noMatch.state.nodes.find((node) => node.nodeId === 'run').runResults, undefined);
  // The Process reads the Run, which has no result for its new input: it waits for it.
  assert.equal(processOf(noMatch).dfResults, undefined);
  assert.equal(processOf(noMatch).waitingForUpstream, true);

  const restored = await resolve(migrated.state);
  assert.equal(restored.state.nodes.find((node) => node.nodeId === 'run').runCompleted, '1');
  assert.deepEqual(JSON.parse(processOf(restored).dfResults).outputs.result.rows, [['processed']]);
  assert.equal(processOf(restored).waitingForUpstream, undefined);
});

test('a completed Run with zero rows gives its readers a valid empty table', async () => {
  const migrated = await recordGraph(graph);
  const runRecord = migrated.records.find((record) => record.kind === 'run');
  runRecord.results.runResults = [];
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const resolved = await resolveHistoryCanvasState(migrated.state, { index: indexOf(migrated.records), loadRecord: async (id) => records[id] });
  const { table } = stepOutputTable(resolved.state, { nodeId: 'run', port: 'result', kind: 'run' });
  assert.deepEqual(table.rows, []);
  assert.ok(table.headers.length > 0);
});

test('matching index entry with a missing record fails instead of adopting stale canvas results', async () => {
  const migrated = await recordGraph(graph);
  await assert.rejects(
    resolveHistoryCanvasState(migrated.state, { index: indexOf(migrated.records), loadRecord: async () => null }),
    /History record is missing or invalid/,
  );
});
