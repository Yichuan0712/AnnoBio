import test from 'node:test';
import assert from 'node:assert/strict';

import { executionIdleLabel, reviewNeedsResume } from '../src/executionResumeState.js';

test('interrupted and partial executions use Resume across runnable node types', () => {
  assert.equal(executionIdleLabel({ interrupted: true }), 'Resume');
  assert.equal(executionIdleLabel({ hasPartial: true }), 'Resume');
  assert.equal(executionIdleLabel({ failed: true }), 'Retry');
  assert.equal(executionIdleLabel({ completed: true, interrupted: true }), 'Run completed');
});

test('an incomplete Review resumes only when no live stream owns it', () => {
  assert.equal(reviewNeedsResume({ result: { streamComplete: false } }), true);
  assert.equal(reviewNeedsResume({ interrupted: true }), true);
  assert.equal(reviewNeedsResume({ result: { streamComplete: false }, streaming: true }), false);
  assert.equal(reviewNeedsResume({ result: { streamComplete: true }, interrupted: true }), false);
});
