import test from 'node:test';
import assert from 'node:assert/strict';

import { planLegacyHistoryMigration } from '../src/runHistoryMigration.js';
import { buildRunResultsTable } from '../src/runResultsExport.js';
import { resolveHistoryCanvasState } from '../src/runHistoryResolver.js';
import { planHistorySelection } from '../src/runHistorySelection.js';
import { RunHistorySession } from '../src/runHistorySession.js';
import { captureHistoryInput, runningHistoryRecord } from '../src/runHistoryCapture.js';

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

test('mismatched legacy static exports keep their content and lose provenance', async () => {
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
});

test('missing upstream result detaches old export without inventing history', async () => {
  const changed = structuredClone(graph);
  changed.nodes.find((node) => node.nodeId === 'run').runResults = '[]';
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

  const restored = await resolve(migrated.state);
  assert.equal(restored.state.nodes.find((node) => node.nodeId === 'run').runCompleted, '1');
  assert.deepEqual(restored.state.nodes.find((node) => node.nodeId === 'process-dataset').datasetContent.rows, [['processed']]);
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

test('reservation rejects completed input and creates exactly one new signature', async () => {
  const migrated = await plan(graph);
  const records = new Map(migrated.records.map((record) => [record.id, record]));
  const storage = {
    loadIndex: async () => ({ version: 1, records: [...records.values()].map(({ id, nodeId, kind, signature, status }) => ({ id, nodeId, kind, signature, status })) }),
    loadRecord: async (_project, id) => records.get(id),
    saveRecord: async (_project, record) => {
      if ([...records.values()].some((item) => item.id !== record.id && item.nodeId === record.nodeId && item.signature === record.signature)) throw new Error('duplicate');
      records.set(record.id, record);
    },
    saveCanvas: async () => {},
  };
  const session = new RunHistorySession({ ...storage, createId: () => 'f'.repeat(32), now: () => '2026-10-02T00:00:00Z' });
  await session.open('project', migrated.state);
  await assert.rejects(session.reserve(migrated.state, 'run'), /Run completed for these inputs/);
  const changed = structuredClone(migrated.state);
  changed.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0] = 'another input';
  const reserved = await session.reserve(changed, 'run');
  assert.equal(reserved.mode, 'new');
  assert.equal(reserved.record.status, 'running');
  assert.equal(records.size, 3);
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
