import test from 'node:test';
import assert from 'node:assert/strict';

import { structuredModePill, structuredModeStatus } from '../src/structuredModeStatus.js';

const checked = (mode, detail = '') => ({ id: 'a', structured_check_ok: true, structured_mode: mode, structured_check_detail: detail });

test('no model chosen shows nothing', () => {
  assert.equal(structuredModeStatus(undefined).hidden, true);
});

test('a model never checked offers Check', () => {
  const status = structuredModeStatus({ id: 'a' });
  assert.equal(status.button, 'Check');
  assert.match(status.text, /Not checked yet/);
});

test('the native modes read as fine and the prompt-only modes as a warning', () => {
  assert.equal(structuredModeStatus(checked('json_schema')).state, 'ok');
  assert.match(structuredModeStatus(checked('tool')).text, /tool call/);
  for (const mode of ['json_object', 'prompt']) {
    const status = structuredModeStatus(checked(mode, 'Rejected: json_schema (unavailable)'));
    assert.equal(status.state, 'warning');
    assert.match(status.text, /asked for JSON in the prompt/);
    assert.equal(status.title, 'Rejected: json_schema (unavailable)');
    assert.equal(status.button, 'Check again');
  }
});

test('a model that failed every mode says so with the reason', () => {
  const status = structuredModeStatus({ id: 'a', structured_check_ok: false, structured_check_detail: 'all four failed' });
  assert.equal(status.state, 'error');
  assert.match(status.text, /any of the four ways tried\. all four failed$/);
});

test('a check in flight hides the button, and a check that could not run says why', () => {
  assert.equal(structuredModeStatus({ id: 'a' }, { checking: true }).button, null);
  const failed = structuredModeStatus(checked('tool'), { checkError: 'Invalid API key' });
  assert.equal(failed.state, 'warning');
  assert.match(failed.text, /Could not check this model: Invalid API key/);
});

test('pills mark only the models that need attention', () => {
  assert.equal(structuredModePill(checked('json_schema')), null);
  assert.equal(structuredModePill(checked('tool')), null);
  assert.equal(structuredModePill({ id: 'a' }), null);
  assert.deepEqual(structuredModePill(checked('prompt')), ['JSON by prompt', 'warning']);
  assert.deepEqual(structuredModePill({ id: 'a', structured_check_ok: false }), ['No structured output', 'error']);
});
