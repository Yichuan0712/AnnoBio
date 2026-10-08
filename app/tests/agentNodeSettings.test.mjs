import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectWorkflowNode } from '../src/agent/canvas/workflowNodeInspector.js';
import { buildWorkspaceSummary } from '../src/agent/context/workspaceSummary.js';
import { ChangeSetError, planChangeSet } from '../src/agent/operations/changeSet.js';
import { upgradeCanvasState } from '../src/canvasFormat.js';
import { DATA_EDGE, RESULT_PORT, processInputAliases, validateStepInputs } from '../src/stepInputs.js';

const extractInputFields = (sections) => [...new Set(sections
  .flatMap((section) => [...String(section.content || '').matchAll(/\{([^{}]+)\}/g)].map((match) => match[1])))];

const canvas = () => upgradeCanvasState({
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

test('a Run and a Process the Agent adds read their inputs through data connections', () => {
  const result = plan([addRun(), { op: 'add_process', ref: '$proc', primary_input: 'raw', code: 'def process(df, df_gt):\n    return df\n' }]);
  const { $run: run, $proc: proc } = result.refs;
  assert.deepEqual(result.state.connections.filter((edge) => edge.toId === run && edge.type === DATA_EDGE),
    [{ type: DATA_EDGE, fromId: 'raw', fromPort: RESULT_PORT, toId: run }]);
  assert.deepEqual(processInputAliases(result.state, proc), { raw: 'df', gt: 'df_gt' });
  assert.deepEqual(validateStepInputs(result.state), []);
  for (const node of result.state.nodes.filter((item) => [run, proc].includes(item.nodeId))) {
    assert.deepEqual(['runWorkingSetId', 'primaryDatasetId', 'datasetAliases'].filter((field) => field in node), []);
  }
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

test('the summary lists pipelines as the Current Pipeline panel shows them', async () => {
  const node = (type, nodeId, extra = {}) => ({ type, nodeId, name: nodeId, ...extra });
  const edge = (fromId, toId, type) => ({ fromId, toId, type });
  const state = {
    nodes: [node('dataset', 'raw', { datasetContent: { headers: ['text'], rows: [['a']] } }),
      node('prompt', 'p'), node('prompt', 'p2'), node('process', 'clean'), node('process', 'trim'),
      node('run', 'r1', { runName: 'Run A', runWorkingSetId: 'raw' }), node('run', 'r2', { runName: 'Run B', runWorkingSetId: 'raw' })],
    connections: [edge('p', 'p2', 'prompt-to-prompt'), edge('p', 'r1', 'prompt-to-run'), edge('p2', 'r2', 'prompt-to-run'),
      edge('raw', 'clean', 'dataset-to-process'), edge('raw', 'trim', 'dataset-to-process')],
  };
  const summary = await buildWorkspaceSummary(upgradeCanvasState(state), { extractInputFields });
  const pipelines = summary.split('\n\n')[0];
  assert.doesNotMatch(pipelines, /Dataset/);
  assert.match(pipelines, /Pipeline 1 \[pipeline-1\] \(default route; Current Pipeline panel is not mounted\):\n {2}1\. Run prompt, a picker with 2 choices: "p2" \[p2\] by run "Run B" \[r2\] on "raw" \(default\); "p" \[p\] by run "Run A"/);
  assert.match(pipelines, /Pipeline 2 \[pipeline-2\].*:\n {2}1\. Process data, a picker with 2 choices: "clean" \[clean\] reading "raw" \(default\); "trim"/);
  assert.match(summary, /"p2" \[p2\]: .*; new version of "p"/);
});

test('the summary uses the panel selection and identifies Pipeline result provenance', async () => {
  const state = canvas();
  state.nodes.push({ type: 'dataset', nodeId: 'copy', name: 'Pipeline output',
    pipelineRunId: 'run-123', pipelineLogicalId: 'dataset:copy',
    datasetContent: { headers: ['answer'], rows: [['A']] } });
  const selectedRoute = [{ kind: 'prompt', selectedValue: 'r', selectedOption: {
    kind: 'prompt', promptNodeId: 'p', promptName: 'Extract', runNodeId: 'r', runName: 'Run', inputDatasetNodeId: 'raw',
  }, options: [{ value: 'r', kind: 'prompt', promptNodeId: 'p', promptName: 'Extract', runNodeId: 'r', runName: 'Run', inputDatasetNodeId: 'raw' }] }];
  const summary = await buildWorkspaceSummary(state, { extractInputFields,
    pipelineSelections: [{ id: 'pipeline-1', source: 'panel', route: selectedRoute }] });
  assert.match(summary, /Pipeline 1 \[pipeline-1\] \(current panel selection\)/);
  assert.match(summary, /saved from Pipeline run run-123/);
  assert.deepEqual(inspectWorkflowNode(state, 'copy').details.producedBy, {
    kind: 'pipeline run result', pipelineRunId: 'run-123', logicalId: 'dataset:copy',
  });
});

test('the summary names a version made by applying a Review', async () => {
  const state = canvas();
  state.nodes.push({ type: 'promptReview', nodeId: 'rev', promptReviewName: 'Review 1' },
    { type: 'prompt', nodeId: 'p2', name: 'Extract v2', sections: [], outputFormat: { fields: [] } });
  state.connections.push({ fromId: 's', toId: 'rev', type: 'score-to-prompt-review' },
    { fromId: 'rev', toId: 'p2', type: 'prompt-review-to-prompt' });
  const summary = await buildWorkspaceSummary(state, { extractInputFields });
  assert.match(summary, /"Extract v2" \[p2\]: .*; made by applying Review "Review 1" of "Extract"/);
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

test('Process code declares its inputs as parameters, each by the alias it already has', () => {
  const state = canvas();
  state.nodes.push(
    { type: 'dataset', nodeId: 'copy', name: 'GT (Copy 1)', datasetContent: { headers: ['answer'], rows: [['A']] } },
    { type: 'process', nodeId: 'merge', name: 'Merge', dfCode: 'def process(df, df_gt):\n    return df\n' },
  );
  // GT's own alias would be df_gt, but the copy already reads under it.
  state.connections.push({ type: DATA_EDGE, fromId: 'raw', fromPort: RESULT_PORT, toId: 'merge', alias: 'df' },
    { type: DATA_EDGE, fromId: 'copy', fromPort: RESULT_PORT, toId: 'merge', alias: 'df_gt' });
  const inputsAfter = (code) => {
    const result = planChangeSet(state, [{ op: 'update', node: 'merge', set: { code } }], { extractInputFields });
    return [processInputAliases(result.state, 'merge'), result.state.connections.filter((edge) => edge.toId === 'merge').map((edge) => edge.fromId).sort()];
  };
  assert.deepEqual(inputsAfter('def process(df, df_gt):\n    return df.join(df_gt)\n'), [{ raw: 'df', copy: 'df_gt' }, ['copy', 'raw']]);
  // Code written before parameters names the alias in its body only.
  assert.deepEqual(inputsAfter('def process(df):\n    return df.join(df_gt)\n'), [{ raw: 'df', copy: 'df_gt' }, ['copy', 'raw']]);
  assert.deepEqual(inputsAfter('def process(df):\n    return df\n'), [{ raw: 'df' }, ['raw']]);
});
