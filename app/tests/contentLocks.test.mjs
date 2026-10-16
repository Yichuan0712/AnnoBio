import test from 'node:test';
import assert from 'node:assert/strict';
import { contentLocks, recordInputRefs } from '../src/contentLocks.js';
import { planChangeSet } from '../src/agent/operations/changeSet.js';
import { upgradeCanvasState } from '../src/canvasFormat.js';
import { extractInputFields } from '../src/promptText.js';

const canvas = (extra = {}) => ({
  nodes: [
    { type: 'prompt', nodeId: 'prompt' },
    { type: 'prompt', nodeId: 'unused-prompt' },
    { type: 'dataset', nodeId: 'input' },
    { type: 'dataset', nodeId: 'gt' },
    { type: 'dataset', nodeId: 'unused-dataset' },
    { type: 'run', nodeId: 'run', historyRecordId: extra.runRecordId },
    { type: 'process', nodeId: 'process' },
    { type: 'process', nodeId: 'fresh-process' },
    { type: 'score', nodeId: 'score', scoreGroundTruthId: 'gt' },
  ],
  connections: [{ type: 'run-to-score', fromId: 'run', toId: 'score' }],
});
const runRecord = { kind: 'run', nodeId: 'run', inputs: { prompt: { nodeId: 'prompt' }, dataset: { nodeId: 'input' } } };
const processRecord = { kind: 'process', nodeId: 'process', inputs: { bindings: [{ nodeId: 'input' }] } };

test('a Generate result locks its Prompt and input Dataset; a Process result locks its inputs but not its own code', () => {
  const locks = contentLocks([runRecord, processRecord].map(recordInputRefs), canvas());
  assert.deepEqual(locks.get('prompt'), ['run']);
  assert.deepEqual(locks.get('input'), ['run', 'process']);
  assert.equal(locks.has('process'), false);
  assert.equal(locks.has('unused-prompt'), false);
  assert.equal(locks.has('unused-dataset'), false);
  assert.equal(locks.has('fresh-process'), false);
});

test('nothing is locked before a result exists', () => {
  assert.equal(contentLocks([], canvas()).size, 0);
});

test('a real Sample output locks its source Dataset for every sampling method', () => {
  for (const samplingType of ['without-replacement', 'with-replacement', 'specify-rows']) {
    const state = {
      nodes: [
        { type: 'dataset', nodeId: 'source' },
        { type: 'sampler', nodeId: 'sample', sourceNodeId: 'source', samplingType },
        { type: 'dataset', nodeId: 'output', samplerNodeId: 'sample' },
        { type: 'dataset', nodeId: 'version', samplerNodeId: 'sample' },
      ],
      connections: [{ type: 'dataset-to-sampler', fromId: 'source', toId: 'sample' }],
    };
    assert.equal(contentLocks([], state).has('source'), false);
    state.connections.push({ type: 'sampler-to-dataset', fromId: 'sample', toId: 'output' });
    assert.deepEqual(contentLocks([], state).get('source'), ['sample']);
    assert.equal(contentLocks([], state).has('output'), false);
    state.nodes = state.nodes.filter((node) => node.nodeId !== 'output');
    assert.equal(contentLocks([], state).has('source'), false);
  }
});

test('the Agent cannot edit the source Dataset after adding a Sample in the same proposal', () => {
  const state = upgradeCanvasState({
    nodes: [{ type: 'dataset', nodeId: 'source', name: 'Source',
      datasetContent: { headers: ['value'], columnTypes: ['text'], rows: [['a'], ['b']] } }],
    connections: [],
  });
  const sample = { op: 'add_sampler', source: 'source', sampling: 'random', size_unit: 'rows', size: 1 };
  const edit = { op: 'update', node: 'source', set: { rows: [['changed'], ['b']] } };
  assert.throws(() => planChangeSet(state, [sample, edit], { extractInputFields: () => [] }), /content is locked/);
});

test('a ground truth is locked while its Score shows a result, or once it was saved with a Score or Review', () => {
  assert.equal(contentLocks([], canvas()).has('gt'), false);
  assert.deepEqual(contentLocks([], canvas({ runRecordId: 'r1' })).get('gt'), ['score']);
  const scoreRecord = { kind: 'score', nodeId: 'score', inputs: { groundTruthId: 'gt' } };
  assert.deepEqual(contentLocks([recordInputRefs(scoreRecord)], canvas()).get('gt'), ['score']);
  const reviewRecord = { kind: 'review', nodeId: 'review', inputs: { scoreNodeId: 'score' } };
  assert.deepEqual(contentLocks([recordInputRefs(reviewRecord)], canvas()).get('gt'), ['score']);
});

test('results of a node that was removed from the canvas no longer lock its inputs', () => {
  const state = canvas();
  state.nodes = state.nodes.filter((node) => node.nodeId !== 'run');
  const locks = contentLocks([recordInputRefs(runRecord)], state);
  assert.equal(locks.has('prompt'), false);
  assert.equal(locks.has('input'), false);
});

test('the Agent cannot edit locked content either, but can rename it and edit Process code', () => {
  const state = upgradeCanvasState({
    nodes: [
      { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: { headers: ['text'], columnTypes: ['text'], rows: [['a']] } },
      { type: 'prompt', nodeId: 'p', name: 'Extract', text: 'Read {text}',
        outputFormat: { returnShape: 'single', fields: [{ key: 'answer', type: 'str' }] } },
      { type: 'process', nodeId: 'proc', name: 'Clean', dfCode: 'def process(df):\n    return df', primaryDatasetId: 'raw' },
    ],
    connections: [{ fromId: 'raw', toId: 'proc', type: 'dataset-to-process' }],
  });
  const ctx = {
    extractInputFields,
    contentLocks: new Map([['p', ['run']], ['raw', ['run']], ['proc', ['proc']]]),
  };
  const update = (node, set) => () => planChangeSet(state, [{ op: 'update', node, set }], ctx);
  assert.throws(update('p', { text: 'Summarize {text}' }), /locked\. Use add_prompt_version/);
  assert.throws(update('raw', { rows: [['b']] }), /locked\. Add a new dataset/);
  assert.doesNotThrow(update('proc', { code: 'def process(df):\n    return df.head()' }));
  assert.doesNotThrow(update('p', { name: 'Extract (old)' }));
  assert.doesNotThrow(update('raw', { note: 'used by the first run' }));
});

test('a step output read by another step locks nothing; its Datasets and Prompt still lock', () => {
  const run = recordInputRefs({ kind: 'run', nodeId: 'b', inputs: {
    prompt: { nodeId: 'pb' }, dataset: { kind: 'step', nodeId: 'a', port: 'result', recordId: 'record-a' },
  } });
  const process = recordInputRefs({ kind: 'process', nodeId: 'p', inputs: { bindings: [
    { kind: 'step', nodeId: 'split', port: 'left', recordId: 'record-s', alias: 'df' },
    { kind: 'dataset', nodeId: 'lookup', alias: 'df_lookup' },
  ] } });
  assert.deepEqual([run.datasetIds, process.datasetIds], [[], ['lookup']]);
  const canvas = { nodes: ['a', 'b', 'pb', 'split', 'p', 'lookup'].map((nodeId) => ({ nodeId })), connections: [] };
  assert.deepEqual([...contentLocks([run, process], canvas)], [['pb', ['b']], ['lookup', ['p']]]);
});
