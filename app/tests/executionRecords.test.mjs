import test from 'node:test';
import assert from 'node:assert/strict';

import {
  endInterruptedRecords, executionCounts, executionSummary, newExecutionRecord, updateExecutionRecord,
} from '../src/executionRecords.js';

const plan = {
  targetId: 'score',
  steps: [
    { nodeId: 'extract', kind: 'run', name: 'Extract', action: 'reuse' },
    { nodeId: 'tidy', kind: 'process', name: 'Tidy', action: 'run' },
    { nodeId: 'score', kind: 'run', name: 'Score', action: 'run' },
  ],
  inputs: [{ nodeId: 'docs', name: 'Docs', rows: 10, readBy: ['extract'] }],
};

test('a new record lists the plan, reused steps marked as such', () => {
  const record = newExecutionRecord(plan, { id: 'r1', now: 5, source: 'agent' });
  assert.deepEqual(record, {
    id: 'r1', createdAt: 5, updatedAt: 5, source: 'agent', targetNodeId: 'score', targetName: 'Score', scope: 'to-here', status: 'running',
    inputs: [{ nodeId: 'docs', name: 'Docs', rows: 10 }],
    steps: [
      { nodeId: 'extract', name: 'Extract', kind: 'run', action: 'reuse', status: 'reused' },
      { nodeId: 'tidy', name: 'Tidy', kind: 'process', action: 'run', status: 'pending' },
      { nodeId: 'score', name: 'Score', kind: 'run', action: 'run', status: 'pending' },
    ],
  });
});

test('a record follows the task step by step, and takes its status only when it ends', () => {
  let record = newExecutionRecord(plan, { id: 'r1', now: 1 });
  const task = { status: 'completed', steps: [
    { nodeId: 'extract', status: 'reused' },
    { nodeId: 'tidy', status: 'completed', recordId: 'h-tidy', message: 'Tidy: done' },
    { nodeId: 'score', status: 'running' },
  ] };
  record = updateExecutionRecord(record, task, { now: 2 });
  assert.equal(record.status, 'running');
  assert.deepEqual(record.steps[1], { nodeId: 'tidy', name: 'Tidy', kind: 'process', action: 'run', status: 'completed', recordId: 'h-tidy' });
  task.status = 'failed';
  task.error = '';
  task.steps[2] = { nodeId: 'score', status: 'failed', message: 'The model refused.', errorRows: 2 };
  record = updateExecutionRecord(record, task, { now: 3, ended: true });
  assert.equal(record.status, 'failed');
  assert.equal(record.updatedAt, 3);
  assert.deepEqual(record.steps[2], { nodeId: 'score', name: 'Score', kind: 'run', action: 'run', status: 'failed', errorRows: 2, message: 'The model refused.' });
  assert.deepEqual(executionCounts(record), { ran: 1, reused: 1, failed: 1, errorRows: 2 });
  assert.equal(executionSummary(record), '1 ran · 1 reused · 1 failed · 2 rows with errors');
});

test('records the app left running end as stopped; ones running in this window stay', () => {
  const left = { ...newExecutionRecord(plan, { id: 'left', now: 1 }) };
  left.steps[1] = { ...left.steps[1], status: 'running' };
  const live = newExecutionRecord(plan, { id: 'live', now: 1 });
  const done = { ...newExecutionRecord(plan, { id: 'done', now: 1 }), status: 'completed' };
  const { records, changed } = endInterruptedRecords([left, live, done], new Set(['live']), 9);
  assert.equal(changed, true);
  assert.equal(records[0].status, 'stopped');
  assert.deepEqual(records[0].steps.map((step) => step.status), ['reused', 'interrupted', 'not-started']);
  assert.equal(records[1], live);
  assert.equal(records[2], done);
  assert.equal(endInterruptedRecords([done], new Set(), 9).changed, false);
});
