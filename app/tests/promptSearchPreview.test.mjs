import test from 'node:test';
import assert from 'node:assert/strict';
import { promptSearchPreview } from '../src/agent/execution/runJobs.js';

test('APE preview: 50 proposals, round 1 scores 51 candidates on up to 16 inputs, later rounds 20', () => {
  assert.equal(promptSearchPreview('ape', 40, {}).calls, 50 + 51 * 16);
  assert.equal(promptSearchPreview('ape', 8, { ape_rounds: 3 }).calls, 50 + 51 * 8 + 2 * (10 + 20 * 8));
  assert.match(promptSearchPreview('ape', 40, {}).line, /1 round scoring candidates on 16 inputs/);
});

test('EvoPrompt preview: 10 prompts on up to 100 inputs, 10 generations by default', () => {
  assert.equal(promptSearchPreview('evoprompt', 30, {}).calls, 9 + 10 * 30 + 10 * 10 * 31);
  assert.equal(promptSearchPreview('evoprompt', 500, { evoprompt_generations: 2 }).calls, 9 + 1000 + 2 * 10 * 101);
});

test('other methods have no search preview', () => {
  assert.equal(promptSearchPreview('annobio_engine_v2', 30, {}), null);
  assert.equal(promptSearchPreview('', 30, {}), null);
});
