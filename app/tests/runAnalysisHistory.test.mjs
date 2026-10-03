import test from 'node:test';
import assert from 'node:assert/strict';

import { analysisInputKeys, analysisKeyForSave } from '../src/runAnalysisHistory.js';

const state = () => ({
  nodes: [
    { type: 'run', nodeId: 'run' },
    { type: 'dataset', nodeId: 'gt', datasetContent: { headers: ['answer'], rows: [['yes']], columnTypes: ['text'], rowIds: ['row-1'] } },
    { type: 'score', nodeId: 'score', scoreGroundTruthId: 'gt', scoreMapping: { output: 'answer' }, scoreRowExcludedFromScoring: {} },
    { type: 'promptReview', nodeId: 'review' },
  ],
  connections: [
    { type: 'run-to-score', fromId: 'run', toId: 'score' },
    { type: 'score-to-prompt-review', fromId: 'score', toId: 'review' },
  ],
});

test('Score key changes with Run record, ground truth, code and mapping', async () => {
  const base = state();
  const first = await analysisInputKeys(base, { run: 'record-1' });
  const changedRun = await analysisInputKeys(base, { run: 'record-2' });
  assert.notEqual(first.score.get('score').signature, changedRun.score.get('score').signature);
  base.nodes.find((node) => node.nodeId === 'gt').datasetContent.rows[0][0] = 'no';
  const changedGt = await analysisInputKeys(base, { run: 'record-1' });
  assert.notEqual(first.score.get('score').signature, changedGt.score.get('score').signature);
  base.nodes.find((node) => node.nodeId === 'score').scoreMatchCode = 'return True';
  const changedCode = await analysisInputKeys(base, { run: 'record-1' });
  assert.notEqual(changedGt.score.get('score').signature, changedCode.score.get('score').signature);
});

test('Review key changes with exclusions and model while Score key stays stable', async () => {
  const base = state();
  const first = await analysisInputKeys(base, { run: 'record-1' });
  base.nodes.find((node) => node.nodeId === 'score').scoreRowExcludedFromScoring = { 'row-1': true };
  const excluded = await analysisInputKeys(base, { run: 'record-1' });
  assert.equal(first.score.get('score').signature, excluded.score.get('score').signature);
  assert.notEqual(first.review.get('review').signature, excluded.review.get('review').signature);
  base.nodes.find((node) => node.nodeId === 'score').reviewCredentialId = 'model-2';
  const modelChanged = await analysisInputKeys(base, { run: 'record-1' });
  assert.notEqual(excluded.review.get('review').signature, modelChanged.review.get('review').signature);
});

test('Score and Review have no current analysis key without a Run result', async () => {
  const keys = await analysisInputKeys(state(), {});
  assert.equal(keys.score.size, 0);
  assert.equal(keys.review.size, 0);
});

test('Score analysis records the source record of a derived ground truth', async () => {
  const base = state();
  base.nodes.find((node) => node.nodeId === 'gt').sourceRunNodeId = 'gt-run';
  const keys = await analysisInputKeys(base, { run: 'answer-run', 'gt-run': 'truth-run' });
  assert.equal(keys.score.get('score').inputs.groundTruthSourceRecordId, 'truth-run');
  assert.equal(keys.review.get('review').inputs.scoreNodeId, 'score');
});

test('new Review result is saved under its current signature on the first History sync', () => {
  const currentReviewKey = { signature: 'review-current' };
  const currentKeys = { review: new Map([['new-review', currentReviewKey]]) };
  assert.equal(
    analysisKeyForSave(new Map(), currentKeys, 'review', 'new-review'),
    currentReviewKey,
  );
});

test('initial History sync does not attach a stale cache to current inputs', () => {
  const currentKeys = { review: new Map([['saved-review', { signature: 'current-inputs' }]]) };
  assert.equal(
    analysisKeyForSave(new Map(), currentKeys, 'review', 'saved-review', false),
    null,
  );
});

test('existing analysis result stays with its prior signature after inputs change', () => {
  const priorScoreKey = { signature: 'score-before-edit' };
  const currentScoreKey = { signature: 'score-after-edit' };
  const priorKeys = new Map([['score:score', priorScoreKey]]);
  const currentKeys = { score: new Map([['score', currentScoreKey]]) };
  assert.equal(analysisKeyForSave(priorKeys, currentKeys, 'score', 'score'), priorScoreKey);
});
