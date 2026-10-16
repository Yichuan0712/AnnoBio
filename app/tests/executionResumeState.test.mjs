import test from 'node:test';
import assert from 'node:assert/strict';

import { executionIdleLabel, reviewNeedsResume } from '../src/executionResumeState.js';

test('interrupted and partial executions use Resume across runnable node types', () => {
  assert.equal(executionIdleLabel({ interrupted: true }), 'Resume');
  assert.equal(executionIdleLabel({ hasPartial: true }), 'Resume');
  assert.equal(executionIdleLabel({ failed: true }), 'Retry');
  assert.equal(executionIdleLabel({ completed: true, interrupted: true }), 'Run again');
});

test('execution buttons name the work they start or resume', () => {
  assert.equal(executionIdleLabel({ task: 'generation' }), 'Run');
  assert.equal(executionIdleLabel({ task: 'generation', interrupted: true }), 'Resume');
  assert.equal(executionIdleLabel({ task: 'generation', completed: true }), 'Run again');
  assert.equal(executionIdleLabel({ task: 'processing' }), 'Run');
  assert.equal(executionIdleLabel({ task: 'processing', failed: true }), 'Retry');
  assert.equal(executionIdleLabel({ task: 'matching' }), 'Run');
  assert.equal(executionIdleLabel({ task: 'matching', interrupted: true }), 'Resume');
});

test('an incomplete Review resumes only when no live stream owns it', () => {
  assert.equal(reviewNeedsResume({ result: { streamComplete: false } }), true);
  assert.equal(reviewNeedsResume({ interrupted: true }), true);
  assert.equal(reviewNeedsResume({ result: { streamComplete: false }, streaming: true }), false);
  assert.equal(reviewNeedsResume({ result: { streamComplete: true }, interrupted: true }), false);
});
