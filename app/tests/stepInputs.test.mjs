import test from 'node:test';
import assert from 'node:assert/strict';

import { RESULT_PORT, runInputEdges, runInputSource, runInputTable, setRunInputSource, sourceKey } from '../src/stepInputs.js';

const table = (value) => ({ headers: ['text'], rows: [[value]] });
const state = () => ({
  nodes: [
    { type: 'dataset', nodeId: 'raw', datasetContent: table('raw') },
    { type: 'dataset', nodeId: 'subset', subsetContent: table('subset') },
    { type: 'run', nodeId: 'run-a', runWorkingSetId: 'raw' },
    { type: 'run', nodeId: 'run-b', runWorkingSetId: ' subset ' },
    { type: 'run', nodeId: 'run-none' },
    { type: 'run', nodeId: 'run-gone', runWorkingSetId: 'deleted' },
  ],
  connections: [],
});

test('a Run reads the Dataset it points at, on the result port', () => {
  assert.deepEqual(runInputSource(state(), 'run-a'), { nodeId: 'raw', port: RESULT_PORT });
  assert.deepEqual(runInputSource(state(), 'run-b'), { nodeId: 'subset', port: RESULT_PORT });
  assert.equal(runInputSource(state(), 'run-none'), null);
  assert.equal(runInputSource(state(), 'missing-run'), null);
});

test('the input table is the Dataset content, a Sampler subset included', () => {
  assert.deepEqual(runInputTable(state(), 'run-a'), table('raw'));
  assert.deepEqual(runInputTable(state(), 'run-b'), table('subset'));
  assert.equal(runInputTable(state(), 'run-none'), null);
  assert.equal(runInputTable(state(), 'run-gone'), null);
});

test('setting and clearing a Run input changes the state in place', () => {
  const s = state();
  setRunInputSource(s, 'run-none', { nodeId: 'raw', port: RESULT_PORT });
  assert.deepEqual(runInputSource(s, 'run-none'), { nodeId: 'raw', port: RESULT_PORT });
  setRunInputSource(s, 'run-a', null);
  assert.equal(runInputSource(s, 'run-a'), null);
  assert.equal('runWorkingSetId' in s.nodes.find((node) => node.nodeId === 'run-a'), false);
  setRunInputSource(s, 'missing-run', { nodeId: 'raw', port: RESULT_PORT });
  assert.equal(s.nodes.length, 6);
});

test('every Run with an input gives one edge from its source', () => {
  assert.deepEqual(runInputEdges(state()), [
    { fromId: 'raw', fromPort: RESULT_PORT, toId: 'run-a' },
    { fromId: 'subset', fromPort: RESULT_PORT, toId: 'run-b' },
    { fromId: 'deleted', fromPort: RESULT_PORT, toId: 'run-gone' },
  ]);
});

test('a source key is the Dataset node id', () => {
  assert.equal(sourceKey({ nodeId: 'raw', port: RESULT_PORT }), 'raw');
  assert.equal(sourceKey(null), '');
});

// ---------- Process inputs ----------

import {
  processCandidateSources, processInputAliases, processInputBindings, processInputEdges, processPrimarySource,
  processRequiredInputs, replaceProcessInputSource, setProcessInputs, setProcessPrimarySource, stepInputEdges,
} from '../src/stepInputs.js';
import { processDatasetInputs } from '../src/processDatasetBindings.js';

const processState = () => ({
  nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw' },
    { type: 'dataset', nodeId: 'lookup', name: 'Lookup' },
    { type: 'dataset', nodeId: 'raw-2', name: 'Raw' },
    { type: 'dataset', nodeId: 'notes', name: 'Notes' },
    { type: 'process', nodeId: 'p', primaryDatasetId: 'lookup', datasetAliases: JSON.stringify({ raw: 'df_source' }), dfCode: 'def process(df, df_source):\n    return df\n' },
    { type: 'process', nodeId: 'q' },
  ],
  connections: [
    { type: 'dataset-to-process', fromId: 'raw', toId: 'p' },
    { type: 'dataset-to-process', fromId: 'lookup', toId: 'p' },
    { type: 'prompt-to-run', fromId: 'x', toId: 'y' },
  ],
});
const processNodeOf = (state, id) => state.nodes.find((node) => node.nodeId === id);

test('a Process df is its recorded primary when that Dataset exists, else its first input', () => {
  assert.deepEqual(processPrimarySource(processState(), 'p'), { nodeId: 'lookup', port: RESULT_PORT });
  const stale = processState();
  processNodeOf(stale, 'p').primaryDatasetId = 'gone';
  assert.deepEqual(processPrimarySource(stale, 'p'), { nodeId: 'raw', port: RESULT_PORT });
  assert.equal(processPrimarySource(processState(), 'q'), null);
});

test('setting the df changes only the recorded primary', () => {
  const s = processState();
  setProcessPrimarySource(s, 'p', { nodeId: 'raw', port: RESULT_PORT });
  assert.equal(processNodeOf(s, 'p').primaryDatasetId, 'raw');
  setProcessPrimarySource(s, 'p', null);
  assert.equal('primaryDatasetId' in processNodeOf(s, 'p'), false);
  assert.equal(s.connections.length, 3);
});

test('every Dataset is a candidate, in canvas order', () => {
  assert.deepEqual(processCandidateSources(processState(), 'p').map((source) => [source.nodeId, source.kind, source.port]),
    [['raw', 'dataset', RESULT_PORT], ['lookup', 'dataset', RESULT_PORT], ['raw-2', 'dataset', RESULT_PORT], ['notes', 'dataset', RESULT_PORT]]);
});

test('window bindings are the Process window aliases, with a saved alias kept and same names suffixed', () => {
  const s = processState();
  const code = 'def process(df, df_source):\n    return df.merge(df_notes)\n';
  const bindings = processInputBindings(s, 'p', { code });
  const expected = processDatasetInputs({
    datasets: s.nodes.filter((node) => node.type === 'dataset').map((node) => ({ nodeId: node.nodeId, name: node.name })),
    primaryDatasetId: 'lookup', savedAliases: { raw: 'df_source' }, code,
  }).map((binding) => ({ ...binding, port: RESULT_PORT }));
  assert.deepEqual(bindings, expected);
  assert.deepEqual(bindings.map((binding) => [binding.nodeId, binding.alias, binding.input]),
    [['raw', 'df_source', true], ['lookup', 'df', true], ['raw-2', 'df_raw_2', false], ['notes', 'df_notes', true]]);
  assert.equal(processInputBindings(s, 'p', { code, primaryId: 'raw-2' }).find((binding) => binding.primary).nodeId, 'raw-2');
});

test('required inputs are df, connected inputs and Datasets the code names, under the aliases they run with', () => {
  const s = processState();
  const { primaryId, bindings } = processRequiredInputs(s, 'p', { code: 'def process(df, df_source):\n    return df.merge(df_notes)\n' });
  assert.equal(primaryId, 'lookup');
  assert.deepEqual(bindings.map((binding) => [binding.nodeId, binding.alias, binding.primary]),
    [['raw', 'df_source', false], ['lookup', 'df', true], ['notes', 'df_notes', false]]);
  assert.deepEqual(processRequiredInputs(s, 'q', { code: 'def process(df):\n    return df\n' }), { primaryId: '', bindings: [] });
});

test('setting the inputs replaces the Process edges in place and records each alias', () => {
  const s = processState();
  const connections = s.connections;
  setProcessInputs(s, 'p', {
    primary: { nodeId: 'raw', port: RESULT_PORT },
    inputs: [{ nodeId: 'raw', port: RESULT_PORT, alias: 'df' }, { nodeId: 'notes', port: RESULT_PORT, alias: 'df_notes' }],
  });
  assert.equal(s.connections, connections);
  assert.deepEqual(s.connections, [
    { type: 'prompt-to-run', fromId: 'x', toId: 'y' },
    { fromId: 'raw', toId: 'p', type: 'dataset-to-process' },
    { fromId: 'notes', toId: 'p', type: 'dataset-to-process' },
  ]);
  assert.equal(processNodeOf(s, 'p').primaryDatasetId, 'raw');
  assert.deepEqual(processInputAliases(s, 'p'), { raw: 'df', notes: 'df_notes' });
});

test('replacing a source keeps its alias and whether it is df', () => {
  const s = processState();
  assert.equal(replaceProcessInputSource(s, 'p', { nodeId: 'raw' }, { nodeId: 'raw-2' }), true);
  assert.deepEqual(processInputAliases(s, 'p'), { 'raw-2': 'df_source' });
  assert.equal(processPrimarySource(s, 'p').nodeId, 'lookup');
  assert.equal(replaceProcessInputSource(s, 'p', { nodeId: 'lookup' }, { nodeId: 'notes' }), true);
  assert.equal(processPrimarySource(s, 'p').nodeId, 'notes');
  assert.equal(replaceProcessInputSource(s, 'p', { nodeId: 'not-an-input' }, { nodeId: 'raw' }), false);
});

test('input edges carry each alias, with df for the primary, and include Run inputs', () => {
  assert.deepEqual(processInputEdges(processState()), [
    { fromId: 'raw', fromPort: RESULT_PORT, toId: 'p', alias: 'df_source' },
    { fromId: 'lookup', fromPort: RESULT_PORT, toId: 'p', alias: 'df' },
  ]);
  const s = processState();
  s.nodes.push({ type: 'run', nodeId: 'run', runWorkingSetId: 'notes' });
  assert.deepEqual(stepInputEdges(s).map((edge) => [edge.fromId, edge.toId]), [['notes', 'run'], ['raw', 'p'], ['lookup', 'p']]);
});
