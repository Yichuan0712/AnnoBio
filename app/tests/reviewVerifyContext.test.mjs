import test from 'node:test';
import assert from 'node:assert/strict';

import { reviewVerifyContext } from '../src/reviewVerifyContext.js';

const payload = {
  run_credential_id: 'gen-1',
  run_settings: { run_max_tokens: 4096, run_concurrency: 2, run_params: { temperature: 0 } },
  score_match_code: '',
  runWs: { headers: ['text'], rows: [['a'], ['b'], ['c'], ['d']] },
  gtContent: { headers: ['drug'], rows: [['x'], ['y'], ['z']] },
};

test('nothing is added without a Generate model', () => {
  assert.deepEqual(reviewVerifyContext({ ...payload, run_credential_id: '' }, []), {});
  assert.deepEqual(reviewVerifyContext(null, []), {});
});

test('only the rows this Optimize refers to are sent, at their original indices', () => {
  const rows = [
    { input_row_index: 3, source_gt_row_index: 2 },
    { input_row_index: 1, source_gt_row_index: 0 },
    { input_row_index: 1, source_gt_row_index: null },
    { input_row_index: null, source_gt_row_index: 9 }, // out of range: skipped
    { input_row_index: Number.NaN },
  ];
  const ctx = reviewVerifyContext(payload, rows);
  assert.equal(ctx.run_credential_id, 'gen-1');
  assert.deepEqual(ctx.score_tables, {
    input_headers: ['text'], input_rows: [[1, ['b']], [3, ['d']]],
    gt_headers: ['drug'], gt_rows: [[0, ['x']], [2, ['z']]],
  });
});

test('run settings keep only what the backend accepts for a Run', () => {
  const ctx = reviewVerifyContext(payload, []);
  assert.deepEqual(ctx.run_settings, { run_max_tokens: 4096, run_concurrency: 2 });
  assert.equal(ctx.score_match_code, '');
});
