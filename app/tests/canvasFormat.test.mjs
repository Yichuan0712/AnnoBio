import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { CANVAS_VERSION, upgradeCanvasState } from '../src/canvasFormat.js';
import { captureHistoryInput } from '../src/runHistoryCapture.js';
import { DATA_EDGE, RESULT_PORT, processInputAliases, processInputEdges, runInputEdges, validateStepInputs } from '../src/stepInputs.js';
import { legacyCanvas } from './canvasFormatFixture.mjs';

const data = (fromId, toId, alias) => ({ type: DATA_EDGE, fromId, fromPort: RESULT_PORT, toId, ...(alias ? { alias } : {}) });
const LEGACY_FIELDS = ['runWorkingSetId', 'primaryDatasetId', 'datasetAliases'];
const legacyLeft = (state) => [
  ...state.nodes.flatMap((node) => LEGACY_FIELDS.filter((field) => field in node).map((field) => `${node.nodeId}.${field}`)),
  ...state.connections.filter((edge) => edge.type === 'dataset-to-process').map((edge) => `${edge.fromId}->${edge.toId}`),
];

test('Run and Process inputs become data connections and the legacy fields go', () => {
  const state = upgradeCanvasState(legacyCanvas());
  assert.equal(state.version, CANVAS_VERSION);
  assert.equal(state.historyVersion, 1);
  assert.deepEqual(legacyLeft(state), []);
  assert.deepEqual(state.connections, [
    { fromId: 'prompt', toId: 'run', type: 'prompt-to-run' },
    data('raw', 'saved', 'df'), data('lookup', 'saved', 'df_lookup_table'),
    data('raw', 'implicit', 'df'), data('lookup', 'implicit', 'df_lookup'),
    data('raw', 'clash', 'df'), data('notes', 'clash', 'df_lookup'),
    data('raw', 'run'),
  ]);
  assert.deepEqual(validateStepInputs(state), []);
});

test('aliases are the ones version 2 ran with: saved, derived from the name, or suffixed for a repeated name', () => {
  const legacy = legacyCanvas();
  // Notes is also named Lookup, so its name gives df_lookup_2.
  legacy.nodes.push({ type: 'process', nodeId: 'suffixed', dfCode: 'def process(df, df_lookup_2):\n    return df\n' });
  legacy.connections.push({ fromId: 'raw', toId: 'suffixed', type: 'dataset-to-process' });
  const state = upgradeCanvasState(legacy);
  assert.deepEqual(processInputAliases(state, 'saved'), { raw: 'df', lookup: 'df_lookup_table' });
  assert.deepEqual(processInputAliases(state, 'implicit'), { raw: 'df', lookup: 'df_lookup' });
  // A saved alias wins over the same alias derived from another Dataset's name.
  assert.deepEqual(processInputAliases(state, 'clash'), { raw: 'df', notes: 'df_lookup' });
  assert.deepEqual(processInputAliases(state, 'suffixed'), { raw: 'df', notes: 'df_lookup_2' });
});

test('History signatures after the upgrade are the ones version 2 recorded', async () => {
  // Captured from legacyCanvas() with the version 2 code, before the storage switch.
  const recorded = {
    run: 'sha256:fa48cd2cd583d28c7c0c976f1ae1f2e102fd99d2fb9582ecec0325c577b63503',
    saved: 'sha256:df7ad4207c8f532b737199540ce3b94431998c5d25f51d175e5fae3841cf4651',
    implicit: 'sha256:9b39e52e8028f371fc724317f2cebcee5a77c9f2ed94a74054d90504cbebfdaf',
    clash: 'sha256:612203794f6c2c7208afa1146515c2eb12ab0c86bfc27225c7a6f21e0b530541',
  };
  const state = upgradeCanvasState(legacyCanvas());
  for (const [nodeId, signature] of Object.entries(recorded)) {
    const capture = await captureHistoryInput(state, nodeId, { index: { records: [] }, loadRecord: async () => null });
    assert.equal(capture.signature, signature, nodeId);
  }
});

test('upgrading leaves its input alone, and upgrading again changes nothing', () => {
  const legacy = legacyCanvas();
  const once = upgradeCanvasState(legacy);
  assert.deepEqual(legacy, legacyCanvas());
  assert.deepEqual(upgradeCanvasState(once), once);
});

test('a merged canvas mixing both versions converts only the version 2 parts', () => {
  const state = upgradeCanvasState({
    version: 3,
    nodes: [
      { type: 'dataset', nodeId: 'a', name: 'A' },
      { type: 'dataset', nodeId: 'b', name: 'B' },
      { type: 'run', nodeId: 'new-run' },
      { type: 'process', nodeId: 'new-process' },
      { type: 'run', nodeId: 'old-run', runWorkingSetId: 'b' },
      { type: 'run', nodeId: 'gone-run', runWorkingSetId: 'deleted' },
      { type: 'run', nodeId: 'empty-run', runWorkingSetId: '' },
      // A version 2 field left on a node whose input is already a data connection.
      { type: 'run', nodeId: 'both-run', runWorkingSetId: 'b' },
      { type: 'process', nodeId: 'old-process', primaryDatasetId: 'b', datasetAliases: '{"a":"df_first"}', dfCode: 'return df_first' },
      { type: 'process', nodeId: 'both-process', primaryDatasetId: 'b' },
    ],
    connections: [
      data('a', 'new-run'), data('b', 'new-process', 'df'), data('a', 'both-run'), data('a', 'both-process', 'df'),
      { fromId: 'a', toId: 'old-process', type: 'dataset-to-process' },
      { fromId: 'b', toId: 'old-process', type: 'dataset-to-process' },
      { fromId: 'b', toId: 'both-process', type: 'dataset-to-process' },
    ],
  });
  assert.deepEqual(legacyLeft(state), []);
  assert.deepEqual(runInputEdges(state).map((edge) => [edge.fromId, edge.toId]),
    [['a', 'new-run'], ['a', 'both-run'], ['b', 'old-run']]);
  assert.deepEqual(processInputEdges(state).map((edge) => [edge.fromId, edge.toId, edge.alias]),
    [['b', 'new-process', 'df'], ['a', 'both-process', 'df'], ['a', 'old-process', 'df_first'], ['b', 'old-process', 'df']]);
  assert.deepEqual(validateStepInputs(state), []);
});

const KINASE = new URL('../../examples/Kinase–Substrate Evidence Curation.yc', import.meta.url);

test('the Kinase example upgrades to one input per Run and one df per Process', { skip: !existsSync(KINASE) && 'the example projects are not in the repository' }, () => {
  const { project } = JSON.parse(readFileSync(KINASE, 'utf8'));
  assert.equal(project.version, 2);
  const state = upgradeCanvasState(project);
  assert.deepEqual(legacyLeft(state), []);
  assert.deepEqual(validateStepInputs(state), []);
  const runs = state.nodes.filter((node) => node.type === 'run').map((node) => node.nodeId);
  assert.deepEqual(runInputEdges(state).map((edge) => edge.toId).sort(), [...runs].sort());
  const processes = state.nodes.filter((node) => node.type === 'process').map((node) => node.nodeId);
  for (const processId of processes) {
    const aliases = Object.values(processInputAliases(state, processId));
    assert.equal(aliases.filter((alias) => alias === 'df').length, 1, processId);
  }
});

const PRODUCER_FIELDS = ['sourceRunNodeId', 'processOutputName', 'savedCopy', 'snapshotSourceRecordId', 'pipelineRunId', 'pipelineLogicalId', 'resultMissing'];
const PRODUCER_EDGES = ['process-to-dataset', 'process-to-dataset-snapshot', 'run-to-dataset-snapshot'];
const producerLeft = (state) => [
  ...state.nodes.flatMap((node) => PRODUCER_FIELDS.filter((field) => field in node).map((field) => `${node.nodeId}.${field}`)),
  ...state.connections.filter((edge) => PRODUCER_EDGES.includes(edge.type)).map((edge) => `${edge.type}:${edge.fromId}->${edge.toId}`),
];

test('a Dataset saved from a step keeps only where it came from, in savedFrom', () => {
  const dataset = (nodeId, fields = {}) => ({ type: 'dataset', nodeId, name: nodeId, datasetContent: { headers: ['a'], rows: [['1']] }, ...fields });
  const legacy = { version: 3, nodes: [
    { type: 'run', nodeId: 'run' }, { type: 'process', nodeId: 'proc' }, { type: 'sampler', nodeId: 'sampler' },
    dataset('saved-run', { sourceRunNodeId: 'run', savedCopy: true, snapshotSourceRecordId: 'rec-run' }),
    // An output that followed History: its last table stays, as a plain Dataset.
    dataset('follows-run', { sourceRunNodeId: 'run', resultMissing: true }),
    dataset('branch', { processOutputName: 'left' }),
    dataset('process-copy', { savedCopy: true, snapshotSourceRecordId: 'rec-proc' }),
    dataset('run-copy', { snapshotSourceRecordId: 'rec-old' }),
    dataset('pipeline-run', { sourceRunNodeId: 'run', savedCopy: true, snapshotSourceRecordId: 'rec-p', pipelineRunId: 'p1', pipelineLogicalId: 'dataset:x' }),
    dataset('pipeline-branch', { processOutputName: 'right', savedCopy: true, pipelineRunId: 'p2', pipelineLogicalId: 'output:process:proc:right' }),
    dataset('gone-source', { sourceRunNodeId: 'deleted-run', savedCopy: true }),
    dataset('plain', { sourceRunNodeId: '', processOutputName: '', samplerNodeId: '' }),
    dataset('sample', { samplerNodeId: 'sampler' }),
    dataset('already', { savedFrom: { kind: 'score', nodeId: 'score', port: 'result', recordId: '' } }),
  ], connections: [
    { fromId: 'proc', toId: 'branch', type: 'process-to-dataset' },
    { fromId: 'proc', toId: 'process-copy', type: 'process-to-dataset-snapshot' },
    { fromId: 'run', toId: 'run-copy', type: 'run-to-dataset-snapshot' },
    { fromId: 'proc', toId: 'pipeline-branch', type: 'process-to-dataset' },
    { fromId: 'sampler', toId: 'sample', type: 'sampler-to-dataset' },
  ] };
  const state = upgradeCanvasState(legacy);
  assert.deepEqual(producerLeft(state), []);
  const savedFrom = Object.fromEntries(state.nodes.filter((node) => node.type === 'dataset').map((node) => [node.nodeId, node.savedFrom]));
  assert.deepEqual(savedFrom, {
    'saved-run': { kind: 'run', nodeId: 'run', port: 'result', recordId: 'rec-run' },
    'follows-run': { kind: 'run', nodeId: 'run', port: 'result', recordId: '' },
    branch: { kind: 'process', nodeId: 'proc', port: 'left', recordId: '' },
    'process-copy': { kind: 'process', nodeId: 'proc', port: 'result', recordId: 'rec-proc' },
    'run-copy': { kind: 'run', nodeId: 'run', port: 'result', recordId: 'rec-old' },
    'pipeline-run': { kind: 'pipeline', nodeId: 'run', port: 'result', recordId: 'rec-p', pipelineRunId: 'p1' },
    'pipeline-branch': { kind: 'pipeline', nodeId: 'proc', port: 'right', recordId: '', pipelineRunId: 'p2' },
    'gone-source': { kind: 'run', nodeId: 'deleted-run', port: 'result', recordId: '' },
    plain: undefined,
    sample: undefined,
    already: { kind: 'score', nodeId: 'score', port: 'result', recordId: '' },
  });
  assert.equal(state.nodes.find((node) => node.nodeId === 'sample').samplerNodeId, 'sampler');
  assert.deepEqual(state.connections, [{ fromId: 'sampler', toId: 'sample', type: 'sampler-to-dataset' }]);
  assert.deepEqual(state.nodes.find((node) => node.nodeId === 'follows-run').datasetContent, { headers: ['a'], rows: [['1']] });
  assert.deepEqual(upgradeCanvasState(state), state);
});

test('the Kinase example keeps its 12 Datasets as plain tables, 11 of them saved from a step', { skip: !existsSync(KINASE) && 'the example projects are not in the repository' }, () => {
  const { project } = JSON.parse(readFileSync(KINASE, 'utf8'));
  const state = upgradeCanvasState(project);
  const datasets = state.nodes.filter((node) => node.type === 'dataset');
  assert.equal(datasets.length, 12);
  assert.deepEqual(producerLeft(state), []);
  assert.equal(datasets.filter((node) => node.savedFrom).length, 11);
  assert.ok(datasets.every((node) => !node.savedFrom || state.nodes.some((other) => other.nodeId === node.savedFrom.nodeId)));
});
