import test from 'node:test';
import assert from 'node:assert/strict';
import { readSavedFrom, savedFromLabel, savedProcessOutputs, savedRunOutput, scoreSavedFrom } from '../src/savedDatasets.js';
import { stepOutputTable } from '../src/stepOutputs.js';
import { planChangeSet } from '../src/agent/operations/changeSet.js';
import { normalizeDatasetContent } from '../src/datasetContent.js';

const runState = (run = {}) => ({
  nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw' },
    { type: 'prompt', nodeId: 'p', name: 'Extract', outputFormat: { returnShape: 'single', fields: [{ key: 'answer', type: 'str' }] } },
    { type: 'run', nodeId: 'r', runName: 'Run', historyRecordId: 'rec-r', runCompleted: '1',
      runInputContent: JSON.stringify({ headers: ['text', 'image'], columnTypes: ['text', 'image'], rows: [['a', 'img-1'], ['b', 'img-2']] }),
      runResults: JSON.stringify([
        { row_index: 0, input_row_index: 0, output: { answer: 'A' } },
        { row_index: 1, input_row_index: 1, output: { answer: null } },
      ]), ...run },
  ],
  connections: [{ type: 'prompt-to-run', fromId: 'p', toId: 'r' }, { type: 'data', fromId: 'raw', fromPort: 'result', toId: 'r' }],
});

test('a Run is saved as the table its readers get, input columns included', () => {
  const state = runState();
  const saved = savedRunOutput(state, 'r');
  const read = stepOutputTable(state, { nodeId: 'r', port: 'result', kind: 'run' }).table;
  assert.deepEqual(saved.table, { headers: read.headers, rows: read.rows, columnTypes: read.columnTypes });
  assert.deepEqual(saved.table.headers, ['Input: #', 'Input: text', 'Input: image', 'Output: #', 'Output: answer']);
  assert.deepEqual(saved.table.columnTypes, ['text', 'text', 'image', 'text', 'text']);
  assert.deepEqual(saved.savedFrom, { kind: 'run', nodeId: 'r', port: 'result', recordId: 'rec-r' });
  assert.equal(saved.name, 'Extract Run');
  assert.equal(saved.notes, 'Exported from Extract Run.\nRun completed.');
});

test('a stopped Run saves the rows it has; without results or a record it cannot be saved', () => {
  const stopped = savedRunOutput(runState({ runCompleted: undefined, runResumable: true }), 'r');
  assert.equal(stopped.table.rows.length, 2);
  assert.equal(stopped.notes, 'Exported from Extract Run.\nRun incomplete.');
  assert.throws(() => savedRunOutput(runState({ runResults: '[]' }), 'r'), /no results yet/);
  assert.throws(() => savedRunOutput(runState({ historyRecordId: undefined }), 'r'), /no History record yet/);
});

const processState = (dfResults, extra = {}) => ({
  nodes: [{ type: 'process', nodeId: 'split', name: 'Split', historyRecordId: 'rec-s', dfResults: JSON.stringify(dfResults), ...extra }],
  connections: [],
});

test('each branch of a Process is saved under its own name and port', () => {
  const saved = savedProcessOutputs(processState({ outputs: {
    kept: { headers: ['id'], rows: [['1']], columnTypes: ['text'] },
    dropped: { headers: ['id'], rows: [], columnTypes: ['text'] },
  } }), 'split');
  assert.deepEqual(saved.map((item) => [item.port, item.name, item.notes]), [
    ['kept', 'Split — kept', 'Branch "kept" exported from Process "Split".'],
    ['dropped', 'Split — dropped', 'Branch "dropped" exported from Process "Split".'],
  ]);
  assert.deepEqual(saved[1].table, { headers: ['id'], rows: [], columnTypes: ['text'] });
  assert.deepEqual(saved[0].savedFrom, { kind: 'process', nodeId: 'split', port: 'kept', recordId: 'rec-s' });

  const [single] = savedProcessOutputs(processState({ outputs: { result: { headers: ['id'], rows: [['1']] } } }), 'split');
  assert.equal(single.name, 'Split results');
  assert.deepEqual(single.savedFrom, { kind: 'process', nodeId: 'split', port: 'result', recordId: 'rec-s' });
  assert.throws(() => savedProcessOutputs(processState(null), 'split'), /no output yet/);
  assert.throws(() => savedProcessOutputs(processState({ outputs: { result: { headers: [], rows: [] } } }, { historyRecordId: '' }), 'split'),
    /no History record yet/);
});

test('saving the opened Process branch keeps empty outputs and rejects missing branches', () => {
  const state = processState({ outputs: {
    kept: { headers: ['id'], rows: [['1']], columnTypes: ['text'] },
    empty: { headers: [], rows: [] },
    emptyImages: { headers: ['image'], rows: [], columnTypes: ['image'] },
  } });
  const original = structuredClone(state);
  const [empty] = savedProcessOutputs(state, 'split', { branch: 'empty' });
  assert.equal(empty.name, 'Split — empty');
  assert.deepEqual(empty.table, { headers: [], rows: [], columnTypes: [] });
  assert.equal(empty.savedFrom.recordId, 'rec-s');
  const [images] = savedProcessOutputs(state, 'split', { branch: 'emptyImages' });
  assert.deepEqual(images.table, { headers: ['image'], rows: [], columnTypes: ['image'] });
  assert.deepEqual(savedProcessOutputs(state, 'split').map((item) => item.port), ['kept', 'empty', 'emptyImages']);
  assert.throws(() => savedProcessOutputs(state, 'split', { branch: 'missing' }), /no "missing" output/);
  assert.deepEqual(state, original);
});

test('a detail view saves its displayed History result when the live selection has changed', () => {
  const state = processState({ outputs: { result: { headers: ['new'], rows: [['new']] } } }, {
    historyRecordId: 'new-record', processPending: true,
  });
  const original = structuredClone(state);
  const snapshot = { recordId: 'opened-record', results: { outputs: {
    old: { headers: ['id'], rows: [['old']], columnTypes: ['text'] },
    empty: { headers: ['id'], rows: [], columnTypes: ['text'] },
  } } };
  const saved = savedProcessOutputs(state, 'split', { branch: 'old', snapshot });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].table.rows, [['old']]);
  assert.deepEqual(saved[0].savedFrom, { kind: 'process', nodeId: 'split', port: 'old', recordId: 'opened-record' });
  assert.deepEqual(savedProcessOutputs(state, 'split', { branch: 'empty', snapshot })[0].table.rows, []);
  assert.deepEqual(state, original);
});

test('a Score records its current record when it has one', () => {
  assert.deepEqual(scoreSavedFrom('score', 'rec-score'), { kind: 'score', nodeId: 'score', port: 'result', recordId: 'rec-score' });
  assert.deepEqual(scoreSavedFrom('score'), { kind: 'score', nodeId: 'score', port: 'result', recordId: '' });
});

test('savedFrom is read from the DOM string and named as the canvas names its source', () => {
  const state = { nodes: [...runState().nodes, ...processState({}).nodes, { type: 'score', nodeId: 'score', scoreName: 'Accuracy' }],
    connections: runState().connections };
  assert.equal(readSavedFrom('{"kind":"other"}'), null);
  assert.equal(readSavedFrom('not json'), null);
  assert.deepEqual(readSavedFrom(JSON.stringify({ kind: 'process', nodeId: 'split', port: 'kept', recordId: 'x' })),
    { kind: 'process', nodeId: 'split', port: 'kept', recordId: 'x' });
  assert.equal(savedFromLabel(state, { kind: 'run', nodeId: 'r', port: 'result' }), 'Saved from Run of "Extract"');
  assert.equal(savedFromLabel(state, { kind: 'process', nodeId: 'split', port: 'kept' }), 'Saved from branch "kept" of Process "Split"');
  assert.equal(savedFromLabel(state, { kind: 'process', nodeId: 'split', port: 'result' }), 'Saved from Process "Split"');
  assert.equal(savedFromLabel(state, { kind: 'score', nodeId: 'score' }), 'Saved from Evaluate "Accuracy"');
  assert.equal(savedFromLabel(state, { kind: 'pipeline', nodeId: 'r', pipelineRunId: 'p' }), 'Saved from a Pipeline run (Run of "Extract")');
  assert.equal(savedFromLabel(state, { kind: 'run', nodeId: 'deleted' }), '');
});

test('the Agent saves the same Datasets as the canvas, recording only where they came from', () => {
  const extractInputFields = () => ['text'];
  const state = { ...runState(), historyVersion: 1 };
  state.nodes.push(...processState({ outputs: { kept: { headers: ['id'], rows: [['1']], columnTypes: ['text'] } } }).nodes);
  const ran = planChangeSet(state, [{ op: 'save_run_results', ref: '$out', run: 'r' }], { extractInputFields });
  const runDataset = ran.state.nodes.find((node) => node.nodeId === ran.refs.$out);
  const expected = savedRunOutput(state, 'r');
  assert.deepEqual(runDataset.savedFrom, expected.savedFrom);
  const table = normalizeDatasetContent(expected.table);
  assert.deepEqual([runDataset.datasetContent.headers, runDataset.datasetContent.rows], [table.headers, table.rows]);
  assert.equal(runDataset.note, expected.notes);
  assert.deepEqual(ran.state.connections, state.connections);

  const processed = planChangeSet(state, [{ op: 'save_process_output', ref: '$p', process: 'split' }], { extractInputFields });
  const branch = processed.state.nodes.find((node) => node.nodeId === processed.refs.$p);
  assert.deepEqual(branch.savedFrom, { kind: 'process', nodeId: 'split', port: 'kept', recordId: 'rec-s' });
  assert.equal(branch.name, 'Split results');
  assert.deepEqual(processed.state.connections, state.connections);
  // Editing it is an ordinary edit: where it came from stays as it was.
  const edited = planChangeSet(processed.state, [{ op: 'update', node: processed.refs.$p, set: { rows: [['2']] } }], { extractInputFields });
  const editedBranch = edited.state.nodes.find((node) => node.nodeId === processed.refs.$p);
  assert.deepEqual(editedBranch.savedFrom, branch.savedFrom);
  assert.deepEqual(editedBranch.datasetContent.rows, [['2']]);

  const unrecorded = structuredClone(state);
  delete unrecorded.nodes.find((node) => node.nodeId === 'r').historyRecordId;
  assert.throws(() => planChangeSet(unrecorded, [{ op: 'save_run_results', ref: '$out', run: 'r' }], { extractInputFields }), /no History record/);
});
