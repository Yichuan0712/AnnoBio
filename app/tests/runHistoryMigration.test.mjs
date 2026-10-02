import test from 'node:test';
import assert from 'node:assert/strict';

import { planLegacyHistoryMigration } from '../src/runHistoryMigration.js';
import { buildRunResultsTable } from '../src/runResultsExport.js';
import { resolveHistoryCanvasState } from '../src/runHistoryResolver.js';

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
