import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DATA_EDGE, RESULT_PORT, processCandidateSources, processInputAliases, processInputBindings, processInputEdges,
  processPrimarySource, processRequiredInputs, replaceProcessInputSource, runInputEdges, runInputSource, runInputTable,
  setProcessInputs, setProcessPrimarySource, setRunInputSource, sourceKey, stepInputEdges, validateStepInputs,
} from '../src/stepInputs.js';
import { processDatasetInputs } from '../src/processDatasetBindings.js';

const data = (fromId, toId, alias) => ({ type: DATA_EDGE, fromId, fromPort: RESULT_PORT, toId, ...(alias ? { alias } : {}) });
const table = (value) => ({ headers: ['text'], rows: [[value]] });

// ---------- Run inputs ----------

const runState = () => ({
  nodes: [
    { type: 'dataset', nodeId: 'raw', datasetContent: table('raw') },
    { type: 'dataset', nodeId: 'subset', subsetContent: table('subset') },
    { type: 'run', nodeId: 'run-a' },
    { type: 'run', nodeId: 'run-b' },
    { type: 'run', nodeId: 'run-none' },
    { type: 'run', nodeId: 'run-gone' },
  ],
  connections: [data('raw', 'run-a'), data('subset', 'run-b'), data('deleted', 'run-gone'), { type: 'prompt-to-run', fromId: 'p', toId: 'run-a' }],
});

test('a Run reads the source of its data connection', () => {
  assert.deepEqual(runInputSource(runState(), 'run-a'), { nodeId: 'raw', port: RESULT_PORT });
  assert.deepEqual(runInputSource(runState(), 'run-b'), { nodeId: 'subset', port: RESULT_PORT });
  assert.equal(runInputSource(runState(), 'run-none'), null);
  assert.equal(runInputSource(runState(), 'missing-run'), null);
});

test('the input table is the Dataset content, a Sampler subset included', () => {
  assert.deepEqual(runInputTable(runState(), 'run-a'), table('raw'));
  assert.deepEqual(runInputTable(runState(), 'run-b'), table('subset'));
  assert.equal(runInputTable(runState(), 'run-none'), null);
  assert.equal(runInputTable(runState(), 'run-gone'), null);
});

test('setting and clearing a Run input edits the shared connections array', () => {
  const s = runState();
  const connections = s.connections;
  setRunInputSource(s, 'run-none', { nodeId: 'raw', port: RESULT_PORT });
  setRunInputSource(s, 'run-a', { nodeId: 'subset', port: RESULT_PORT });
  setRunInputSource(s, 'run-b', null);
  assert.equal(s.connections, connections);
  assert.deepEqual(runInputSource(s, 'run-none'), { nodeId: 'raw', port: RESULT_PORT });
  assert.deepEqual(runInputSource(s, 'run-a'), { nodeId: 'subset', port: RESULT_PORT });
  assert.equal(runInputSource(s, 'run-b'), null);
  assert.equal(s.connections.filter((edge) => edge.toId === 'run-a' && edge.type === DATA_EDGE).length, 1);
  setRunInputSource(s, 'missing-run', { nodeId: 'raw', port: RESULT_PORT });
  assert.equal(s.connections.some((edge) => edge.toId === 'missing-run'), false);
});

test('every Run with an input gives one edge from its source', () => {
  assert.deepEqual(runInputEdges(runState()), [
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

const processState = () => ({
  nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw' },
    { type: 'dataset', nodeId: 'lookup', name: 'Lookup' },
    { type: 'dataset', nodeId: 'raw-2', name: 'Raw' },
    { type: 'dataset', nodeId: 'notes', name: 'Notes' },
    { type: 'process', nodeId: 'p', dfCode: 'def process(df, df_source):\n    return df\n' },
    { type: 'process', nodeId: 'q' },
    { type: 'process', nodeId: 'unrecorded' },
  ],
  connections: [
    data('raw', 'p', 'df_source'),
    data('lookup', 'p', 'df'),
    data('notes', 'unrecorded'),
    { type: 'prompt-to-run', fromId: 'x', toId: 'y' },
  ],
});

test('a Process df is the input recorded as df, else its first input', () => {
  assert.deepEqual(processPrimarySource(processState(), 'p'), { nodeId: 'lookup', port: RESULT_PORT });
  assert.deepEqual(processPrimarySource(processState(), 'unrecorded'), { nodeId: 'notes', port: RESULT_PORT });
  assert.equal(processPrimarySource(processState(), 'q'), null);
});

test('setting the df moves the df alias, connecting a new source if needed', () => {
  const s = processState();
  setProcessPrimarySource(s, 'p', { nodeId: 'raw', port: RESULT_PORT });
  assert.equal(processPrimarySource(s, 'p').nodeId, 'raw');
  assert.deepEqual(processInputAliases(s, 'p'), { raw: 'df' });
  setProcessPrimarySource(s, 'p', { nodeId: 'notes', port: RESULT_PORT });
  assert.deepEqual(processInputAliases(s, 'p'), { notes: 'df' });
  assert.equal(s.connections.filter((edge) => edge.toId === 'p').length, 3);
  setProcessPrimarySource(s, 'p', null);
  assert.deepEqual(processInputAliases(s, 'p'), {});
  assert.equal(processPrimarySource(s, 'p').nodeId, 'raw');
});

test('every Dataset is a candidate, in canvas order', () => {
  assert.deepEqual(processCandidateSources(processState(), 'p').map((source) => [source.nodeId, source.kind, source.port]),
    [['raw', 'dataset', RESULT_PORT], ['lookup', 'dataset', RESULT_PORT], ['raw-2', 'dataset', RESULT_PORT], ['notes', 'dataset', RESULT_PORT]]);
});

test('window bindings are the Process window aliases, with a recorded alias kept and same names suffixed', () => {
  const s = processState();
  const code = 'def process(df, df_source):\n    return df.merge(df_notes)\n';
  const bindings = processInputBindings(s, 'p', { code });
  const expected = processDatasetInputs({
    datasets: s.nodes.filter((node) => node.type === 'dataset').map((node) => ({ nodeId: node.nodeId, name: node.name })),
    primaryDatasetId: 'lookup', savedAliases: { raw: 'df_source', lookup: 'df' }, code,
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

test('setting the inputs replaces the Process data connections in place, the primary under df', () => {
  const s = processState();
  const connections = s.connections;
  setProcessInputs(s, 'p', {
    primary: { nodeId: 'raw', port: RESULT_PORT },
    inputs: [{ nodeId: 'raw', port: RESULT_PORT, alias: 'df_raw' }, { nodeId: 'notes', port: RESULT_PORT, alias: 'df_notes' }],
  });
  assert.equal(s.connections, connections);
  assert.deepEqual(s.connections.filter((edge) => edge.toId === 'p'), [data('raw', 'p', 'df'), data('notes', 'p', 'df_notes')]);
  assert.equal(s.connections.length, 4);
  setProcessInputs(s, 'q', { primary: { nodeId: 'lookup', port: RESULT_PORT }, inputs: [] });
  assert.deepEqual(s.connections.filter((edge) => edge.toId === 'q'), [data('lookup', 'q', 'df')]);
});

test('replacing a source keeps its alias and whether it is df', () => {
  const s = processState();
  assert.equal(replaceProcessInputSource(s, 'p', { nodeId: 'raw' }, { nodeId: 'raw-2' }), true);
  assert.deepEqual(processInputAliases(s, 'p'), { 'raw-2': 'df_source', lookup: 'df' });
  assert.equal(replaceProcessInputSource(s, 'p', { nodeId: 'lookup' }, { nodeId: 'notes' }), true);
  assert.equal(processPrimarySource(s, 'p').nodeId, 'notes');
  assert.equal(replaceProcessInputSource(s, 'p', { nodeId: 'not-an-input' }, { nodeId: 'raw' }), false);
});

test('input edges carry each alias, df for the first input when none is recorded, and Run inputs too', () => {
  assert.deepEqual(processInputEdges(processState()), [
    { fromId: 'raw', fromPort: RESULT_PORT, toId: 'p', alias: 'df_source' },
    { fromId: 'lookup', fromPort: RESULT_PORT, toId: 'p', alias: 'df' },
    { fromId: 'notes', fromPort: RESULT_PORT, toId: 'unrecorded', alias: 'df' },
  ]);
  const s = processState();
  s.nodes.push({ type: 'run', nodeId: 'run' });
  s.connections.push(data('notes', 'run'));
  assert.deepEqual(stepInputEdges(s).map((edge) => [edge.fromId, edge.toId]),
    [['raw', 'p'], ['lookup', 'p'], ['notes', 'unrecorded'], ['notes', 'run']]);
});

test('validation reports a Run with two inputs, a Process without exactly one df, and a repeated alias', () => {
  assert.deepEqual(validateStepInputs(processState()), ['Process unrecorded has 0 df inputs.']);
  const s = processState();
  s.nodes.push({ type: 'run', nodeId: 'run' });
  s.connections.push(data('raw', 'run'), data('notes', 'run'), data('notes', 'p', 'df_source'));
  assert.deepEqual(validateStepInputs(s), [
    'Process p uses an alias twice.',
    'Process unrecorded has 0 df inputs.',
    'Run run has 2 inputs.',
  ]);
});
