import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptFamilies, familySheetRows } from '../src/promptOptimization.js';

// v1 → Run 1 → Score 1 → Review → v2 (applied), v2 → v3 (new version), and an unrelated duplicate.
const canvas = () => ({
  nodes: [
    { type: 'prompt', nodeId: 'v1', name: 'Classify' },
    { type: 'prompt', nodeId: 'v2', name: 'Classify v2' },
    { type: 'prompt', nodeId: 'v3', name: 'Classify v3' },
    { type: 'prompt', nodeId: 'copy', name: 'Classify (Copy 1)' },
    { type: 'dataset', nodeId: 'gt', name: 'Labels' },
    { type: 'dataset', nodeId: 'gt-other', name: 'Other labels' },
    { type: 'run', nodeId: 'r1', runName: 'Run 1' },
    { type: 'run', nodeId: 'r2', runName: 'Run 2' },
    { type: 'score', nodeId: 's1', scoreName: 'Score 1', scoreGroundTruthId: 'gt' },
    { type: 'score', nodeId: 's2', scoreName: 'Score 2', scoreGroundTruthId: 'gt' },
    { type: 'score', nodeId: 's2-other', scoreName: 'Score 2b', scoreGroundTruthId: 'gt-other' },
    { type: 'promptReview', nodeId: 'rev', promptReviewName: 'Review 1' },
  ],
  connections: [
    { type: 'prompt-to-run', fromId: 'v1', toId: 'r1' },
    { type: 'run-to-score', fromId: 'r1', toId: 's1' },
    { type: 'score-to-prompt-review', fromId: 's1', toId: 'rev' },
    { type: 'prompt-review-to-prompt', fromId: 'rev', toId: 'v2' },
    { type: 'prompt-to-run', fromId: 'v2', toId: 'r2' },
    { type: 'run-to-score', fromId: 'r2', toId: 's2' },
    { type: 'run-to-score', fromId: 'r2', toId: 's2-other' },
    { type: 'prompt-to-prompt', fromId: 'v2', toId: 'v3' },
  ],
});

test('versions made by Review apply and by Add new version form one family, parents first', () => {
  const families = buildPromptFamilies(canvas());
  assert.equal(families.length, 1);
  const [family] = families;
  assert.deepEqual(family.versions.map((v) => [v.promptId, v.depth, v.parentId, v.via]), [
    ['v1', 0, '', ''], ['v2', 1, 'v1', 'review'], ['v3', 2, 'v2', 'version'],
  ]);
  assert.equal(family.versions[1].reviewName, 'Review 1');
  assert.deepEqual(family.versions[1].runs[0].scores.map((s) => [s.scoreId, s.groundTruthName]), [['s2', 'Labels'], ['s2-other', 'Other labels']]);
  // The duplicate has no versions and no Run, so it has nothing to show.
  assert.equal(families.some((f) => f.rootId === 'copy'), false);
});

test('tree prefixes draw the version hierarchy in characters', () => {
  const state = canvas();
  state.nodes.push({ type: 'prompt', nodeId: 'v2b', name: 'Classify v2b' }, { type: 'prompt', nodeId: 'v1b', name: 'Classify v1b' });
  state.connections.push({ type: 'prompt-to-prompt', fromId: 'v2', toId: 'v2b' }, { type: 'prompt-to-prompt', fromId: 'v1', toId: 'v1b' });
  const [family] = buildPromptFamilies(state);
  assert.deepEqual(family.versions.map((v) => [v.promptId, v.treePrefix, v.treeContinuation]), [
    ['v1', '', '│'],
    ['v1b', '├─ ', '│'],
    ['v2', '└─ ', '   │'],
    ['v3', '   ├─ ', '   │'],
    ['v2b', '   └─ ', ''],
  ]);
});

test('Excel rows keep the tree in the Version text and metrics as fractions', () => {
  const [family] = buildPromptFamilies(canvas());
  const metrics = new Map([['s1', { precision: 50, recall: 100, f1: 75 }], ['s2', null]]);
  assert.deepEqual(familySheetRows(family, metrics), [
    ['Version', 'From', 'Run', 'Score', 'Ground truth', 'Precision', 'Recall', 'F1'],
    ['Classify', '', 'Run 1', 'Score 1', 'Labels', 0.5, 1, 0.75],
    ['└─ Classify v2', 'Review "Review 1" of Classify', 'Run 2', 'Score 2', 'Labels', '', '', ''],
    ['   │', '', 'Run 2', 'Score 2b', 'Other labels', '', '', ''],
    ['   └─ Classify v3', 'New version of Classify v2', 'Not run', '', '', '', '', ''],
  ]);
});

test('a single Prompt with a Run is shown as its own family', () => {
  const state = canvas();
  state.connections.push({ type: 'prompt-to-run', fromId: 'copy', toId: 'r-copy' });
  state.nodes.push({ type: 'run', nodeId: 'r-copy', runName: 'Run copy' });
  const families = buildPromptFamilies(state);
  assert.deepEqual(families.map((f) => f.rootId), ['v1', 'copy']);
});
