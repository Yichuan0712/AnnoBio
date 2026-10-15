import test from 'node:test';
import assert from 'node:assert/strict';
import { inputMenuItems, outputMenuItems } from '../src/outputMenu.js';
import { LINEAGE_PORT } from '../src/nodePorts.js';

const detected = ports => ({ ports, dynamic: false, error: '', codeHash: 'h' });
const results = JSON.stringify([{ row_index: 0, output: { label: 'pos' } }]);
const canvas = () => ({ historyVersion: 1,
  nodes: [
    { type: 'dataset', nodeId: 'raw', datasetContent: { headers: ['id'], rows: [['1'], ['2']], rowIds: ['a', 'b'] } },
    { type: 'prompt', nodeId: 'prompt' },
    { type: 'run', nodeId: 'run' },
    { type: 'run', nodeId: 'done', runResults: results, historyRecordId: 'run-record' },
    { type: 'process', nodeId: 'split', processOutputPorts: detected(['kept', 'empty']), historyRecordId: 'process-record',
      dfResults: { outputs: { kept: { headers: ['id'], rows: [['1']] }, empty: { headers: [], rows: [] } } } },
    { type: 'process', nodeId: 'unknown', processOutputPorts: { ports: [], dynamic: true, error: '', codeHash: 'u' } },
    { type: 'score', nodeId: 'score', scoreGroundTruthId: 'raw' },
    { type: 'score', nodeId: 'unscored' },
    { type: 'sampler', nodeId: 'sample', sourceNodeId: 'raw', samplingType: 'without-replacement', sampleSizeType: 'rows', sampleSize: 1 },
    { type: 'promptReview', nodeId: 'optimize', reviewResult: JSON.stringify({ streamComplete: true, workingText: 'Classify.' }) },
    { type: 'promptReview', nodeId: 'unfinished' },
  ], connections: [ { type: 'run-to-score', fromId: 'done', toId: 'score' } ],
});
const actions = items => items.map(item => item.action);

test('one Run output offers all readers, saving and Evaluate without duplicates', () => {
  const state = canvas();
  assert.deepEqual(actions(outputMenuItems(state, 'done', { port: 'result' })), ['run-prompt-on-output', 'process-output', 'save-results-to-workspace', 'save-to-workspace-and-score']);
  assert.deepEqual(actions(outputMenuItems(state, 'done', { port: LINEAGE_PORT })), ['save-to-workspace-and-score', 'save-results-to-workspace']);
  const menu = outputMenuItems(state, 'done');
  assert.equal(menu.filter(item => item.action === 'save-results-to-workspace').length, 1);
  assert(menu.every(item => !item.disabled));
  assert(outputMenuItems(state, 'run', { port: LINEAGE_PORT }).every(item => item.disabled && item.disabledReason));
});

test('Process branch menus save only that branch, including zero rows and zero columns', () => {
  const state = canvas();
  const menu = outputMenuItems(state, 'split', { port: 'empty' });
  assert.deepEqual(actions(menu), ['run-prompt-on-output', 'process-output', 'process-save-to-workspace']);
  assert(menu.every(item => item.source.port === 'empty' && !item.disabled));
  const full = outputMenuItems(state, 'split');
  assert.equal(full.filter(item => item.action === 'process-save-to-workspace').length, 1);
  assert.equal(full.at(-1).source.port, LINEAGE_PORT);
  assert.deepEqual(outputMenuItems(state, 'split', { port: 'gone' }), []);
  state.nodes.find(node => node.nodeId === 'split').processPending = true;
  assert(outputMenuItems(state, 'split', { port: 'empty' }).at(-1).disabled);
});

test('Dataset and Prompt each expose their complete menu from one output', () => {
  const state = canvas();
  assert.deepEqual(actions(outputMenuItems(state, 'raw', { port: 'result' })), ['run-prompt-on-output', 'process-output', 'add-sampler', 'add-version-of-dataset']);
  assert.deepEqual(actions(outputMenuItems(state, 'raw', { port: LINEAGE_PORT })), ['add-sampler', 'add-version-of-dataset']);
  assert.deepEqual(actions(outputMenuItems(state, 'prompt', { port: 'prompt' })), ['run-this-prompt', 'new-version']);
  assert.deepEqual(actions(outputMenuItems(state, 'prompt', { port: LINEAGE_PORT })), ['new-version']);
  assert.equal(outputMenuItems(state, 'prompt').length, 2);
});

test('one Evaluate output offers comparison saving and Optimize', () => {
  const state = canvas();
  assert.deepEqual(actions(outputMenuItems(state, 'score', { port: 'score' })), ['score-save-to-workspace', 'score-add-review']);
  assert.deepEqual(actions(outputMenuItems(state, 'score', { port: LINEAGE_PORT })), ['score-add-review', 'score-save-to-workspace']);
  assert.equal(outputMenuItems(state, 'score').filter(item => item.action === 'score-save-to-workspace').length, 1);
  assert(outputMenuItems(state, 'unscored').every(item => item.disabled));
});

test('Optimize exposes creating a Prompt and explains unfinished results', () => {
  const state = canvas();
  const [ready] = outputMenuItems(state, 'optimize', { port: LINEAGE_PORT });
  assert.equal(ready.action, 'review-export');
  assert.equal(ready.disabled, undefined);
  assert.equal(outputMenuItems(state, 'unfinished')[0].disabled, true);
  assert.match(outputMenuItems(state, 'unfinished')[0].disabledReason, /Finish optimization/);
});

test('Sample creation checks its finite quota; with replacement still allows more pulls', () => {
  const state = canvas();
  const menu = () => outputMenuItems(state, 'sample', { port: LINEAGE_PORT });
  assert.equal(menu()[0].disabled, undefined);
  state.nodes.push({ type: 'dataset', nodeId: 'pulled', samplerNodeId: 'sample', datasetContent: { headers: ['id'], rows: [['1'], ['2']] }, sampledSourceRowIds: ['a', 'b'] });
  state.connections.push({ type: 'sampler-to-dataset', fromId: 'sample', toId: 'pulled' });
  assert.equal(menu()[0].disabled, true);
  state.nodes.find(node => node.nodeId === 'sample').samplingType = 'with-replacement';
  assert.equal(menu()[0].disabled, undefined);
});

test('unknown output branches cannot be connected but keep their save action visible and disabled', () => {
  const state = canvas();
  assert.deepEqual(outputMenuItems(state, 'unknown', { port: 'result' }), []);
  assert.equal(outputMenuItems(state, 'unknown', { port: LINEAGE_PORT })[0].disabled, true);
  assert.deepEqual(outputMenuItems(state, 'missing'), []);
});

test('empty inputs create only compatible upstream node types and obey fixed/running constraints', () => {
  const state = canvas();
  const types = (node, port) => inputMenuItems(state, node, port).map(item => item.createType);
  assert.deepEqual(types('run', 'prompt'), ['prompt']);
  assert.deepEqual(types('run', 'input'), ['dataset', 'run', 'process']);
  assert.deepEqual(types('unknown', 'df'), ['dataset', 'run', 'process']);
  assert.deepEqual(types('unscored', 'ground_truth'), ['dataset']);
  assert.deepEqual(types('score', 'run'), []);
  assert.deepEqual(types('sample', 'source'), []);
  assert(inputMenuItems(state, 'run', 'input').every(item => !item.disabled));
  state.nodes.find(node => node.nodeId === 'run').runPending = true;
  assert(inputMenuItems(state, 'run', 'input').every(item => item.disabled && /running/.test(item.disabledReason)));
});
