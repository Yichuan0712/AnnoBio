import test from 'node:test';
import assert from 'node:assert/strict';
import { processTrialInputs } from '../src/agent/canvas/processTrialInputs.js';
import { inspectWorkflowNode, readNodeRows } from '../src/agent/canvas/workflowNodeInspector.js';
import { planChangeSet } from '../src/agent/operations/changeSet.js';
import { previewProposal, applyProposal } from '../src/agent/operations/proposals.js';
import { previewRunRequest, executeRunRequest } from '../src/agent/execution/runJobs.js';
import { executeAgentTool, AGENT_TOOL_DEFINITIONS } from '../src/agent/tools/agentTools.js';
import { extractInputFields } from '../src/promptText.js';
import { parseScoreMappingBundle } from '../src/scoreMappingBundle.js';
import { flattenScoreRules } from '../src/scoreRunGtPairing.js';
import { hasNodeExecution, registerNodeJob, registerNodeStop, stopNodeExecution } from '../src/nodeExecutionControl.js';
import { suggestionOptimizationInputs, optimizeReviewSuggestion, optimizedReviewSuggestion } from '../src/reviewSuggestionOptimizer.js';
import { createWorkflowCanvasRuntime } from '../src/workflowCanvasRuntime.js';
import { getCurrentProjectId, setCurrentProjectId } from '../src/currentProject.js';

const table = (headers, rows) => ({ headers, rows, columnTypes: headers.map(() => 'text') });
const dataset = (nodeId, name, text) => ({ type: 'dataset', nodeId, name, datasetContent: table(['text'], [[text]]) });
const data = (fromId, toId, alias) => ({ type: 'data', fromId, fromPort: 'result', toId, ...(alias ? { alias } : {}) });
const rule = (key) => ({ type: 'rule', outputKey: key, gtColumns: [key], matchType: 'exact', matchFlags: {} });
const group = (children, ops = []) => ({ type: 'group', children, ops });
const tree = () => ({ v: 2, input: group([]), output: group([rule('a'), group([rule('b'), rule('c')], ['OR'])], ['AND']) });
const comparison = (input, matched = false) => ({ row_index: input, input_row_index: input, matched,
  run_output: { a: 'bad' }, row_input: { text: `text-${input}` }, ground_truth_output: { a: 'good' }, source_gt_row_index: input });
const suggestion = () => ({ suggestion_id: 1, old_sentence: 'Read', new_sentence: 'Read carefully', reason: 'Missing evidence', row_indices: [0] });
const reviewResult = (extra = {}) => ({ promptText: 'Read {text}', streamComplete: true, suggestions: [suggestion()],
  comparison_rows: [comparison(0), comparison(1, true), comparison(2, true), comparison(3)],
  verify_states: { 1: 'optimization' }, verify_results: { 1: { status: 'complete', matchedCount: 0, total: 1, verifyRows: [{ matched: false }] } }, ...extra });
function canvas(result = reviewResult()) {
  return { historyVersion: 1, nodes: [
    { ...dataset('raw', 'Raw', 'input'), datasetContent: table(['text'], [['a'], ['b'], ['c'], ['d']]) },
    { type: 'dataset', nodeId: 'gt', name: 'GT', datasetContent: table(['a', 'b', 'c'], [['a', 'b', 'c'], ['A', 'B', 'C']]) },
    { type: 'prompt', nodeId: 'p', name: 'Prompt', text: 'Read {text}', outputFormat: { returnShape: 'single', fields: ['a', 'b', 'c'].map((key) => ({ key, type: 'str' })) } },
    { type: 'run', nodeId: 'r', runName: 'Run', runResults: JSON.stringify([{ row_index: 0, input_row_index: 0, output: { a: 'bad' } }]), runInputToColumn: '{"text":"text"}' },
    { type: 'score', nodeId: 's', scoreName: 'Evaluate', historyRecordId: 'evaluation-1', scoreGroundTruthId: 'gt', scoreMapping: tree(), reviewResult: JSON.stringify({ comparison_rows: [comparison(0)] }) },
    { type: 'promptReview', nodeId: 'rev', promptReviewName: 'Optimize', evaluateRecordId: 'evaluation-1', evaluateNodeId: 's', reviewResult: JSON.stringify(result) },
  ], connections: [data('raw', 'r'), { type: 'prompt-to-run', fromId: 'p', toId: 'r' },
    { type: 'run-to-score', fromId: 'r', toId: 's' }, { type: 'score-to-prompt-review', fromId: 's', toId: 'rev' }] };
}
const plan = (state, set) => planChangeSet(state, [{ op: 'update', node: 's', set }], { extractInputFields });
const find = (state, id) => state.nodes.find((node) => node.nodeId === id);
const response = (value) => ({ ok: true, status: 200, json: async () => value });
async function withSettings(action) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => response(String(url).endsWith('/api/settings')
    ? { default_run_credential_id: 'cred', default_review_credential_id: 'cred', python_path: 'python', optimization_max_trials: 4 }
    : { models: [] });
  try { return await action(); } finally { globalThis.fetch = previous; }
}
const envFor = (state, extra = {}) => ({ getCanvasState: () => state, extractInputFields,
  credentialsById: new Map([['cred', { provider: 'mock', model: 'model' }]]),
  getScoreComparisonRows: async () => [comparison(0)],
  inspectNode: async (id, options) => inspectWorkflowNode(state, id, { extractInputFields, ...options }), ...extra });

test('trying an existing Process preserves its source after rename despite a decoy with the old name', () => {
  const code = 'def process(df, df_old_name):\n    return df_old_name';
  const state = { nodes: [dataset('raw', 'Raw', 'primary'), dataset('decoy', 'Old name', 'WRONG'), dataset('actual', 'Renamed data', 'RIGHT'),
    { type: 'process', nodeId: 'proc', name: 'Existing', dfCode: code }], connections: [data('raw', 'proc', 'df'), data('actual', 'proc', 'df_old_name')] };
  const before = structuredClone(state);
  const inputs = processTrialInputs(state, code, undefined, undefined, 'proc');
  assert.equal(inputs.find((input) => input.alias === 'df_old_name').nodeId, 'actual');
  assert.equal(inputs.find((input) => input.alias === 'df_old_name').content.rows[0][0], 'RIGHT');
  assert.deepEqual(state, before);
  assert.throws(() => processTrialInputs(state, code, 'decoy', '', 'proc'), /connected inputs/);
  assert.throws(() => processTrialInputs(state, code, undefined, undefined, 'missing'), /existing Process/);
  state.nodes.splice(1, 1);
  assert.equal(processTrialInputs(state, code, undefined, undefined, 'proc')[1].nodeId, 'actual');
});

test('an interrupted or removed Optimize cannot report completed or start the next job', async () => withSettings(async () => {
  for (const removed of [false, true]) {
    const state = canvas(reviewResult({ streamComplete: false }));
    find(state, 'rev').reviewInterrupted = true;
    let starts = 0;
    const env = envFor(state, { createAndRunReviewNode: async () => {
      starts++;
      if (removed) state.nodes = state.nodes.filter((node) => node.nodeId !== 'rev');
      return { reviewNodeId: 'rev' };
    } });
    const result = await executeRunRequest({ jobs: [{ kind: 'review', score: 's' }, { kind: 'review', score: 's' }] }, env);
    assert.equal(result.status, 'failed');
    assert.equal(starts, 1);
    assert.match(result.results.join('\n'), /did not complete/);
    assert.match(result.results.join('\n'), /Not started: 1/);
  }
}));

test('successful Optimize with zero suggestions is complete; resume uses the existing node', async () => withSettings(async () => {
  const state = canvas(reviewResult({ streamComplete: false, suggestions: [] }));
  find(state, 'rev').reviewInterrupted = true;
  let resumed = '';
  const env = envFor(state, { resumeReviewNode: async (id) => {
    resumed = id;
    delete find(state, id).reviewInterrupted;
    find(state, id).reviewResult = JSON.stringify({ streamComplete: true, suggestions: [] });
    return { reviewNodeId: id };
  }, createAndRunReviewNode: () => { throw new Error('must not create a replacement'); } });
  const result = await executeRunRequest({ jobs: [{ kind: 'resume_review', review: 'rev' }] }, env);
  assert.equal(result.status, 'completed');
  assert.equal(resumed, 'rev');
  assert.equal((await previewRunRequest({ jobs: [{ kind: 'resume_review', review: 'rev' }] }, env)).ok, false);
}));

test('nested Evaluate rules remain distinguishable and survive an inspected edit and project round trip', () => {
  const state = canvas();
  const before = structuredClone(state);
  const original = inspectWorkflowNode(state, 's').details.rules.ruleTree;
  const alternate = { ...tree(), output: group([group([rule('a'), rule('b')], ['OR']), rule('c')], ['AND']) };
  const edited = plan(state, { rule_tree: alternate }).state;
  assert.notDeepEqual(inspectWorkflowNode(edited, 's').details.rules.ruleTree, original);
  const stored = JSON.parse(JSON.stringify(edited));
  const restored = inspectWorkflowNode(stored, 's').details.rules.ruleTree;
  assert.equal(restored.output.children[0].type, 'group');
  assert.deepEqual(restored.output.children[0].ops, ['OR']);
  assert.deepEqual(restored.output.ops, ['AND']);
  assert.deepEqual(state, before);
  assert.throws(() => plan(state, { comparison: [{ field: 'a', ground_truth_columns: ['a'] }] }), /nested groups/);
  assert.throws(() => plan(state, { rule_tree: { ...alternate, output: group([rule('a'), rule('b')], ['XOR']) } }), /AND\/OR/);
  assert.throws(() => plan(state, { rule_tree: { ...alternate, output: group([rule('unknown')]) } }), /Unknown output/);
  assert.throws(() => plan(state, { rule_tree: alternate, comparison: [] }), /without flat rules/);
});

test('full rule tree creation keeps numeric options and rejects invalid tolerances', () => {
  const state = canvas();
  const value = tree();
  value.output.children[0].matchFlags = { numericMode: 'abs', numericAbsEpsilon: 0.05 };
  const created = planChangeSet(state, [{ op: 'add_score', ref: '$score', run: 'r', ground_truth: 'gt', rule_tree: value }], { extractInputFields });
  assert.equal(find(created.state, created.refs.$score).scoreMapping.output.children[0].matchFlags.numericAbsEpsilon, 0.05);
  assert.ok(created.items[0].diffs.length);
  value.output.children[0].matchFlags.numericAbsEpsilon = -1;
  assert.throws(() => plan(state, { rule_tree: value }), /non-negative/);
  const inputOnly = { v: 2, input: group([{ ...rule('[text]'), gtColumns: ['a'] }]), output: group([]) };
  assert.equal(plan(state, { rule_tree: inputOnly }).state.nodes.find((node) => node.nodeId === 's').scoreMapping.input.children[0].outputKey, '[text]');
});

test('row inclusion updates current scoring but keeps existing Optimize evidence immutable', () => {
  const state = canvas();
  const originalReview = find(state, 'rev').reviewResult;
  const changed = plan(state, { exclude_row_keys: ['0', 'run:0'] }).state;
  assert.deepEqual(find(changed, 's').scoreRowExcludedFromScoring, { 0: true, 'run:0': true });
  assert.equal(JSON.parse(find(changed, 's').reviewResult).comparison_rows, undefined);
  assert.equal(find(changed, 'rev').reviewResult, originalReview);
  const included = plan(changed, { include_row_keys: ['0'] }).state;
  assert.deepEqual(find(included, 's').scoreRowExcludedFromScoring, { 'run:0': true });
  assert.throws(() => plan(state, { exclude_row_keys: ['100'] }), /existing GT/);
  assert.throws(() => plan(state, { exclude_row_keys: ['0'], include_row_keys: ['0'] }), /same row/);
  assert.throws(() => plan(state, { exclude_row_keys: ['0'], ground_truth: 'gt' }), /separately/);
  assert.equal(readNodeRows(state, 's').rows[0].rowKey, '0');
  const rows = readNodeRows(state, 's', { comparisonRows: [] });
  assert.deepEqual(rows.rows, []); // History is authoritative even when a legacy inline cache has rows.
  assert.equal(readNodeRows(state, 's', { comparisonRows: [comparison(2)] }).rows[0].inputRow, 3);
});

test('Optimize exposes paged diagnostic, stage, ground-truth and verification evidence', async () => {
  const entries = Array.from({ length: 15 }, (_, input_index) => ({ input_index, issue_summary: `issue-${input_index}` }));
  const state = canvas(reviewResult({ row_diagnostics: entries, data_refinement: [{ reason: 'GT suspect' }],
    stage_log: [{ stage_id: 'evolve' }], review_method_id: 'gepa', supports_segment_optimization: false,
    verify_results: { 1: { status: 'complete', matchedCount: 7, total: 15, verifyRows: entries } } }));
  const runtime = envFor(state);
  const result = await executeAgentTool('inspect_node', { node_id: 'rev', section: 'diagnostics', start_row: 6, max_rows: 3 }, runtime);
  assert.equal(result.ok, true);
  const inspected = JSON.parse(result.content).details;
  assert.deepEqual(inspected.rowDiagnostics.rows.map((row) => row.input_index), [5, 6, 7]);
  assert.equal(inspected.rowDiagnostics.totalRows, 15);
  assert.equal(inspected.method, 'gepa');
  assert.equal(inspected.supportsSuggestionOptimization, false);
  const details = inspectWorkflowNode(state, 'rev', { section: 'verification', suggestionId: '1', startRow: 11, maxRows: 2 }).details;
  assert.deepEqual(details.verification.verifyRows.rows.map((row) => row.input_index), [10, 11]);
  const overview = inspectWorkflowNode(state, 'rev').details;
  assert.equal(overview.dataRefinement.rows[0].reason, 'GT suspect');
  assert.equal(overview.stages.rows[0].stage_id, 'evolve');
});

test('node cancellation remembers a stop during startup and cannot cancel a later task', async () => {
  const cancelled = [];
  const control = registerNodeJob('cancellation-test', async (id) => cancelled.push(id));
  try {
    assert.equal(await stopNodeExecution('cancellation-test'), true);
    assert.deepEqual(cancelled, []);
    await control.started('job-1');
    assert.deepEqual(cancelled, ['job-1']);
    assert.equal(control.stopped, true);
    assert.throws(() => registerNodeJob('cancellation-test', () => {}), /active task/);
  } finally { control.release(); }
  const release = registerNodeStop('cancellation-test', () => cancelled.push('new'));
  control.release();
  assert.equal(hasNodeExecution('cancellation-test'), true);
  release();
  assert.equal(await stopNodeExecution('cancellation-test'), false);
});

test('stop jobs use the active UI task without requiring credentials or claiming it has stopped', async () => {
  const state = { nodes: [{ nodeId: 'ui-process', type: 'process', name: 'UI process' }], connections: [] };
  let cancelled = false;
  const release = registerNodeStop('ui-process', () => { cancelled = true; });
  const previous = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Stop must not depend on Settings/catalog'); };
  try {
    const env = envFor(state, { stopNodeTask: (id) => stopNodeExecution(id) });
    const result = await executeRunRequest({ jobs: [{ kind: 'stop', node: 'ui-process' }] }, env);
    assert.equal(result.status, 'completed');
    assert.equal(cancelled, true);
    assert.match(result.results[0], /cancellation requested/);
    assert.doesNotMatch(result.results[0], /has stopped/);
  } finally { release(); globalThis.fetch = previous; }
});

test('a confirmed stop refuses a replacement task and cancellation handles stay within their project', async () => {
  const project = getCurrentProjectId();
  setCurrentProjectId('alignment-project-a');
  const state = { nodes: [{ nodeId: 'stop-guard', type: 'process', name: 'Process' }], connections: [] };
  let cancelled = false;
  let release = registerNodeStop('stop-guard', () => {});
  const env = envFor(state, { getAssetProjectId: getCurrentProjectId, stopNodeTask: (id) => stopNodeExecution(id) });
  const request = { jobs: [{ kind: 'stop', node: 'stop-guard' }] };
  try {
    const approvedPreview = await previewRunRequest(request, env);
    release();
    release = registerNodeStop('stop-guard', () => { cancelled = true; });
    const result = await executeRunRequest(request, env, { approvedPreview });
    assert.equal(result.status, 'failed');
    assert.equal(cancelled, false);
    setCurrentProjectId('alignment-project-b');
    assert.equal(hasNodeExecution('stop-guard'), false);
    assert.equal(await stopNodeExecution('stop-guard'), false);
    assert.equal(cancelled, false);
  } finally { release(); setCurrentProjectId(project); }
});

test('suggestion optimization samples regression inputs, preserves the source and creates an unapplied candidate', async () => {
  const saved = reviewResult();
  const source = saved.suggestions[0];
  const before = structuredClone(source);
  const inputs = suggestionOptimizationInputs(source, saved.comparison_rows);
  assert.deepEqual(inputs.entries.map(([index]) => index), [0, 1, 2]);
  const result = await optimizeReviewSuggestion({ suggestion: source, suggestions: saved.suggestions,
    originalText: saved.promptText, comparisonRows: saved.comparison_rows,
    payload: { run_credential_id: 'cred', output_schema: {}, score_mapping: '{}' }, maxTrials: 4,
    runOptimization: async (options) => {
      assert.deepEqual(options.inputEntries.map(([index]) => index), [0, 1, 2]);
      assert.equal(options.sugIdx, 0);
      return { bestText: 'Read evidence carefully', bestObservedRate: 0.75, trialLog: [{ ok: true }] };
    } });
  const candidate = optimizedReviewSuggestion(source, result, saved);
  assert.deepEqual(source, before);
  assert.equal(candidate.applied, false);
  assert.equal(candidate.optimized_from_suggestion_id, 1);
  assert.equal(candidate.suggestion_id, 2);
  assert.equal(candidate.review_optimization_meta.optimizationExtraInputNums, '#2, #3');
  assert.throws(() => optimizedReviewSuggestion(source, { bestText: 'fallback', trialLog: [{ ok: false }] }, saved), /no successful/);
});

test('cancelled suggestion optimization returns no candidate and releases its cancellation handle', async () => {
  const saved = reviewResult();
  await assert.rejects(optimizeReviewSuggestion({ suggestion: saved.suggestions[0], suggestions: saved.suggestions,
    originalText: saved.promptText, comparisonRows: saved.comparison_rows, nodeId: 'opt-cancel',
    payload: { run_credential_id: 'cred', output_schema: {}, score_mapping: '{}' },
    runOptimization: async (options) => {
      await stopNodeExecution('opt-cancel');
      assert.equal(options.abortController.signal.aborted, true);
      return { bestText: 'late response', trialLog: [{ ok: true }] };
    } }), { name: 'AbortError' });
  assert.equal(hasNodeExecution('opt-cancel'), false);
  assert.equal(saved.suggestions.length, 1);
  const project = getCurrentProjectId();
  try {
    await assert.rejects(optimizeReviewSuggestion({ suggestion: saved.suggestions[0], suggestions: saved.suggestions,
      originalText: saved.promptText, comparisonRows: saved.comparison_rows,
      payload: { run_credential_id: 'cred', output_schema: {}, score_mapping: '{}' },
      runOptimization: async () => {
        setCurrentProjectId('different-alignment-project');
        return { bestText: 'late response', trialLog: [{ ok: true }] };
      } }), { name: 'AbortError' });
  } finally { setCurrentProjectId(project); }
});

test('suggestion optimization has a confirmed job and refuses methods without that capability', async () => withSettings(async () => {
  const state = canvas();
  const calls = [];
  const env = envFor(state, { optimizeSuggestion: async (args) => { calls.push(args); return { suggestionId: '2', trials: 4 }; } });
  const job = { kind: 'optimize_suggestion', review: 'rev', suggestion_id: '1' };
  const result = await executeRunRequest({ jobs: [job] }, env);
  assert.equal(result.status, 'completed');
  assert.equal(calls[0].maxTrials, 4);
  assert.match(result.results[0], /Verify the new suggestion/);
  find(state, 'rev').reviewResult = JSON.stringify(reviewResult({ supports_segment_optimization: false }));
  assert.equal((await previewRunRequest({ jobs: [job] }, env)).ok, false);
  const tools = AGENT_TOOL_DEFINITIONS.find((entry) => entry.function.name === 'run_nodes').function.parameters.properties.jobs.items.properties.kind.enum;
  for (const kind of ['stop', 'resume_review', 'optimize_suggestion']) assert.ok(tools.includes(kind));
}));

function runtimeHarness(result = reviewResult(), overrides = {}) {
  const state = canvas(result);
  const elements = new Map(state.nodes.map((node) => [node.nodeId, { dataset: { nodeId: node.nodeId,
    historyRecordId: node.historyRecordId, evaluateRecordId: node.evaluateRecordId, evaluateNodeId: node.evaluateNodeId,
    ...(node.type === 'prompt' ? { promptText: node.text, promptOutputFormat: JSON.stringify(node.outputFormat.fields) } : {}),
    ...(node.type === 'run' ? { runResults: node.runResults, runOutputFields: JSON.stringify([{ key: 'a' }]) } : {}),
    ...(node.type === 'score' ? { scoreGroundTruthId: 'gt', scoreMapping: JSON.stringify(node.scoreMapping) } : {}),
    ...(node.type === 'promptReview' ? { reviewResult: node.reviewResult, reviewInterrupted: '1' } : {}),
  }, style: {}, classList: { contains: (name) => name === `workflow-node--${node.type === 'promptReview' ? 'prompt-review' : node.type}` } }]));
  const pending = new Set();
  const requests = [];
  const runtime = createWorkflowCanvasRuntime({ getNodeById: (id) => elements.get(id), getConnections: () => state.connections,
    pendingReviews: new Map(), pendingReviewNodeIds: pending,
    resolveReviewCredentialId: async () => 'cred', resolveRunCredentialId: async () => 'cred',
    emitCanvasChanged: () => {}, setReviewNodeProgress: () => {}, deriveOutputFields: (_rows, fields) => fields,
    parseScoreMappingBundle, flattenScoreRules, readRunInputTable: () => find(state, 'raw').datasetContent,
    datasetContentByNodeId: new Map([['gt', find(state, 'gt').datasetContent]]),
    buildReviewComparisonRows: async () => [comparison(0)],
    runReviewStart: async (request) => { requests.push(request); pending.add(request.reviewNodeId); },
    ...overrides,
  });
  return { runtime, elements, requests, state };
}

test('Agent Apply rejects a different evaluation without mutations and permits the matching displayed stale evaluation', () => {
  const state = canvas();
  find(state, 's').historyRecordId = 'evaluation-2';
  find(state, 'rev').reviewSourceEarlier = false;
  const before = structuredClone(state);
  const operations = [{ op: 'apply_review', review: 'rev', suggestion_ids: ['1'] }];
  assert.throws(() => planChangeSet(state, operations, { extractInputFields }), /Historical.*different Evaluate History/);
  assert.deepEqual(state, before);
  delete find(state, 's').historyRecordId;
  find(state, 's').historyStaleRecordId = 'evaluation-1';
  find(state, 'rev').reviewSourceEarlier = true;
  const applied = planChangeSet(state, operations, { extractInputFields });
  assert.equal(applied.state.nodes.length, state.nodes.length + 1);
  assert.equal(applied.state.nodes.at(-1).text, 'Read carefully {text}');
});

test('canvas Apply reconciles History and blocks a version change before creating a Prompt', async () => {
  let elements;
  let reconciled = false;
  let created = 0;
  const harness = runtimeHarness(reviewResult(), {
    reconcileHistory: async () => {
      reconciled = true;
      elements.get('s').dataset.historyRecordId = 'evaluation-2';
    },
    createPromptNode: () => { created++; throw new Error('must not create'); },
  });
  elements = harness.elements;
  const before = elements.get('rev').dataset.reviewResult;
  await assert.rejects(harness.runtime.applyReviewSuggestions({ reviewNodeId: 'rev', text: 'New prompt' }), /Historical/);
  assert.equal(reconciled, true);
  assert.equal(created, 0);
  assert.equal(elements.get('rev').dataset.reviewResult, before);
});

test('canvas Apply uses the bound evaluation Prompt schema and rechecks its version after loading the snapshot', async () => {
  for (const changeVersion of [false, true]) {
    let elements, created;
    const snapshot = { name: 'Original', text: 'Read {text}', outputFormat: { returnShape: 'table', fields: [{ key: 'old-field', type: 'str' }] }, inputTypes: { text: 'pdf' } };
    const harness = runtimeHarness(reviewResult(), {
      getEvaluationPayload: async () => {
        if (changeVersion) elements.get('s').dataset.historyRecordId = 'evaluation-2';
        return { prompt_snapshot: snapshot };
      },
      getPromptDataFromNode: node => node.dataset.nodeId === 'p' ? { name: 'Changed', outputFormat: { fields: [{ key: 'wrong' }] } } : created,
      findUniquePromptName: name => name,
      isPromptNameAlreadyUsed: () => false,
      createPromptNode: options => {
        created = options;
        const node = { dataset: { nodeId: 'new-prompt' }, style: {} };
        elements.set('new-prompt', node);
        return node;
      },
      NEW_NODE_OFFSET: 20, updateContentSize: () => {}, updateEdges: () => {},
    });
    elements = harness.elements;
    const applying = harness.runtime.applyReviewSuggestions({ reviewNodeId: 'rev', text: 'Read carefully {text}' });
    if (changeVersion) {
      await assert.rejects(applying, /different Evaluate History/);
      assert.equal(created, undefined);
    } else {
      assert.equal((await applying).nodeId, 'new-prompt');
      assert.deepEqual(created.outputFormat, snapshot.outputFormat);
      assert.deepEqual(created.inputTypes, snapshot.inputTypes);
      assert.equal(created.name, 'Original');
    }
  }
});

test('Agent Apply loads the original schema for preview and apply and refuses a version change during that load', async () => withSettings(async () => {
  let state = canvas(), race = true;
  const snapshot = { name: 'Original', text: 'Read {text}', outputFormat: { returnShape: 'table', fields: [{ key: 'original', type: 'str' }] }, inputTypes: { text: 'image' } };
  find(state, 'p').outputFormat = { fields: [{ key: 'changed' }] };
  const proposal = { operations: [{ op: 'apply_review', review: 'rev', suggestion_ids: ['1'] }] };
  const workspace = { getCanvasState: () => state, extractInputFields,
    getEvaluationPayload: async (_id, { recordId }) => {
      assert.equal(recordId, 'evaluation-1');
      if (race) find(state, 's').historyRecordId = 'evaluation-2';
      return { prompt_snapshot: snapshot };
    },
    applyCanvasState: next => { state = next; },
  };
  const refused = await previewProposal(proposal, workspace);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /different Evaluate History/);
  race = false;
  find(state, 's').historyRecordId = 'evaluation-1';
  assert.equal((await previewProposal(proposal, workspace)).ok, true);
  assert.equal((await applyProposal(proposal, workspace)).status, 'applied');
  assert.deepEqual(state.nodes.at(-1).outputFormat, snapshot.outputFormat);
  assert.deepEqual(state.nodes.at(-1).inputTypes, snapshot.inputTypes);
}));

test('the canvas Resume entry reuses the existing Optimize node and shared payload checks', async () => {
  const { runtime, requests } = runtimeHarness(reviewResult({ streamComplete: false }));
  const result = await runtime.resumeReviewNode('rev');
  assert.equal(result.reviewNodeId, 'rev');
  assert.equal(requests[0].reviewNodeId, 'rev');
  assert.equal(requests[0].payload.prompt, 'Read {text}');
  await assert.rejects(runtime.resumeReviewNode('rev'), /no interrupted task/);
});

test('canvas suggestion optimization persists a new candidate and refuses a late write after input changes', async () => {
  const previousFetch = globalThis.fetch;
  const previousTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => previousTimeout(callback, 0);
  try {
    for (const changeInput of [false, true]) {
      const { runtime, elements } = runtimeHarness();
      const before = JSON.parse(elements.get('rev').dataset.reviewResult);
      let polls = 0;
      globalThis.fetch = async (url, options = {}) => {
        const path = String(url);
        if (path.endsWith('/segments')) return response({ segments: ['Read carefully'] });
        if (path.endsWith('/candidates')) return response({ candidates: ['Read evidence carefully'] });
        if (path.endsWith('/log-result')) return response({});
        if (path.endsWith('/api/run') && options.method === 'POST') return response({ run_id: 'fake-run' });
        if (path.endsWith('/api/run/result/fake-run')) {
          polls++;
          if (changeInput) elements.get('p').dataset.promptOutputFormat = JSON.stringify([{ key: 'changed', type: 'str' }]);
          return response({ status: 'done', results: [0, 1, 2].map((input_row_index) => ({ row_index: input_row_index,
            input_row_index, output: { a: 'a', b: 'b', c: 'c' } })) });
        }
        throw new Error(`Unexpected API call ${path}`);
      };
      const run = runtime.optimizeSuggestion({ reviewNodeId: 'rev', suggestionId: '1', maxTrials: 4 });
      if (changeInput) await assert.rejects(run, /inputs or suggestions changed/);
      else {
        const result = await run;
        assert.equal(result.suggestionId, '2');
        const saved = JSON.parse(elements.get('rev').dataset.reviewResult);
        assert.equal(saved.suggestions.length, 2);
        assert.deepEqual(saved.suggestions[0], before.suggestions[0]);
        assert.equal(saved.suggestions[1].applied, false);
        assert.equal(saved.verify_states[2], undefined);
      }
      if (changeInput) assert.equal(JSON.parse(elements.get('rev').dataset.reviewResult).suggestions.length, 1);
      assert.equal(polls, 4);
      assert.equal(hasNodeExecution('rev'), false);
    }
  } finally { globalThis.fetch = previousFetch; globalThis.setTimeout = previousTimeout; }
});
