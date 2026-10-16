import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptFamilies } from '../src/promptOptimization.js';
import { buildPromptFamilyRoute, renderPromptFamily } from '../src/promptVersionTree.js';

const canvas = () => ({
  nodes: [
    { type: 'prompt', nodeId: 'v1', name: 'Classify' },
    { type: 'prompt', nodeId: 'v2', name: 'Classify v2' },
    { type: 'prompt', nodeId: 'v3', name: 'Classify v3' },
    { type: 'prompt', nodeId: 'copy', name: 'Classify (Copy 1)' },
    { type: 'run', nodeId: 'r1' },
    { type: 'score', nodeId: 's1' },
    { type: 'promptReview', nodeId: 'rev', promptReviewName: 'Improve extraction', reviewMethodId: 'gepa' },
  ],
  connections: [
    { type: 'prompt-to-run', fromId: 'v1', toId: 'r1' },
    { type: 'run-to-score', fromId: 'r1', toId: 's1' },
    { type: 'score-to-prompt-review', fromId: 's1', toId: 'rev' },
    { type: 'prompt-review-to-prompt', fromId: 'rev', toId: 'v2' },
    { type: 'prompt-to-prompt', fromId: 'v2', toId: 'v3' },
  ],
});

test('Optimize and manual versions retain ancestry; independent copies appear without needing runs', () => {
  const families = buildPromptFamilies(canvas());
  assert.deepEqual(families.map((family) => family.rootId), ['v1', 'copy']);
  assert.deepEqual(families[0].versions.map((version) => [version.promptId, version.parentId, version.via, version.changeLabel]), [
    ['v1', '', '', ''], ['v2', 'v1', 'review', 'Optimize · GEPA'], ['v3', 'v2', 'version', 'Manual edit'],
  ]);
  assert.equal(families[0].versions[1].reviewName, 'Improve extraction');
  assert.equal(buildPromptFamilies({ nodes: [{ type: 'prompt', nodeId: 'new' }], connections: [] }).length, 1);
});

test('missing Optimize method information is not replaced with a guessed default', () => {
  const state = canvas();
  delete state.nodes.find((node) => node.nodeId === 'rev').reviewMethodId;
  assert.equal(buildPromptFamilies(state)[0].versions[1].changeLabel, 'Optimize');
  state.nodes.find((node) => node.nodeId === 'rev').reviewMethodId = 'custom_search';
  assert.equal(buildPromptFamilies(state)[0].versions[1].changeLabel, 'Optimize · custom_search');
});

test('agent-created manual versions identify the editing source', () => {
  const state = canvas();
  state.nodes.find((node) => node.nodeId === 'v3').nodeOrigin = 'agent';
  assert.equal(buildPromptFamilies(state)[0].versions[2].changeLabel, 'Agent edit');
});

test('a created version keeps its recorded Optimize method after the Optimize node is rerun', () => {
  const state = canvas();
  state.nodes.find((node) => node.nodeId === 'v2').optimizationMethodId = 'gepa';
  state.nodes.find((node) => node.nodeId === 'rev').reviewMethodId = 'textgrad';
  const reopened = JSON.parse(JSON.stringify(state));
  assert.equal(buildPromptFamilies(reopened)[0].versions[1].changeLabel, 'Optimize · GEPA');
});

test('missing ancestry endpoints leave a standalone Prompt instead of inventing a parent', () => {
  const state = canvas();
  state.nodes = state.nodes.filter((node) => node.nodeId !== 's1');
  assert.deepEqual(buildPromptFamilies(state).map((family) => family.rootId), ['v1', 'v2', 'copy']);
});

test('malformed imported cycles are displayed once with a stable root', () => {
  const state = { nodes: ['a', 'b', 'c'].map((nodeId) => ({ type: 'prompt', nodeId })),
    connections: [
      { type: 'prompt-to-prompt', fromId: 'a', toId: 'b' },
      { type: 'prompt-to-prompt', fromId: 'b', toId: 'a' },
      { type: 'prompt-to-prompt', fromId: 'b', toId: 'c' },
    ] };
  const [family] = buildPromptFamilies(state);
  assert.equal(family.rootId, 'a');
  assert.deepEqual(family.versions.map((version) => version.promptId), ['a', 'b', 'c']);
  assert.equal((renderPromptFamily(family).match(/data-action="compare"/g) || []).length, 2);
});

test('an applied Optimize is one Evaluate & Optimize round between two versions', () => {
  const state = canvas();
  state.nodes.push({ type: 'dataset', nodeId: 'in', name: 'Abstracts' }, { type: 'dataset', nodeId: 'gt', name: 'Gold' });
  state.nodes.find((node) => node.nodeId === 's1').scoreGroundTruthId = 'gt';
  state.connections.push({ type: 'data', fromId: 'in', fromPort: 'result', toId: 'r1' });
  const [family] = buildPromptFamilies(state);
  assert.equal(family.rounds.length, 1);
  assert.deepEqual(family.rounds[0], {
    promptId: 'v1', runId: 'r1', scoreId: 's1', reviewId: 'rev', reviewName: 'Improve extraction', method: 'GEPA',
    childIds: ['v2'], runName: 'Generate', scoreName: 'Evaluate', inputName: 'Abstracts', groundTruthName: 'Gold',
    id: 'review:rev:GEPA', status: 'applied',
  });
  const route = buildPromptFamilyRoute(family);
  assert.deepEqual(route.map((step) => step.kind), ['prompt', 'round', 'prompt', 'prompt']);
  assert.deepEqual(route.map((step) => step.version?.promptId || step.round.id), ['v1', 'review:rev:GEPA', 'v2', 'v3']);
});

test('rounds not finished yet end their branch beside the applied versions', () => {
  const state = canvas();
  state.nodes.push({ type: 'run', nodeId: 'r2' }, { type: 'score', nodeId: 's2', scoreName: 'Check v2' },
    { type: 'score', nodeId: 's3' }, { type: 'promptReview', nodeId: 'rev2', reviewMethodId: 'textgrad' });
  state.connections.push({ type: 'prompt-to-run', fromId: 'v2', toId: 'r2' }, { type: 'run-to-score', fromId: 'r2', toId: 's2' },
    { type: 'run-to-score', fromId: 'r1', toId: 's3' }, { type: 'score-to-prompt-review', fromId: 's3', toId: 'rev2' });
  const [family] = buildPromptFamilies(state);
  assert.deepEqual(family.rounds.map((round) => [round.id, round.status, round.method]), [
    ['review:rev:GEPA', 'applied', 'GEPA'], ['review:rev2', 'notApplied', 'TextGrad'], ['score:s2', 'notOptimized', ''],
  ]);
  const html = renderPromptFamily(family);
  assert.equal((html.match(/prompt-flow__step--pending/g) || []).length, 2);
  assert.match(html, /Not applied yet<\/span><span class="pipeline-step-name">TextGrad/);
  assert.match(html, /Not optimized yet<\/span><span class="pipeline-step-name">Check v2/);
  // v1 forks into the applied round and the pending one; v2 continues to v3 and its pending Evaluate.
  const [, fork] = buildPromptFamilyRoute(family);
  assert.equal(fork.kind, 'branch');
  assert.deepEqual(fork.lanes.map((lane) => lane[0].round.id), ['review:rev:GEPA', 'review:rev2']);
});

test('an Optimize without a chosen method uses the method its result recorded', () => {
  const state = canvas();
  const review = state.nodes.find((node) => node.nodeId === 'rev');
  delete review.reviewMethodId;
  review.reviewResult = JSON.stringify({ review_method_id: 'issue_analysis_suggestions' });
  const [family] = buildPromptFamilies(state);
  assert.equal(family.versions[1].changeLabel, 'Optimize · Thompson Prompt Search');
  assert.equal(family.rounds[0].method, 'Thompson Prompt Search');
  delete review.reviewResult;
  const html = renderPromptFamily(buildPromptFamilies(state)[0]);
  assert.match(html, /title="Method: not recorded&#10;/);
  assert.match(html, /<span class="pipeline-step-name">Improve extraction</);
});

test('an Optimize applied twice with one method is a single round with a fork', () => {
  const state = canvas();
  state.nodes.push({ type: 'prompt', nodeId: 'v2b', name: 'Classify v2b' });
  state.connections.push({ type: 'prompt-review-to-prompt', fromId: 'rev', toId: 'v2b' });
  const [family] = buildPromptFamilies(state);
  assert.deepEqual(family.rounds.map((round) => round.childIds), [['v2', 'v2b']]);
  const [, round, fork] = buildPromptFamilyRoute(family);
  assert.equal(round.kind, 'round');
  assert.deepEqual(fork.lanes.map((lane) => lane[0].version.promptId), ['v2', 'v2b']);
});

test('a branched tree uses Pipeline flow cards and connectors without duplicating versions', () => {
  const state = canvas();
  state.nodes.push({ type: 'prompt', nodeId: 'v2b', name: 'Alternative' }, { type: 'prompt', nodeId: 'v4', name: 'Long branch' });
  state.connections.push({ type: 'prompt-to-prompt', fromId: 'v1', toId: 'v2b' }, { type: 'prompt-to-prompt', fromId: 'v3', toId: 'v4' });
  const html = renderPromptFamily(buildPromptFamilies(state)[0], 3);
  assert.equal((html.match(/data-focus-key="prompt:/g) || []).length, 5);
  assert.equal((html.match(/data-focus-key="round:/g) || []).length, 1);
  assert.equal((html.match(/data-action="compare"/g) || []).length, 4);
  assert.equal((html.match(/class="pipeline-flow-connector"/g) || []).length, 5);
  assert.match(html, /class="pipeline-flow-step prompt-flow__step"/);
  assert.match(html, /marker id="prompt-flow-arrow-3"/);
});

test('steps name their kind and the canvas nodes they locate, and escape user content', () => {
  const state = canvas();
  state.nodes[0].name = '<img src=x onerror="alert(1)">';
  const html = renderPromptFamily(buildPromptFamilies(state)[0]);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img|<table|Export Excel|Precision/);
  assert.match(html, />Prompt<\/span>/);
  assert.match(html, />Prompt · Optimized<\/span>/);
  assert.match(html, />Prompt · Manual edit<\/span>/);
  assert.match(html, />Evaluate &amp; Optimize<\/span><span class="pipeline-step-name">GEPA</);
  assert.match(html, /data-canvas-node-ids="%5B%22r1%22%2C%22s1%22%2C%22rev%22%5D"/);
  assert.match(html, /data-canvas-node-ids="%5B%22v2%22%5D"/);
  assert.match(html, /title="Method: GEPA&#10;Generate: Generate&#10;Evaluate: Evaluate&#10;Optimize: Improve extraction"/);
  assert.match(html, /data-action="compare" data-from-id="v1" data-to-id="v2"/);
});

test('an empty canvas contains no families and a singleton requires no connectors', () => {
  assert.deepEqual(buildPromptFamilies({}), []);
  const [family] = buildPromptFamilies({ nodes: [{ type: 'prompt', nodeId: 'only' }] });
  const html = renderPromptFamily(family);
  assert.doesNotMatch(html, /data-action="compare"|<path class="pipeline-flow-connector"/);
});
