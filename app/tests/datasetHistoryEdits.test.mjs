import test from 'node:test';
import assert from 'node:assert/strict';

import { planLegacyHistoryMigration } from '../src/runHistoryMigration.js';
import { buildRunResultsTable } from '../src/runResultsExport.js';
import { resolveHistoryCanvasState } from '../src/runHistoryResolver.js';
import { planHistorySelection } from '../src/runHistorySelection.js';
import { captureHistoryInput, runningHistoryRecord } from '../src/runHistoryCapture.js';
import { analysisInputKeys } from '../src/runAnalysisHistory.js';
import { describeHistoryRecord } from '../src/runHistoryPresentation.js';
import { withHistoryEdit } from '../src/datasetHistoryEdits.js';

// Same Prompt → Run → derived Dataset → Process → derived Dataset graph as runHistoryMigration.test.mjs.
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

async function setup() {
  let next = 0;
  const migrated = await planLegacyHistoryMigration(graph, {
    createId: () => String(++next).padStart(32, '0'), now: () => '2026-10-01T00:00:00.000Z',
  });
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const index = { records: migrated.records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) };
  const runRecord = migrated.records.find((record) => record.nodeId === 'run');
  const processRecord = migrated.records.find((record) => record.nodeId === 'process');
  const resolve = (state) => resolveHistoryCanvasState(state, { index, loadRecord: async (id) => records[id] });
  return { migrated, records, index, runRecord, processRecord, resolve };
}

function withEdit(state, runRecordId, rows) {
  const next = structuredClone(state);
  const dataset = next.nodes.find((node) => node.nodeId === 'run-dataset');
  dataset.historyEdits = withHistoryEdit(dataset.historyEdits, runRecordId, 'result', { ...structuredClone(dataset.datasetContent), rows });
  return next;
}

test('a hand-edited derived Dataset keeps following History and shows its edit for that record', async () => {
  const { migrated, runRecord, resolve } = await setup();
  const edited = await resolve(withEdit(migrated.state, runRecord.id, [['hello', 'edited manually']]));
  const dataset = edited.state.nodes.find((node) => node.nodeId === 'run-dataset');
  assert.equal(dataset.sourceRunNodeId, 'run');
  assert.equal(dataset.historyEdited, true);
  assert.deepEqual(dataset.datasetContent.rows, [['hello', 'edited manually']]);
  assert.equal(edited.currentRecordIds.run, runRecord.id);
  // The edit is a changed input: the Process record made from the original output no longer matches.
  assert.ok(edited.missingResultNodeIds.includes('process'));

  const original = await resolve(migrated.state);
  assert.equal(original.state.nodes.find((node) => node.nodeId === 'run-dataset').historyEdited, undefined);
  assert.deepEqual(original.missingResultNodeIds, []);
});

test('an edit made on another upstream record does not apply to the current one', async () => {
  const { migrated, resolve } = await setup();
  const resolved = await resolve(withEdit(migrated.state, 'f'.repeat(32), [['other record edit']]));
  const dataset = resolved.state.nodes.find((node) => node.nodeId === 'run-dataset');
  assert.equal(dataset.historyEdited, undefined);
  assert.notDeepEqual(dataset.datasetContent.rows, [['other record edit']]);
  assert.deepEqual(resolved.missingResultNodeIds, []);
});

test('a run on an edited input records the edit, and selecting either record restores its own input', async () => {
  const { migrated, records, index, runRecord, processRecord } = await setup();
  const editedState = withEdit(migrated.state, runRecord.id, [['hello', 'edited manually']]);
  const capture = await captureHistoryInput(editedState, 'process', { index, loadRecord: async (id) => records[id] });
  assert.equal(capture.inputs.bindings[0].edited, true);
  assert.deepEqual(capture.inputs.bindings[0].content.rows, [['hello', 'edited manually']]);
  assert.notEqual(capture.signature, processRecord.signature);
  const editedRecord = { ...runningHistoryRecord(capture, { createId: () => 'e'.repeat(32), now: () => '2026-10-02T00:00:00Z' }), status: 'completed' };
  const all = { ...records, [editedRecord.id]: editedRecord };

  const selectEdited = await planHistorySelection(migrated.state, editedRecord.id, { loadRecord: async (id) => all[id] });
  const restored = selectEdited.state.nodes.find((node) => node.nodeId === 'run-dataset');
  assert.deepEqual(restored.historyEdits[`${runRecord.id}:result`].rows, [['hello', 'edited manually']]);
  assert.ok(selectEdited.changedNodeIds.includes('run-dataset'));

  const selectOriginal = await planHistorySelection(editedState, processRecord.id, { loadRecord: async (id) => all[id] });
  assert.equal(selectOriginal.state.nodes.find((node) => node.nodeId === 'run-dataset').historyEdits, undefined);
  assert.ok(selectOriginal.changedNodeIds.includes('run-dataset'));
});

test('editing a derived ground truth changes the Score key', async () => {
  const state = {
    nodes: [
      { type: 'run', nodeId: 'run' },
      { type: 'dataset', nodeId: 'gt', sourceRunNodeId: 'gt-run', datasetContent: content('yes') },
      { type: 'score', nodeId: 'score', scoreGroundTruthId: 'gt', scoreMapping: {} },
    ],
    connections: [{ type: 'run-to-score', fromId: 'run', toId: 'score' }],
  };
  const before = await analysisInputKeys(state, { run: 'answer-run', 'gt-run': 'truth-run' });
  state.nodes[1].historyEdits = withHistoryEdit(null, 'truth-run', 'result', content('no'));
  const after = await analysisInputKeys(state, { run: 'answer-run', 'gt-run': 'truth-run' });
  assert.notEqual(before.score.get('score').signature, after.score.get('score').signature);
});

test('History marks a record whose output was edited manually, and inputs that were edited', async () => {
  const { migrated, runRecord, processRecord } = await setup();
  assert.deepEqual(describeHistoryRecord(runRecord, migrated.state).notes, []);
  assert.deepEqual(describeHistoryRecord(processRecord, migrated.state).notes, []);
  const canvas = withEdit(migrated.state, runRecord.id, [['x']]);
  assert.deepEqual(describeHistoryRecord(runRecord, canvas).notes, ['Output edited manually in: Run export']);
  assert.deepEqual(describeHistoryRecord(processRecord, canvas).notes, ['Input edited since this result: Run export']);
  const madeWithEdit = { kind: 'process', id: 'p', nodeId: 'process', inputs: { bindings: [{ name: 'Run export', edited: true }] }, results: {} };
  assert.equal(describeHistoryRecord(madeWithEdit, canvas).input, 'Input: Run export (edited manually)');
});

test('History reminds when a Prompt, a plain input Dataset or Process code was edited after the result', async () => {
  const { migrated, runRecord, processRecord } = await setup();
  const promptEdited = structuredClone(migrated.state);
  promptEdited.nodes.find((node) => node.nodeId === 'prompt').sections[0].content = 'Say {{text}} politely';
  assert.deepEqual(describeHistoryRecord(runRecord, promptEdited).notes, ['Prompt edited since this result']);

  const inputEdited = structuredClone(migrated.state);
  inputEdited.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0] = 'hello there';
  assert.deepEqual(describeHistoryRecord(runRecord, inputEdited).notes, ['Input edited since this result: Input']);

  const codeEdited = structuredClone(migrated.state);
  codeEdited.nodes.find((node) => node.nodeId === 'process').dfCode = 'return df.head()';
  assert.deepEqual(describeHistoryRecord(processRecord, codeEdited).notes, ['Code edited since this result']);

  // Renaming is not an edit of the content the result was made from.
  const renamed = structuredClone(migrated.state);
  renamed.nodes.find((node) => node.nodeId === 'prompt').name = 'Renamed prompt';
  renamed.nodes.find((node) => node.nodeId === 'input').name = 'Renamed input';
  assert.deepEqual(describeHistoryRecord(runRecord, renamed).notes, []);
});
