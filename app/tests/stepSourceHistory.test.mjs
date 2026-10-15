/** History for steps that read another step's output (docs/design/DATA_FLOW_DESIGN.md §3.8). */
import test from 'node:test';
import assert from 'node:assert/strict';

import { captureHistoryInput, runningHistoryRecord } from '../src/runHistoryCapture.js';
import { resolveHistoryCanvasState } from '../src/runHistoryResolver.js';
import { planHistorySelection } from '../src/runHistorySelection.js';
import { dependentHistoryIds } from '../src/runHistoryDeletion.js';
import { describeHistoryRecord } from '../src/runHistoryPresentation.js';
import { recordInputRefs } from '../src/contentLocks.js';
import { processInputSignature, stepOutputSignature } from '../src/runHistorySignature.js';
import { upgradeCanvasState } from '../src/canvasFormat.js';
import { legacyCanvas } from './canvasFormatFixture.mjs';

const content = (value) => ({ headers: ['text'], rows: [[value]], columnTypes: ['text'], rowIds: [`row-${value}`] });
const data = (fromId, toId, alias, fromPort = 'result') => ({ type: 'data', fromId, fromPort, toId, ...(alias ? { alias } : {}) });
const prompt = (nodeId, name, text, field) => ({
  type: 'prompt', nodeId, name, text, inputTypes: {},
  outputFormat: { returnShape: 'single', fields: [{ key: field, type: 'str' }] },
});
const ports = (list) => ({ ports: list, dynamic: false, error: '', codeHash: 'h' });

/** Records completed results the way a run would, with deterministic IDs. */
function historyOf() {
  let next = 0;
  const records = [];
  const loadRecord = async (id) => records.find((record) => record.id === id) || null;
  const index = () => ({ records: records.map(({ id, nodeId, kind, signature, status }) => ({ id, nodeId, kind, signature, status })) });
  return {
    records,
    loadRecord,
    index,
    async record(state, nodeId, results, status = 'completed') {
      const capture = await captureHistoryInput(state, nodeId, { index: index(), loadRecord });
      const record = {
        ...runningHistoryRecord(capture, { createId: () => `record-${++next}`, now: () => '2026-10-08T00:00:00.000Z' }),
        status,
        results: { ...runningHistoryRecord(capture).results, ...results },
      };
      records.push(record);
      return record;
    },
    resolve: (state) => resolveHistoryCanvasState(state, { index: index(), loadRecord }),
  };
}

// Raw → Run A (Prompt "Extract") → Run B (Prompt "Check"), B reading A's results directly.
const chain = () => ({
  historyVersion: 1,
  nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: content('hello') },
    prompt('pa', 'Extract', 'Say {{text}}', 'answer'),
    { type: 'run', nodeId: 'a', runName: 'Run', runInputToColumn: '{"text":"text"}' },
    prompt('pb', 'Check', 'Check {{answer}}', 'verdict'),
    { type: 'run', nodeId: 'b', runName: 'Run', runInputToColumn: '{"answer":"Output: answer"}' },
  ],
  connections: [
    { type: 'prompt-to-run', fromId: 'pa', toId: 'a' }, data('raw', 'a'),
    { type: 'prompt-to-run', fromId: 'pb', toId: 'b' }, data('a', 'b'),
  ],
});
const runResults = (answer) => ({
  runResults: [{ row_index: 0, input_row_index: 0, output: { answer } }], runOutputFields: [], runProgress: 100,
});

async function recordedChain() {
  const history = historyOf();
  const state = chain();
  const a1 = await history.record(state, 'a', runResults('world'));
  const b1 = await history.record(state, 'b', { runResults: [{ row_index: 0, input_row_index: 0, output: { verdict: 'ok' } }] });
  return { history, state, a1, b1 };
}

test('a Run reading another Run records a reference to its record, not a copy of its table', async () => {
  const { a1, b1 } = await recordedChain();
  assert.deepEqual(b1.inputs.dataset, {
    kind: 'step', nodeId: 'a', port: 'result', recordId: a1.id,
    signature: await stepOutputSignature({ nodeId: 'a', recordId: a1.id, port: 'result' }),
  });
  assert.deepEqual(b1.sourceRecordIds, [a1.id]);
  assert.equal('inputTable' in b1, false);
  // The table it ran on is kept as its input content, as for any Run.
  assert.deepEqual(b1.results.runInputContent.headers, ['Input: #', 'Input: text', 'Output: #', 'Output: answer']);
  assert.deepEqual(b1.results.runInputContent.rows, [['1', 'hello', '1', 'world']]);
  assert.equal(a1.inputs.dataset.kind, 'dataset');
});

test('the reader shows its record only while the upstream shows the record it read', async () => {
  const { history, state, a1, b1 } = await recordedChain();
  let resolved = await history.resolve(state);
  assert.deepEqual(resolved.currentRecordIds, { a: a1.id, b: b1.id });
  assert.equal(resolved.state.nodes.find((node) => node.nodeId === 'b').waitingForUpstream, undefined);

  // A runs again with the same inputs: B has no result for the new record yet.
  const a2 = await history.record(state, 'a', runResults('again'));
  state.nodes.find((node) => node.nodeId === 'a').historyRecordId = a2.id;
  resolved = await history.resolve(state);
  assert.deepEqual(resolved.currentRecordIds, { a: a2.id });
  assert.ok(resolved.missingResultNodeIds.includes('b'));
  assert.equal(resolved.state.nodes.find((node) => node.nodeId === 'b').waitingForUpstream, undefined);

  state.nodes.find((node) => node.nodeId === 'a').historyRecordId = a1.id;
  assert.deepEqual((await history.resolve(state)).currentRecordIds, { a: a1.id, b: b1.id });
});

test('a reader waits while its upstream has no complete result, and cannot record until then', async () => {
  const history = historyOf();
  const state = chain();
  let resolved = await history.resolve(state);
  assert.equal(resolved.state.nodes.find((node) => node.nodeId === 'b').waitingForUpstream, true);
  await assert.rejects(history.record(state, 'b', {}), /Waiting for upstream results: run "Extract" first\./);
  await history.record(state, 'a', runResults('world'), 'running');
  resolved = await history.resolve(state);
  assert.equal(resolved.state.nodes.find((node) => node.nodeId === 'b').waitingForUpstream, true);
  // A Run reading a Dataset never waits.
  assert.equal(resolved.state.nodes.find((node) => node.nodeId === 'a').waitingForUpstream, undefined);
});

test('selecting the reader\'s record switches the upstream to the record it read', async () => {
  const { history, state, a1, b1 } = await recordedChain();
  const a2 = await history.record(state, 'a', runResults('again'));
  const current = structuredClone(state);
  current.nodes.find((node) => node.nodeId === 'a').historyRecordId = a2.id;
  const selected = await planHistorySelection(current, b1.id, {
    loadRecord: history.loadRecord, recordEntries: history.index().records,
  });
  assert.deepEqual(selected.selectedRecordIds, { b: b1.id, a: a1.id });
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'a').historyRecordId, a1.id);
  assert.deepEqual(selected.state.connections.filter((edge) => edge.type === 'data' && edge.toId === 'b'), [data('a', 'b')]);
  assert.deepEqual((await history.resolve(selected.state)).currentRecordIds, { a: a1.id, b: b1.id });
  // Selecting the upstream's record brings back the reader's.
  const fromA = await planHistorySelection(current, a1.id, { loadRecord: history.loadRecord, recordEntries: history.index().records });
  assert.deepEqual(fromA.selectedRecordIds, { a: a1.id, b: b1.id });
});

test('deleting the upstream record deletes the records that read it', async () => {
  const { history, a1, b1 } = await recordedChain();
  assert.deepEqual(dependentHistoryIds(history.records, a1.id).sort(), [a1.id, b1.id].sort());
  assert.deepEqual(dependentHistoryIds(history.records, b1.id), [b1.id]);
});

test('a step input is shown by its step and locks nothing', async () => {
  const { state, b1 } = await recordedChain();
  assert.equal(describeHistoryRecord(b1, state).input, 'Input: Extract');
  assert.deepEqual(recordInputRefs(b1).datasetIds, []);
});

test('two branches of one Process read as df and df_right sign under node:port keys', async () => {
  const history = historyOf();
  const state = {
    historyVersion: 1,
    nodes: [
      { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: content('hello') },
      { type: 'process', nodeId: 'split', name: 'Split', dfCode: "def process(df):\n    return {'left': df, 'right': df}\n", processOutputPorts: ports(['left', 'right']) },
      { type: 'process', nodeId: 'merge', name: 'Merge', dfCode: 'def process(df, df_right):\n    return df\n' },
    ],
    connections: [data('raw', 'split', 'df'), data('split', 'merge', 'df_right', 'right'), data('split', 'merge', 'df', 'left')],
  };
  const branch = { headers: ['text'], rows: [['hello']] };
  const s1 = await history.record(state, 'split', { dfResults: { outputs: { left: branch, right: branch } } });
  const m1 = await history.record(state, 'merge', { dfResults: { outputs: { result: branch } } });
  assert.equal(m1.inputs.primaryDatasetId, 'split:left');
  assert.deepEqual(m1.inputs.bindings.map((item) => [item.kind, item.nodeId, item.port, item.alias, item.recordId]),
    [['step', 'split', 'left', 'df', s1.id], ['step', 'split', 'right', 'df_right', s1.id]]);
  assert.deepEqual(m1.sourceRecordIds, [s1.id]);
  const signature = async (port) => stepOutputSignature({ nodeId: 'split', recordId: s1.id, port });
  assert.equal(m1.signature, await processInputSignature({
    code: state.nodes[2].dfCode, primaryDatasetId: 'split:left',
    bindings: [
      { key: 'split:right', alias: 'df_right', signature: await signature('right') },
      { key: 'split:left', alias: 'df', signature: await signature('left') },
    ],
  }));
  // The order of the connections does not change the signature.
  const reordered = { ...state, connections: [...state.connections].reverse() };
  assert.deepEqual((await history.resolve(reordered)).currentRecordIds, { split: s1.id, merge: m1.id });
});

test('Processes and Runs reading only Datasets keep the signatures recorded before step sources', async () => {
  // The same constants as canvasFormat.test.mjs, found here through the resolver rather than capture.
  const recorded = {
    run: 'sha256:10fb964d12b807b8088665f5dab8b81eda6ae961a30bbb1ed08ad26bd018c24f',
    saved: 'sha256:df7ad4207c8f532b737199540ce3b94431998c5d25f51d175e5fae3841cf4651',
    implicit: 'sha256:9b39e52e8028f371fc724317f2cebcee5a77c9f2ed94a74054d90504cbebfdaf',
    clash: 'sha256:612203794f6c2c7208afa1146515c2eb12ab0c86bfc27225c7a6f21e0b530541',
  };
  const records = Object.entries(recorded).map(([nodeId, signature]) => ({
    id: `record-${nodeId}`, nodeId, kind: nodeId === 'run' ? 'run' : 'process', signature, status: 'completed', results: {},
  }));
  const resolved = await resolveHistoryCanvasState(upgradeCanvasState(legacyCanvas()), {
    index: { records }, loadRecord: async (id) => records.find((record) => record.id === id),
  });
  assert.deepEqual(resolved.currentRecordIds, Object.fromEntries(records.map((record) => [record.nodeId, record.id])));
});
