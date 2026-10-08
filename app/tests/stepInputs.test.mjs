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
