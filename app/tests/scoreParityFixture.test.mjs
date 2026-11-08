import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { FIXTURE_PATH, buildScoreParityFixture, serializeFixture } from './scoreParityFixture.mjs';

test('the backend scoring parity fixture matches what the JavaScript scoring produces today', async () => {
  const fresh = serializeFixture(await buildScoreParityFixture());
  const committed = gunzipSync(readFileSync(FIXTURE_PATH)).toString('utf8');
  // On failure: scoring JS changed. Run `node app/tests/scoreParityFixture.mjs`, then the backend parity test
  // (backend/test_score_engine.py) to bring backend/score_engine.py along.
  assert.ok(fresh === committed, 'backend/test_fixtures/score_parity_cases.json.gz is stale');
});
