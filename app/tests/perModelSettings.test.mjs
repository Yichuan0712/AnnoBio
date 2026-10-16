import test from 'node:test';
import assert from 'node:assert/strict';

import { bindModelFields, fieldValue, keepKnownModels, withModelValue } from '../src/perModelSettings.js';

/** A stand-in for a <select> and number <input>s: value plus change listeners. */
function fakeSelect(value) {
  const listeners = [];
  return {
    value,
    addEventListener: (_type, fn) => listeners.push(fn),
    choose(next) { this.value = next; listeners.forEach((fn) => fn()); },
  };
}
const fakeInput = () => ({ value: '' });

test('field text becomes a clamped number; a blank Agent context window is Auto', () => {
  assert.equal(fieldValue('run_concurrency', '50'), 10);
  assert.equal(fieldValue('run_max_tokens', ''), null);
  assert.equal(fieldValue('agent_context_tokens', ''), 0);
  assert.equal(fieldValue('agent_context_tokens', '100'), 4096);
});

test('a value is set for one model, and a blank removes it', () => {
  let settings = withModelValue({}, 'a', 'run_max_tokens', '2048');
  assert.deepEqual(settings, { a: { run_max_tokens: 2048 } });
  settings = withModelValue(settings, 'a', 'run_max_tokens', '');
  assert.deepEqual(settings, {});
});

test('saved settings keep only existing models and per-model keys', () => {
  const settings = { a: { run_max_tokens: 2048, debug_mode: true }, gone: { run_max_tokens: 1024 }, c: { debug_mode: true } };
  assert.deepEqual(keepKnownModels(settings, ['a', 'c']), { a: { run_max_tokens: 2048 } });
});

test('the fields show the chosen model, and edits stay with the model they were made for', () => {
  const select = fakeSelect('a');
  const inputs = { run_max_tokens: fakeInput(), run_concurrency: fakeInput() };
  const state = { shared: { run_max_tokens: 8192, run_concurrency: 4 }, modelSettings: { a: { run_max_tokens: 2048 } } };
  const binding = bindModelFields({ select, inputs, state });
  binding.load();
  assert.deepEqual([inputs.run_max_tokens.value, inputs.run_concurrency.value], ['2048', '4']);

  inputs.run_concurrency.value = '6';
  select.choose('b');
  assert.deepEqual(state.modelSettings, { a: { run_max_tokens: 2048, run_concurrency: 6 } });
  assert.deepEqual([inputs.run_max_tokens.value, inputs.run_concurrency.value], ['8192', '4']);

  // Looking at a model without changing anything gives it no values of its own.
  select.choose('a');
  assert.deepEqual(Object.keys(state.modelSettings), ['a']);
});

test('with None chosen the fields edit the values models without their own use', () => {
  const select = fakeSelect('');
  const inputs = { review_max_tokens: fakeInput() };
  const state = { shared: { review_max_tokens: 32768 }, modelSettings: {} };
  const binding = bindModelFields({ select, inputs, state });
  binding.load();
  inputs.review_max_tokens.value = '16000';
  binding.stash();
  assert.deepEqual(state, { shared: { review_max_tokens: 16000 }, modelSettings: {} });
});
