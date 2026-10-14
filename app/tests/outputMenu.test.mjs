import test from 'node:test';
import assert from 'node:assert/strict';

import { outputMenuItems } from '../src/outputMenu.js';

const ports = (list, extra = {}) => JSON.stringify({ ports: list, dynamic: false, error: '', codeHash: 'h', ...extra });
const results = JSON.stringify([{ row_index: 0, output: { label: 'pos' } }]);
const state = {
  nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw' },
    { type: 'prompt', nodeId: 'classify', name: 'Classify' },
    { type: 'run', nodeId: 'run' },
    { type: 'run', nodeId: 'done', runResults: results },
    { type: 'process', nodeId: 'split', name: 'Split', processOutputPorts: ports(['ready', 'needs_name_rewrite']) },
    { type: 'process', nodeId: 'tidy', name: 'Tidy', processOutputPorts: ports(['result']) },
    { type: 'process', nodeId: 'dynamic', name: 'Dynamic', processOutputPorts: ports([], { dynamic: true }) },
    { type: 'score', nodeId: 'score', scoreName: 'Score', scoreGroundTruthId: 'raw' },
    { type: 'score', nodeId: 'unscored', scoreName: 'Score' },
    { type: 'sampler', nodeId: 'sampler', name: 'Sample' },
    { type: 'promptReview', nodeId: 'review', name: 'Review' },
  ],
  connections: [
    { type: 'run-to-score', fromId: 'done', toId: 'score' },
    { type: 'run-to-score', fromId: 'run', toId: 'unscored' },
  ],
};
const describe = (items) => items.map((item) => [item.action, item.label, `${item.source.kind}:${item.source.nodeId}:${item.source.port}`, ...(item.disabled ? ['disabled'] : [])]);

test('a Run offers a new Run and a new Process on its results, then a Score once it has results', () => {
  assert.deepEqual(describe(outputMenuItems(state, 'run')), [
    ['run-prompt-on-output', 'Create Run from results', 'run:run:result'],
    ['process-output', 'Create Process from results', 'run:run:result'],
    ['save-to-workspace-and-score', 'Create Score', 'run:run:result', 'disabled'],
  ]);
  assert.equal(outputMenuItems(state, 'done').at(-1).disabled, false);
});

test('a Process offers them per branch, or for its one result', () => {
  assert.deepEqual(describe(outputMenuItems(state, 'split')), [
    ['run-prompt-on-output', "Create Run from 'ready'", 'process:split:ready'],
    ['run-prompt-on-output', "Create Run from 'needs_name_rewrite'", 'process:split:needs_name_rewrite'],
    ['process-output', "Create Process from 'ready'", 'process:split:ready'],
    ['process-output', "Create Process from 'needs_name_rewrite'", 'process:split:needs_name_rewrite'],
  ]);
  assert.deepEqual(describe(outputMenuItems(state, 'tidy')), [
    ['run-prompt-on-output', 'Create Run from results', 'process:tidy:result'],
    ['process-output', 'Create Process from results', 'process:tidy:result'],
  ]);
  // Branches only known after a run: nothing to start from yet.
  assert.deepEqual(outputMenuItems(state, 'dynamic'), []);
});

test('a Dataset offers a Run, a Sample and a Process; a Prompt offers a Run', () => {
  assert.deepEqual(describe(outputMenuItems(state, 'raw')), [
    ['run-prompt-on-output', 'Create Run with this data', 'dataset:raw:result'],
    ['add-sampler', 'Create Sample', 'dataset:raw:result'],
    ['process-output', 'Create Process', 'dataset:raw:result'],
  ]);
  assert.deepEqual(describe(outputMenuItems(state, 'classify')), [['run-this-prompt', 'Create Run', 'prompt:classify:prompt']]);
});

test('a Score offers a Review once its Run has results and it has a ground truth', () => {
  assert.deepEqual(describe(outputMenuItems(state, 'score')), [['score-add-review', 'Start review', 'score:score:score']]);
  assert.deepEqual(describe(outputMenuItems(state, 'unscored')), [['score-add-review', 'Start review', 'score:unscored:score', 'disabled']]);
});

test('with a port, only that output\'s items: a branch, or the one output of any other node', () => {
  assert.deepEqual(describe(outputMenuItems(state, 'split', { port: 'needs_name_rewrite' })), [
    ['run-prompt-on-output', "Create Run from 'needs_name_rewrite'", 'process:split:needs_name_rewrite'],
    ['process-output', "Create Process from 'needs_name_rewrite'", 'process:split:needs_name_rewrite'],
  ]);
  assert.deepEqual(outputMenuItems(state, 'split', { port: 'gone' }), []);
  assert.equal(outputMenuItems(state, 'raw', { port: 'result' }).length, 3);
  assert.equal(outputMenuItems(state, 'classify', { port: 'prompt' }).length, 1);
  assert.equal(outputMenuItems(state, 'score', { port: 'score' }).length, 1);
  assert.deepEqual(outputMenuItems(state, 'raw', { port: 'prompt' }), []);
});

test('nodes without outputs offer nothing', () => {
  assert.deepEqual(outputMenuItems(state, 'sampler'), []);
  assert.deepEqual(outputMenuItems(state, 'review'), []);
  assert.deepEqual(outputMenuItems(state, 'missing'), []);
});
