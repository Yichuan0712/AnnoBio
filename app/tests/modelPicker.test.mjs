import test from 'node:test';
import assert from 'node:assert/strict';

import { pickInitialModel, testedModels } from '../src/modelPicker.js';

const credentials = [
  { id: 'untested', model: 'gpt-x', last_check_ok: null },
  { id: 'failed', model: 'gpt-y', last_check_ok: false },
  { id: 'claude', model: 'claude-z', last_check_ok: true },
  { id: 'gemini', model: 'gemini-w', last_check_ok: true },
];

test('only models whose Test passed are offered, in Settings order', () => {
  assert.deepEqual(testedModels(credentials).map((c) => c.id), ['claude', 'gemini']);
  assert.deepEqual(testedModels(null), []);
});

test('the first preferred model that is offered is selected', () => {
  const models = testedModels(credentials);
  assert.equal(pickInitialModel(models, ['gemini', 'claude']), 'gemini');
  assert.equal(pickInitialModel(models, ['failed', ' claude ']), 'claude');
});

test('an untested default falls back to the first tested model', () => {
  const models = testedModels(credentials);
  assert.equal(pickInitialModel(models, ['untested', '']), 'claude');
  assert.equal(pickInitialModel([], ['claude']), '');
});
