import test from 'node:test';
import assert from 'node:assert/strict';

import { paramLabel, paramValue, withRunParams } from '../src/runParams.js';
import { keepKnownModels } from '../src/perModelSettings.js';

const temperature = { name: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2 };
const seed = { name: 'seed', label: 'Seed', type: 'integer', min: 0, max: 2147483647 };
const effort = { name: 'reasoning_effort', label: 'Reasoning effort', type: 'choice', choices: ['low', 'medium', 'high'] };

test('labels show the range of number parameters', () => {
  assert.equal(paramLabel(temperature), 'Temperature (0–2)');
  assert.equal(paramLabel(effort), 'Reasoning effort');
});

test('field text becomes a clamped value, and blank or nonsense means the model default', () => {
  assert.equal(paramValue(temperature, '0.3'), 0.3);
  assert.equal(paramValue(temperature, '5'), 2);
  assert.equal(paramValue(temperature, ''), null);
  assert.equal(paramValue(temperature, 'warm'), null);
  assert.equal(paramValue(seed, '7.6'), 8);
  assert.equal(paramValue(effort, 'high'), 'high');
  assert.equal(paramValue(effort, 'max'), null);
});

test('a model keeps exactly the parameters its fields hold, next to its other settings', () => {
  let settings = { a: { run_max_tokens: 2048, run_params: { top_p: 0.5 } } };
  settings = withRunParams(settings, 'a', { temperature: 0.2, seed: null });
  assert.deepEqual(settings, { a: { run_max_tokens: 2048, run_params: { temperature: 0.2 } } });
  settings = withRunParams(settings, 'a', { temperature: null });
  assert.deepEqual(settings, { a: { run_max_tokens: 2048 } });
  assert.deepEqual(withRunParams({ b: { run_params: { seed: 1 } } }, 'b', {}), {});
});

test('saving keeps the parameters of models that still exist', () => {
  const saved = keepKnownModels({
    a: { run_max_tokens: 2048, run_params: { temperature: 0.2 } },
    b: { run_params: { seed: 1 } },
    gone: { run_params: { seed: 2 } },
  }, ['a', 'b']);
  assert.deepEqual(saved, { a: { run_max_tokens: 2048, run_params: { temperature: 0.2 } }, b: { run_params: { seed: 1 } } });
});
