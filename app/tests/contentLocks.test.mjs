import test from 'node:test';
import assert from 'node:assert/strict';
import { contentLocks, recordInputRefs } from '../src/contentLocks.js';
import { planChangeSet } from '../src/agent/operations/changeSet.js';

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

test('a Run result locks its Prompt and input Dataset; a Process result locks its inputs but not its own code', () => {
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
  const state = {
    nodes: [
      { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: { headers: ['text'], columnTypes: ['text'], rows: [['a']] } },
      { type: 'prompt', nodeId: 'p', name: 'Extract', sections: [{ name: 'Task', content: 'Read {text}' }],
        outputFormat: { returnShape: 'single', fields: [{ key: 'answer', type: 'str' }] } },
      { type: 'process', nodeId: 'proc', name: 'Clean', dfCode: 'def process(df):\n    return df', primaryDatasetId: 'raw' },
    ],
    connections: [{ fromId: 'raw', toId: 'proc', type: 'dataset-to-process' }],
  };
  const ctx = {
    extractInputFields: (sections) => [...String(sections[0]?.content || '').matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]),
    contentLocks: new Map([['p', ['run']], ['raw', ['run']], ['proc', ['proc']]]),
  };
  const update = (node, set) => () => planChangeSet(state, [{ op: 'update', node, set }], ctx);
  assert.throws(update('p', { sections: [{ name: 'Task', content: 'Summarize {text}' }] }), /locked\. Use add_prompt_version/);
  assert.throws(update('raw', { rows: [['b']] }), /locked\. Add a new dataset/);
  assert.doesNotThrow(update('proc', { code: 'def process(df):\n    return df.head()' }));
  assert.doesNotThrow(update('p', { name: 'Extract (old)' }));
  assert.doesNotThrow(update('raw', { note: 'used by the first run' }));
});
