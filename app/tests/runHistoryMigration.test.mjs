import test from 'node:test';
import assert from 'node:assert/strict';

import { planLegacyHistoryMigration } from '../src/runHistoryMigration.js';
import { buildRunResultsTable } from '../src/runResultsExport.js';
import { resolveHistoryCanvasState } from '../src/runHistoryResolver.js';
import { planHistorySelection } from '../src/runHistorySelection.js';
import { RunHistorySession } from '../src/runHistorySession.js';
import { captureHistoryInput, runningHistoryRecord } from '../src/runHistoryCapture.js';
import { detectPipelines } from '../src/pipelineDetection.js';

const content = (value) => ({ headers: ['text'], rows: [[value]], columnTypes: ['text'], rowIds: [`row-${value}`] });
const prompt = { type: 'prompt', nodeId: 'prompt', name: 'Prompt', sections: [{ content: 'Say {{text}}' }], outputFormat: { returnShape: 'single', fields: [{ key: 'answer', type: 'str' }] }, inputTypes: {} };
const input = { type: 'dataset', nodeId: 'input', name: 'Input', datasetContent: content('hello') };
const runResults = [{ row_index: 0, input_row_index: 0, output: { answer: 'world' } }];
const run = { type: 'run', nodeId: 'run', runWorkingSetId: 'input', runInputToColumn: '{"text":"text"}', runInputContent: JSON.stringify(input.datasetContent), runResults: JSON.stringify(runResults), runCompleted: '1' };
const exported = buildRunResultsTable({ results: runResults, runContent: input.datasetContent, schemaFields: prompt.outputFormat.fields });
const runDataset = { type: 'dataset', nodeId: 'run-dataset', name: 'Run export', sourceRunNodeId: 'run', datasetContent: { ...exported, rowIds: ['generated-id'] } };
const processResult = { headers: ['answer'], rows: [['processed']] };
const process = { type: 'process', nodeId: 'process', name: 'Process', dfCode: 'return df', primaryDatasetId: 'run-dataset', dfResults: JSON.stringify({ outputs: { result: processResult }, statusText: '1 branch returned.' }) };
const processDataset = { type: 'dataset', nodeId: 'process-dataset', name: 'Process export', processOutputName: 'result', datasetContent: { ...processResult, columnTypes: ['text'], rowIds: ['generated-id-2'] } };
const graph = {
  nodes: [input, prompt, run, runDataset, process, processDataset],
  connections: [
    { type: 'prompt-to-run', fromId: 'prompt', toId: 'run' },
    { type: 'dataset-to-process', fromId: 'run-dataset', toId: 'process' },
    { type: 'process-to-dataset', fromId: 'process', toId: 'process-dataset' },
  ],
};
function plan(state) {
  let next = 0;
  return planLegacyHistoryMigration(state, {
    createId: () => String(++next).padStart(32, '0'), now: () => '2026-10-01T00:00:00.000Z',
  });
}

test('legacy Run and Process results migrate through matching derived Datasets', async () => {
  const result = await plan(graph);
  assert.deepEqual(result.unmigratedNodeIds, []);
  assert.deepEqual(result.detachedDatasetIds, []);
  assert.equal(result.records.length, 2);
  const byNode = Object.fromEntries(result.records.map((record) => [record.nodeId, record]));
  assert.equal(byNode.run.status, 'completed');
  assert.equal(byNode.run.inputs.prompt.sections[0].content, 'Say {{text}}');
  assert.equal(byNode.process.inputs.bindings[0].sourceRecordId, byNode.run.id);
  assert.deepEqual(byNode.process.sourceRecordIds, [byNode.run.id]);
  assert.equal(result.state.nodes.find((node) => node.nodeId === 'process-dataset').processOutputName, 'result');
  assert.deepEqual(graph.nodes, [input, prompt, run, runDataset, process, processDataset]);
});

test('stopped Run and Process records restore an explicit Resume state', async () => {
  const migrated = await plan(graph);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, { ...record, status: 'stopped' }]));
  const index = { records: Object.values(records).map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) };
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
  const migrated = await plan(changed);
  assert.deepEqual(migrated.detachedDatasetIds, []);
  assert.equal(migrated.records.length, 2);
  const runRecord = migrated.records.find((record) => record.nodeId === 'run');
  assert.equal(runRecord.status, 'completed');
  assert.deepEqual(runRecord.results.runResults, []);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const index = { records: migrated.records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) };
  const resolved = await resolveHistoryCanvasState(migrated.state, { index, loadRecord: async (id) => records[id] });
  assert.deepEqual(resolved.missingDatasetIds, []);
  assert.deepEqual(resolved.missingResultNodeIds, []);
  assert.deepEqual(Object.keys(resolved.currentRecordIds).sort(), ['process', 'run']);
});

test('legacy Process object cells match their saved text export', async () => {
  const changed = structuredClone(graph);
  changed.nodes.find((node) => node.nodeId === 'process').dfResults = JSON.stringify({ outputs: {
    result: { headers: ['answer'], rows: [[[{ accession: 'P12345' }]]] },
  } });
  changed.nodes.find((node) => node.nodeId === 'process-dataset').datasetContent.rows = [['[object Object]']];
  const migrated = await plan(changed);
  assert.deepEqual(migrated.detachedDatasetIds, []);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const index = { records: migrated.records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) };
  const resolved = await resolveHistoryCanvasState(migrated.state, { index, loadRecord: async (id) => records[id] });
  assert.deepEqual(resolved.state.nodes.find((node) => node.nodeId === 'process-dataset').datasetContent.rows, [['[object Object]']]);
});

test('mismatched legacy exports keep their content and visual pipeline links without live provenance', async () => {
  const changed = structuredClone(graph);
  changed.nodes.find((node) => node.nodeId === 'run-dataset').datasetContent.rows[0][0] = 'manual edit';
  changed.nodes.find((node) => node.nodeId === 'process-dataset').datasetContent.rows[0][0] = 'older result';
  const result = await plan(changed);
  assert.deepEqual(new Set(result.detachedDatasetIds), new Set(['run-dataset', 'process-dataset']));
  assert.equal(result.records.length, 2);
  const processRecord = result.records.find((record) => record.nodeId === 'process');
  assert.deepEqual(processRecord.sourceRecordIds, []);
  const savedRunDataset = result.state.nodes.find((node) => node.nodeId === 'run-dataset');
  assert.equal(savedRunDataset.sourceRunNodeId, undefined);
  assert.equal(savedRunDataset.datasetContent.rows[0][0], 'manual edit');
  assert.equal(result.state.connections.some((edge) => edge.type === 'process-to-dataset'), false);
  assert.equal(result.state.connections.some((edge) => edge.type === 'run-to-dataset-snapshot' && edge.toId === 'run-dataset'), true);
  assert.equal(result.state.connections.some((edge) => edge.type === 'process-to-dataset-snapshot' && edge.toId === 'process-dataset'), true);
  assert.equal(detectPipelines(result.state).length, 1);
  const records = Object.fromEntries(result.records.map((record) => [record.id, record]));
  const index = { records: result.records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) };
  const resolved = await resolveHistoryCanvasState(result.state, { index, loadRecord: async (id) => records[id] });
  assert.deepEqual(Object.keys(resolved.currentRecordIds).sort(), ['process', 'run']);
  assert.equal(resolved.state.nodes.find((node) => node.nodeId === 'run-dataset').datasetContent.rows[0][0], 'manual edit');
  const selected = await planHistorySelection(result.state, processRecord.id, { loadRecord: async (id) => records[id] });
  assert.equal(selected.state.connections.some((edge) => edge.type === 'run-to-dataset-snapshot'), true);
  assert.equal(selected.state.connections.some((edge) => edge.type === 'process-to-dataset-snapshot'), true);
});

test('missing upstream result detaches old export without inventing history', async () => {
  const changed = structuredClone(graph);
  changed.nodes.find((node) => node.nodeId === 'run').runResults = '[]';
  changed.nodes.find((node) => node.nodeId === 'run').runCompleted = '';
  const result = await plan(changed);
  assert.deepEqual(result.detachedDatasetIds, ['run-dataset']);
  assert.deepEqual(result.records.map((record) => record.nodeId), ['process']);
  assert.deepEqual(result.records[0].sourceRecordIds, []);
});

test('legacy partial Run migrates as stopped with its saved rows', async () => {
  const changed = structuredClone(graph);
  changed.nodes.find((node) => node.nodeId === 'run').runCompleted = '';
  const result = await plan(changed);
  const runRecord = result.records.find((record) => record.nodeId === 'run');
  assert.equal(runRecord.status, 'stopped');
  assert.equal(runRecord.results.runResults.length, 1);
});

test('unmigratable upstream Run leaves its export as an ordinary Dataset', async () => {
  const changed = structuredClone(graph);
  changed.connections = changed.connections.filter((edge) => edge.type !== 'prompt-to-run');
  const result = await plan(changed);
  assert.deepEqual(result.unmigratedNodeIds, ['run']);
  assert.deepEqual(result.detachedDatasetIds, ['run-dataset']);
  assert.deepEqual(result.records.map((record) => record.nodeId), ['process']);
});

test('current input signatures restore matching results and clear downstream after input changes', async () => {
  const migrated = await plan(graph);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const index = { records: migrated.records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) };
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
  const migrated = await plan(graph);
  const runRecord = migrated.records.find((record) => record.kind === 'run');
  runRecord.results.runResults = [];
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const index = { records: migrated.records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) };
  const resolved = await resolveHistoryCanvasState(migrated.state, { index, loadRecord: async (id) => records[id] });
  const derived = resolved.state.nodes.find((node) => node.nodeId === 'run-dataset');
  assert.deepEqual(derived.datasetContent.rows, []);
  assert.equal(derived.resultMissing, undefined);
  assert.ok(derived.datasetContent.headers.length > 0);
});

test('matching index entry with a missing record fails instead of adopting stale canvas results', async () => {
  const migrated = await plan(graph);
  const index = { records: migrated.records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) };
  await assert.rejects(
    resolveHistoryCanvasState(migrated.state, { index, loadRecord: async () => null }),
    /History record is missing or invalid/,
  );
});

test('selecting a downstream record restores its ancestor inputs together', async () => {
  const migrated = await plan(graph);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const processRecord = migrated.records.find((record) => record.nodeId === 'process');
  const changed = structuredClone(migrated.state);
  changed.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0] = 'new input';
  changed.nodes.find((node) => node.nodeId === 'prompt').sections[0].content = 'new prompt';
  changed.nodes.find((node) => node.nodeId === 'process').dfCode = 'return df.head()';
  const selected = await planHistorySelection(changed, processRecord.id, { loadRecord: async (id) => records[id] });
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0], 'hello');
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'prompt').sections[0].content, 'Say {{text}}');
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'process').dfCode, 'return df');
  assert.deepEqual(new Set(Object.keys(selected.selectedRecordIds)), new Set(['run', 'process']));
  assert.deepEqual(new Set(selected.affectedNodeIds).has('process-dataset'), true);
});

test('history selection rejects conflicting shared Dataset requirements atomically', async () => {
  const migrated = await plan(graph);
  const processRecord = structuredClone(migrated.records.find((record) => record.nodeId === 'process'));
  const first = structuredClone(processRecord.inputs.bindings[0]);
  delete first.sourceRecordId;
  delete first.sourceNodeId;
  delete first.branch;
  const second = structuredClone(first);
  second.content.rows[0][0] = 'other input';
  processRecord.inputs.bindings = [first, second];
  const before = structuredClone(migrated.state);
  await assert.rejects(
    planHistorySelection(before, processRecord.id, { loadRecord: async () => processRecord }),
    /conflicts at dataset node run-dataset/,
  );
  assert.deepEqual(before, migrated.state);
});

test('history selection blocks a running affected descendant', async () => {
  const migrated = await plan(graph);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const processRecord = migrated.records.find((record) => record.nodeId === 'process');
  const changed = structuredClone(migrated.state);
  changed.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0] = 'new input';
  await assert.rejects(
    planHistorySelection(changed, processRecord.id, { loadRecord: async (id) => records[id], runningNodeIds: ['process'] }),
    /while node process is running/,
  );
  await assert.rejects(
    planHistorySelection(migrated.state, processRecord.id, { loadRecord: async (id) => records[id], runningNodeIds: ['process'] }),
    /while node process is running/,
  );
});

test('legacy migration resumes safely after records were saved but canvas save failed', async () => {
  const records = new Map();
  let failCanvasSave = true;
  let savedCanvas = null;
  let saves = 0;
  const storage = {
    loadIndex: async () => ({ version: 1, records: [...records.values()].map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) }),
    loadRecord: async (_projectId, id) => records.get(id),
    saveRecord: async (_projectId, record) => { saves += 1; records.set(record.id, record); },
    saveCanvas: async (_projectId, state) => {
      if (failCanvasSave) throw new Error('disk full');
      savedCanvas = state;
    },
  };
  const first = new RunHistorySession({ ...storage, createId: (() => { let id = 0; return () => String(++id).padStart(32, '0'); })(), now: () => '2026-10-01T00:00:00Z' });
  await assert.rejects(first.open('project', graph), /disk full/);
  assert.equal(records.size, 2);
  assert.equal(saves, 2);

  failCanvasSave = false;
  const resumed = new RunHistorySession({ ...storage, createId: () => 'f'.repeat(32), now: () => '2026-10-02T00:00:00Z' });
  const opened = await resumed.open('project', graph);
  assert.equal(saves, 2);
  assert.equal(savedCanvas.historyVersion, 1);
  assert.deepEqual(opened.missingResultNodeIds, []);
  assert.deepEqual(Object.keys(opened.currentRecordIds).sort(), ['process', 'run']);
});

test('new execution captures current upstream record IDs and a frozen input snapshot', async () => {
  const migrated = await plan(graph);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const index = { records: migrated.records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) };
  const capture = await captureHistoryInput(migrated.state, 'process', { index, loadRecord: async (id) => records[id] });
  const upstream = migrated.records.find((record) => record.nodeId === 'run');
  assert.deepEqual(capture.sourceRecordIds, [upstream.id]);
  assert.equal(capture.inputs.bindings[0].sourceRecordId, upstream.id);
  const item = runningHistoryRecord(capture, { createId: () => 'f'.repeat(32), now: () => '2026-10-01T00:00:00Z' });
  assert.equal(item.status, 'running');
  assert.equal(item.id, 'f'.repeat(32));
  migrated.state.nodes.find((node) => node.nodeId === 'run-dataset').datasetContent.rows[0][0] = 'changed';
  assert.notEqual(capture.inputs.bindings[0].content.rows[0][0], 'changed');
});

test('capture blocks a Process whose derived input has no current result', async () => {
  const migrated = await plan(graph);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const index = { records: migrated.records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) };
  const changed = structuredClone(migrated.state);
  changed.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0] = 'different';
  await assert.rejects(
    captureHistoryInput(changed, 'process', { index, loadRecord: async (id) => records[id] }),
    /Input Dataset has no current result/,
  );
});

test('completed inputs create a new attempt and History can select either identical-input result', async () => {
  const migrated = await plan(graph);
  const records = new Map(migrated.records.map((record) => [record.id, record]));
  let nextId = 900;
  const storage = {
    loadIndex: async () => ({ version: 1, records: [...records.values()].map(({ id, nodeId, kind, signature, status }) => ({ id, nodeId, kind, signature, status })) }),
    loadRecord: async (_project, id) => records.get(id),
    saveRecord: async (_project, record) => { records.set(record.id, record); },
    saveCanvas: async () => {},
  };
  const session = new RunHistorySession({ ...storage, createId: () => String(++nextId).padStart(32, '0'), now: () => '2026-10-02T00:00:00Z' });
  await session.open('project', migrated.state);
  const previous = migrated.records.find((record) => record.nodeId === 'run');
  const rerun = await session.reserve(migrated.state, 'run');
  assert.equal(rerun.mode, 'rerun');
  assert.notEqual(rerun.record.id, previous.id);
  assert.equal(rerun.record.signature, previous.signature);
  assert.equal(records.size, 3);
  await session.putRecord({ ...rerun.record, status: 'completed', results: previous.results });
  const latest = await session.resolve(migrated.state);
  assert.equal(latest.currentRecordIds.run, rerun.record.id);
  const selected = await session.select(previous.id, migrated.state);
  assert.equal(selected.currentRecordIds.run, previous.id);
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'run').historyRecordId, previous.id);

  const changed = structuredClone(migrated.state);
  changed.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0] = 'another input';
  const reserved = await session.reserve(changed, 'run');
  assert.equal(reserved.mode, 'new');
  assert.equal(reserved.record.status, 'running');
  assert.equal(records.size, 4);
  await assert.rejects(session.reserve(changed, 'run'), /already have a running job/);
});

test('opening a merged old canvas migrates only its unrecorded result nodes', async () => {
  const migrated = await plan(graph);
  const incoming = structuredClone(graph);
  incoming.nodes.forEach((node) => {
    node.nodeId = `new-${node.nodeId}`;
    if (node.runWorkingSetId) node.runWorkingSetId = `new-${node.runWorkingSetId}`;
    if (node.primaryDatasetId) node.primaryDatasetId = `new-${node.primaryDatasetId}`;
    if (node.sourceRunNodeId) node.sourceRunNodeId = `new-${node.sourceRunNodeId}`;
  });
  incoming.connections.forEach((edge) => { edge.fromId = `new-${edge.fromId}`; edge.toId = `new-${edge.toId}`; });
  const merged = { historyVersion: 1, nodes: [...migrated.state.nodes, ...incoming.nodes], connections: [...migrated.state.connections, ...incoming.connections] };
  const records = new Map(migrated.records.map((record) => [record.id, record]));
  let nextId = 100;
  let savedCanvas = null;
  const session = new RunHistorySession({
    loadIndex: async () => ({ version: 1, records: [...records.values()].map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) }),
    loadRecord: async (_project, id) => records.get(id),
    saveRecord: async (_project, record) => { records.set(record.id, record); },
    saveCanvas: async (_project, state) => { savedCanvas = state; },
    createId: () => String(++nextId).padStart(32, '0'), now: () => '2026-10-02T00:00:00Z',
  });
  const opened = await session.open('project', merged);
  assert.equal(records.size, 4);
  assert.ok(savedCanvas);
  assert.deepEqual(new Set(Object.keys(opened.currentRecordIds)), new Set(['run', 'process', 'new-run', 'new-process']));
  assert.equal(opened.migration.detachedDatasetIds.length, 0);
});

test('first open archives legacy Score and Review caches under their input signatures', async () => {
  const old = structuredClone(graph);
  old.nodes.push({
    type: 'score', nodeId: 'score', scoreGroundTruthId: 'input',
    scoreMapping: {}, scoreMatchResult: '{"matched":true}',
    scoreRowExcludedFromScoring: { 0: true }, reviewResult: '{"reviewed":true}',
  });
  old.connections.push({ type: 'run-to-score', fromId: 'run', toId: 'score' });
  const records = new Map();
  let nextId = 0;
  const session = new RunHistorySession({
    loadIndex: async () => ({ version: 1, records: [...records.values()].map(({ id, nodeId, kind, signature, status }) => ({ id, nodeId, kind, signature, status })) }),
    loadRecord: async (_project, id) => records.get(id),
    saveRecord: async (_project, record) => { records.set(record.id, record); },
    saveCanvas: async () => {},
    createId: () => String(++nextId).padStart(32, '0'), now: () => '2026-10-02T00:00:00Z',
  });
  await session.open('project', old);
  const score = [...records.values()].find((item) => item.kind === 'score');
  const review = [...records.values()].find((item) => item.kind === 'review');
  assert.equal(score.results.scoreMatchResult, '{"matched":true}');
  assert.equal(review.results.reviewResult, '{"reviewed":true}');
  assert.equal(score.inputs.runRecordId, [...records.values()].find((item) => item.kind === 'run').id);
});
