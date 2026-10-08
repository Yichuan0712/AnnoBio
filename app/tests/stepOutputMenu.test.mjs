import test from 'node:test';
import assert from 'node:assert/strict';

import { stepOutputMenuItems } from '../src/stepOutputMenu.js';
import { candidateGroups } from '../src/stepInputs.js';

const ports = (list, extra = {}) => JSON.stringify({ ports: list, dynamic: false, error: '', codeHash: 'h', ...extra });
const state = {
  nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw' },
    { type: 'run', nodeId: 'run' },
    { type: 'process', nodeId: 'split', name: 'Split', processOutputPorts: ports(['ready', 'needs_name_rewrite']) },
    { type: 'process', nodeId: 'tidy', name: 'Tidy', processOutputPorts: ports(['result']) },
    { type: 'process', nodeId: 'dynamic', name: 'Dynamic', processOutputPorts: ports([], { dynamic: true }) },
  ],
  connections: [],
};
const describe = (items) => items.map((item) => [item.action, item.label, `${item.source.kind}:${item.source.nodeId}:${item.source.port}`]);

test('a Run offers a new Run and a new Process on its results', () => {
  assert.deepEqual(describe(stepOutputMenuItems(state, 'run')), [
    ['run-prompt-on-output', 'Run a prompt on results', 'run:run:result'],
    ['process-output', 'Process results with code', 'run:run:result'],
  ]);
});

test('a Process offers them per branch, or for its one result', () => {
  assert.deepEqual(describe(stepOutputMenuItems(state, 'split')), [
    ['run-prompt-on-output', "Run a prompt on 'ready'", 'process:split:ready'],
    ['run-prompt-on-output', "Run a prompt on 'needs_name_rewrite'", 'process:split:needs_name_rewrite'],
    ['process-output', "Process 'ready' with code", 'process:split:ready'],
    ['process-output', "Process 'needs_name_rewrite' with code", 'process:split:needs_name_rewrite'],
  ]);
  assert.deepEqual(describe(stepOutputMenuItems(state, 'tidy')), [
    ['run-prompt-on-output', 'Run a prompt on results', 'process:tidy:result'],
    ['process-output', 'Process results with code', 'process:tidy:result'],
  ]);
  // Branches only known after a run: nothing to start from yet.
  assert.deepEqual(stepOutputMenuItems(state, 'dynamic'), []);
});

test('a branch label shows only that branch\'s items', () => {
  assert.deepEqual(describe(stepOutputMenuItems(state, 'split', { port: 'needs_name_rewrite' })), [
    ['run-prompt-on-output', "Run a prompt on 'needs_name_rewrite'", 'process:split:needs_name_rewrite'],
    ['process-output', "Process 'needs_name_rewrite' with code", 'process:split:needs_name_rewrite'],
  ]);
  assert.deepEqual(stepOutputMenuItems(state, 'split', { port: 'gone' }), []);
});

test('Datasets and other nodes offer no step output items', () => {
  assert.deepEqual(stepOutputMenuItems(state, 'raw'), []);
  assert.deepEqual(stepOutputMenuItems(state, 'missing'), []);
});

test('input pickers list Datasets, then Step outputs, leaving out an empty group', () => {
  const raw = { kind: 'dataset', nodeId: 'raw' };
  const run = { kind: 'run', nodeId: 'run' };
  const branch = { kind: 'process', nodeId: 'split' };
  assert.deepEqual(candidateGroups([run, raw, branch]), [
    { label: 'Datasets', items: [raw] }, { label: 'Step outputs', items: [run, branch] },
  ]);
  assert.deepEqual(candidateGroups([raw]), [{ label: 'Datasets', items: [raw] }]);
  assert.deepEqual(candidateGroups([]), []);
});
