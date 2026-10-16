import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptFamilies } from '../src/promptOptimization.js';
import { renderPromptFamily } from '../src/promptVersionTree.js';

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

test('a branched tree uses Pipeline cards and nested branch groups without duplicating versions', () => {
  const state = canvas();
  state.nodes.push({ type: 'prompt', nodeId: 'v2b', name: 'Alternative' }, { type: 'prompt', nodeId: 'v4', name: 'Long branch' });
  state.connections.push({ type: 'prompt-to-prompt', fromId: 'v1', toId: 'v2b' }, { type: 'prompt-to-prompt', fromId: 'v3', toId: 'v4' });
  const html = renderPromptFamily(buildPromptFamilies(state)[0]);
  assert.equal((html.match(/data-action="locate"/g) || []).length, 5);
  assert.equal((html.match(/data-action="compare"/g) || []).length, 4);
  assert.match(html, /pipeline-overview-step prompt-version__node/);
  assert.match(html, /pipeline-overview-branch prompt-version__fork/);
  assert.doesNotMatch(html, /pipeline-step-kind|>Prompt<\/span>/);
  assert.doesNotMatch(html, /<svg|position:absolute|marker-end/);
});

test('family rendering exposes node and comparison actions and safely escapes user content', () => {
  const state = canvas();
  state.nodes[0].name = '<img src=x onerror="alert(1)">';
  const html = renderPromptFamily(buildPromptFamilies(state)[0]);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img|<table|Export Excel|Ground truth|Precision/);
  assert.match(html, /data-action="locate" data-prompt-id="v2"/);
  assert.match(html, /title="Locate [^"]+ on canvas" aria-label="Locate [^"]+ on canvas"/);
  assert.match(html, /data-action="compare" data-from-id="v1" data-to-id="v2"/);
  assert.match(html, /Optimize · GEPA/);
  assert.match(html, /<button type="button"/);
  assert.match(html, /class="pipeline-overview-arrow"/);
});

test('an empty canvas contains no families and a singleton requires no connectors', () => {
  assert.deepEqual(buildPromptFamilies({}), []);
  const [family] = buildPromptFamilies({ nodes: [{ type: 'prompt', nodeId: 'only' }] });
  assert.doesNotMatch(renderPromptFamily(family), /data-action="compare"/);
});
