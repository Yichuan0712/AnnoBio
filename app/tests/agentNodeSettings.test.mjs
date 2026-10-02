import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectWorkflowNode } from '../src/agent/canvas/workflowNodeInspector.js';
import { buildWorkspaceSummary } from '../src/agent/context/workspaceSummary.js';
import { ChangeSetError, planChangeSet } from '../src/agent/operations/changeSet.js';

const extractInputFields = (sections) => [...new Set(sections
  .flatMap((section) => [...String(section.content || '').matchAll(/\{([^{}]+)\}/g)].map((match) => match[1])))];

const canvas = () => ({
  nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: { headers: ['text'], columnTypes: ['text'], rows: [['a']] } },
    { type: 'dataset', nodeId: 'gt', name: 'GT', datasetContent: { headers: ['answer'], columnTypes: ['text'], rows: [['A']] } },
    { type: 'prompt', nodeId: 'p', name: 'Extract', sections: [{ name: 'Task', content: 'Read {text}' }],
      outputFormat: { returnShape: 'single', fields: [{ key: 'answer', type: 'str' }] } },
    { type: 'run', nodeId: 'r', runName: 'Run', runWorkingSetId: 'raw', runInputToColumn: JSON.stringify({ text: 'text' }) },
    { type: 'score', nodeId: 's', scoreName: 'Score', scoreGroundTruthId: 'gt' },
  ],
  connections: [{ fromId: 'p', toId: 'r', type: 'prompt-to-run' }, { fromId: 'r', toId: 's', type: 'run-to-score' }],
});
const plan = (operations) => planChangeSet(canvas(), operations, { extractInputFields });
const addRun = (extra = {}) => ({ op: 'add_run', ref: '$run', prompt: 'p', input_dataset: 'raw', input_mapping: { text: 'text' }, ...extra });

// Users have no per-Run model or settings and no per-Score review method (Settings holds them),
// so neither does the Agent.
test('a new Run uses Settings → Run defaults', () => {
  const result = plan([addRun()]);
  const run = result.state.nodes.find((node) => node.nodeId === result.refs.$run);
  assert.equal(run.runCredentialId, undefined);
  assert.equal(run.runSettings, undefined);
  assert.ok(result.items[0].lines.includes('Model and settings: Settings → Run defaults'));
});

test('the Agent cannot choose a Run model or settings', () => {
  assert.throws(() => plan([addRun({ credential_id: 'cred-a' })]), ChangeSetError);
  assert.throws(() => plan([addRun({ settings: { run_concurrency: 2 } })]), ChangeSetError);
  assert.throws(() => plan([{ op: 'update', node: 'r', set: { credential_id: 'cred-a' } }]), /cannot set credential_id/);
  assert.throws(() => plan([{ op: 'update', node: 'r', set: { settings: { run_concurrency: 2 } } }]), /cannot set settings/);
});

test('the Agent cannot choose a review method on a Score', () => {
  assert.throws(() => plan([{ op: 'update', node: 's', set: { review_method: 'gepa' } }]), /cannot set review_method/);
  assert.throws(() => plan([{ op: 'add_score', run: 'r', ground_truth: 'gt', comparison: [{ field: 'answer', ground_truth_columns: ['answer'] }], review_method: 'gepa' }]), ChangeSetError);
});

test('inspect_node does not report per-Run settings', () => {
  const inspected = inspectWorkflowNode(canvas(), 'r', { extractInputFields });
  assert.equal('settings' in inspected.details, false);
});

test('Agent identifies legacy saved Dataset snapshots as snapshots', async () => {
  const state = canvas();
  state.nodes.push({ type: 'dataset', nodeId: 'snapshot', name: 'Saved results',
    datasetContent: { headers: ['answer'], rows: [['A']] } });
  state.connections.push({ fromId: 'r', toId: 'snapshot', type: 'run-to-dataset-snapshot' });
  const inspected = inspectWorkflowNode(state, 'snapshot');
  assert.equal(inspected.details.producedBy.kind, 'saved run snapshot');
  assert.equal(inspected.details.producedBy.nodeId, 'r');
  const summary = await buildWorkspaceSummary(state, { extractInputFields });
  assert.match(summary, /saved snapshot of run "Run"/);
});
