import test from 'node:test';
import assert from 'node:assert/strict';
import { planChangeSet } from '../src/agent/operations/changeSet.js';
import { previewProposal } from '../src/agent/operations/proposals.js';
import { executeRunRequest, previewRunRequest } from '../src/agent/execution/runJobs.js';
import { inspectWorkflowNode } from '../src/agent/canvas/workflowNodeInspector.js';
import { buildWorkspaceSummary } from '../src/agent/context/workspaceSummary.js';
import { extractInputFields } from '../src/promptText.js';

const table = (headers, rows) => ({ headers, rows, columnTypes: headers.map(() => 'text') });
const credentials = [
  { id: 'fast', provider: 'openrouter', model: 'fast-model', last_check_ok: true },
  { id: 'strong', provider: 'openrouter', model: 'strong-model', last_check_ok: true },
  { id: 'broken', provider: 'openrouter', model: 'broken-model', last_check_ok: false },
];
const credentialsById = new Map(credentials.map((c) => [c.id, c]));
const models = new Map(credentials.filter((c) => c.last_check_ok).map((c) => [c.id, c]));

function canvas() {
  return { historyVersion: 1, nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: table(['text'], [['a'], ['b']]) },
    { type: 'dataset', nodeId: 'gt', name: 'GT', datasetContent: table(['a'], [['A'], ['B']]) },
    { type: 'prompt', nodeId: 'p', name: 'Prompt', text: 'Read {text}', outputFormat: { returnShape: 'single', fields: [{ key: 'a', type: 'str' }] } },
    { type: 'run', nodeId: 'r', runName: 'Run', runInputToColumn: '{"text":"text"}' },
    { type: 'score', nodeId: 's', scoreName: 'Evaluate', historyRecordId: 'evaluation-1', scoreGroundTruthId: 'gt' },
  ], connections: [{ type: 'data', fromId: 'raw', fromPort: 'result', toId: 'r' }, { type: 'prompt-to-run', fromId: 'p', toId: 'r' },
    { type: 'run-to-score', fromId: 'r', toId: 's' }] };
}
const plan = (state, operations, extra = {}) => planChangeSet(state, operations, { extractInputFields, models, ...extra });
const find = (result, ref) => result.state.nodes.find((node) => node.nodeId === (result.refs[ref] || ref));

test('add_run takes a tested model as the Create Generate picker does, else leaves the Settings default', () => {
  const picked = plan(canvas(), [{ op: 'add_run', ref: '$g', prompt: 'p', input: 'raw', input_mapping: { text: 'text' }, model: 'strong' }]);
  assert.equal(find(picked, '$g').runCredentialId, 'strong');
  assert.match(picked.items[0].lines.join('\n'), /Model: openrouter \/ strong-model/);
  const fallback = plan(canvas(), [{ op: 'add_run', ref: '$g', prompt: 'p', input: 'raw', input_mapping: { text: 'text' } }]);
  assert.equal(find(fallback, '$g').runCredentialId, undefined);
  assert.match(fallback.items[0].lines.join('\n'), /default Generate model/);
  assert.throws(() => plan(canvas(), [{ op: 'add_run', prompt: 'p', model: 'broken' }]), /tested model.*fast, strong/);
  assert.throws(() => plan(canvas(), [{ op: 'add_run', prompt: 'p', model: 'fast' }], { models: new Map() }), /no tested models/);
  assert.throws(() => plan(canvas(), [{ op: 'add_run', prompt: 'p', credential_id: 'fast' }]), /as model/);
  assert.throws(() => plan(canvas(), [{ op: 'add_run', prompt: 'p', settings: { max_tokens: 5 } }]), /settings cannot be set/);
});

test('update changes a Generate model only before its first run', () => {
  const changed = plan(canvas(), [{ op: 'update', node: 'r', set: { model: 'fast' } }]);
  assert.equal(find(changed, 'r').runCredentialId, 'fast');
  for (const ran of [{ runResults: JSON.stringify([{ row_index: 0, input_row_index: 0, output: { a: 'A' } }]) },
    { runResumable: true }, { historyRecordId: 'run-1' }, { historyStaleRecordId: 'run-1' }]) {
    const state = canvas();
    Object.assign(state.nodes.find((node) => node.nodeId === 'r'), ran);
    assert.throws(() => plan(state, [{ op: 'update', node: 'r', set: { model: 'fast' } }]), /model is fixed/);
  }
  assert.throws(() => plan(canvas(), [{ op: 'update', node: 's', set: { model: 'fast' } }]), /cannot set model/);
});

test('save_score_results saves the table Save to workspace saves, recording the Evaluate and its History record', () => {
  const scoreTables = new Map([['s', { headers: ['model output row', 'Status'], rows: [['1', 'Matched'], ['2', 'No match']], recordId: 'evaluation-1', stale: false }]]);
  const saved = plan(canvas(), [{ op: 'save_score_results', ref: '$d', score: 's' }], { scoreTables });
  const dataset = find(saved, '$d');
  assert.equal(dataset.name, 'Evaluate comparison');
  assert.match(dataset.note, /Exported from Evaluate "Evaluate"/);
  assert.deepEqual(dataset.savedFrom, { kind: 'score', nodeId: 's', port: 'result', recordId: 'evaluation-1' });
  assert.deepEqual(dataset.datasetContent.rows, [['1', 'Matched'], ['2', 'No match']]);
  scoreTables.get('s').stale = true;
  assert.match(plan(canvas(), [{ op: 'save_score_results', score: 's' }], { scoreTables }).items[0].lines.join('\n'), /Needs update/);
  assert.throws(() => plan(canvas(), [{ op: 'save_score_results', score: 's' }]), /no saved result/);
  const matching = canvas();
  matching.nodes.find((node) => node.nodeId === 's').scoreMatchPending = true;
  assert.throws(() => plan(matching, [{ op: 'save_score_results', score: 's' }], { scoreTables }), /is matching/);
});

test('a proposal is planned with the tested models and the Evaluate table from the canvas', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  try {
    const state = canvas();
    const asked = [];
    const workspace = { getCanvasState: () => state, extractInputFields, credentialsById,
      getScoreSaveTable: async (id) => { asked.push(id); return { headers: ['Status'], rows: [['Matched']], recordId: 'evaluation-1' }; } };
    const preview = await previewProposal({ operations: [
      { op: 'add_run', ref: '$g', prompt: 'p', input: 'raw', input_mapping: { text: 'text' }, model: 'fast' },
      { op: 'save_score_results', ref: '$d', score: 's' },
    ] }, workspace);
    assert.equal(preview.ok, true, preview.error);
    assert.deepEqual(asked, ['s']);
    const untested = await previewProposal({ operations: [{ op: 'add_run', prompt: 'p', model: 'broken' }] }, workspace);
    assert.equal(untested.ok, false);
  } finally {
    globalThis.fetch = previous;
  }
});

test('a review job takes a tested model like the picker beside Optimize prompt; resume keeps its own', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).endsWith('/api/settings')
    ? { default_review_credential_id: 'fast' } : { models: [] }) });
  try {
    const state = canvas();
    let created = null;
    const env = { getCanvasState: () => state, extractInputFields, credentialsById,
      getScoreComparisonRows: async () => [{ input_row_index: 0, matched: false }],
      inspectNode: async (id, options) => inspectWorkflowNode(state, id, { extractInputFields, ...options }),
      createAndRunReviewNode: async (args) => { created = args; return { reviewNodeId: 'missing' }; } };
    const preview = await previewRunRequest({ jobs: [{ kind: 'review', score: 's', model: 'strong' }] }, env);
    assert.equal(preview.ok, true, preview.error);
    assert.match(preview.items[0].lines.join('\n'), /Model: openrouter \/ strong-model/);
    await executeRunRequest({ jobs: [{ kind: 'review', score: 's', model: 'strong' }] }, env);
    assert.equal(created.reviewCredentialId, 'strong');
    await executeRunRequest({ jobs: [{ kind: 'review', score: 's' }] }, env);
    assert.equal(created.reviewCredentialId, '');
    const untested = await previewRunRequest({ jobs: [{ kind: 'review', score: 's', model: 'broken' }] }, env);
    assert.match(untested.error, /not a tested model/);
    state.nodes.push({ type: 'promptReview', nodeId: 'rev', reviewInterrupted: true, evaluateRecordId: 'evaluation-1',
      reviewResult: JSON.stringify({ streamComplete: false, suggestions: [] }) });
    state.connections.push({ type: 'score-to-prompt-review', fromId: 's', toId: 'rev' });
    const resumed = await previewRunRequest({ jobs: [{ kind: 'resume_review', review: 'rev', model: 'strong' }] }, env);
    assert.match(resumed.error, /keeps the model it started with/);
  } finally {
    globalThis.fetch = previous;
  }
});

test('the workspace summary lists the models the pickers offer, marking the defaults', async () => {
  const options = { extractInputFields, credentialsById, defaultRunCredential: credentials[0], defaultReviewCredential: credentials[1] };
  const summary = await buildWorkspaceSummary(canvas(), options);
  assert.match(summary, /Models \(tested in Settings → Credentials; pass the id in brackets as model\):\n- openrouter \/ fast-model \[fast\] \(default Generate\)\n- openrouter \/ strong-model \[strong\] \(default Optimize\)$/);
  assert.doesNotMatch(summary, /broken/);
  assert.match(await buildWorkspaceSummary({ nodes: [], connections: [] }, options), /^The canvas is empty\.\n\nModels/);
  assert.match(await buildWorkspaceSummary(canvas(), { extractInputFields, credentialsById: new Map() }), /Models: none tested/);
  assert.doesNotMatch(await buildWorkspaceSummary(canvas(), { extractInputFields }), /Models/);
});
