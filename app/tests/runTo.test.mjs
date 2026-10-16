import test from 'node:test';
import assert from 'node:assert/strict';

import { planRunTo } from '../src/runPlan.js';
import { planHeldNodeIds, runTo } from '../src/runTo.js';
import { isTaskLocked, taskLockedIds } from '../src/runTaskLocks.js';

const table = (count) => ({ headers: ['text'], rows: Array.from({ length: count }, (_, i) => [`row ${i}`]) });
const data = (fromId, toId, alias) => ({ type: 'data', fromId, fromPort: 'result', toId, ...(alias ? { alias } : {}) });
const prompt = (nodeId, name, text) => ({ type: 'prompt', nodeId, name, text, outputFormat: { returnShape: 'single', fields: [{ key: 'answer' }] } });
const context = { settings: { python_path: 'python' }, credentialIds: new Set(['cred']) };

/** docs → Extract → Tidy → Score, nothing run yet. */
function chain() {
  return {
    nodes: [
      { type: 'dataset', nodeId: 'docs', name: 'Docs', datasetContent: table(3) },
      prompt('p-extract', 'Extract', 'Read {text}'),
      { type: 'run', nodeId: 'extract', runInputToColumn: '{"text":"text"}', runCredentialId: 'cred' },
      { type: 'process', nodeId: 'tidy', name: 'Tidy', dfCode: 'def process(df):\n    return df\n' },
      prompt('p-score', 'Score', 'Score {answer}'),
      { type: 'run', nodeId: 'score', runInputToColumn: '{"answer":"Output: answer"}', runCredentialId: 'cred' },
    ],
    connections: [
      data('docs', 'extract'), { type: 'prompt-to-run', fromId: 'p-extract', toId: 'extract' },
      data('extract', 'tidy', 'df'),
      data('tidy', 'score'), { type: 'prompt-to-run', fromId: 'p-score', toId: 'score' },
    ],
  };
}

/**
 * A canvas workspace over `state`: a Generate or Process "runs" by getting a result at once.
 * `fail` names a step that fails; `during` is called inside each step.
 */
function fakeEnv(state, { fail = '', runStatus = 'completed', during = () => {} } = {}) {
  const calls = [];
  const node = (id) => state.nodes.find((item) => item.nodeId === id);
  let record = 0;
  return {
    calls,
    getCanvasState: () => state,
    async startRunNode({ runNodeId }) {
      calls.push(runNodeId);
      during(runNodeId);
      if (fail === runNodeId) throw new Error('The model refused.');
      const run = node(runNodeId);
      run.runResults = JSON.stringify([0, 1, 2].map((i) => ({ input_row_index: i, output: { answer: `a${i}` } })));
      if (runStatus === 'completed') run.runCompleted = '1';
      else run.runResumable = true;
      run.historyRecordId = `rec-${runNodeId}-${record += 1}`;
      return { waitRequired: false };
    },
    async inspectNode(id) {
      const run = node(id);
      return { details: { status: run.runCompleted === '1' ? 'completed' : 'stopped', inputRows: 3, inputRowsDone: 3, errorRows: id === 'score' ? 1 : 0 } };
    },
    async runProcessNode(id, { signal } = {}) {
      calls.push(id);
      during(id);
      if (fail === id) throw new Error('NameError: x');
      if (signal?.aborted) return { outputs: {}, cancelled: true };
      node(id).dfResults = JSON.stringify({ outputs: { result: table(3) } });
      return { outputs: { result: table(3) }, cancelled: false };
    },
  };
}

const statuses = (task) => task.steps.map((step) => [step.nodeId, step.status]);

test('every step without a result runs in order and lands its record', async () => {
  const state = chain();
  const env = fakeEnv(state);
  const seen = [];
  const task = await runTo('score', env, { context, onStep: (step) => seen.push(`${step.nodeId}:${step.status}`) });
  assert.equal(task.status, 'completed');
  assert.deepEqual(env.calls, ['extract', 'tidy', 'score']);
  assert.deepEqual(statuses(task), [['extract', 'completed'], ['tidy', 'completed'], ['score', 'completed']]);
  assert.equal(task.steps[0].recordId, 'rec-extract-1');
  assert.equal(task.steps[2].errorRows, 1);
  assert.deepEqual(seen, ['extract:running', 'extract:completed', 'tidy:running', 'tidy:completed', 'score:running', 'score:completed']);
});

test('a failed step stops the steps after it; running again reuses what finished', async () => {
  const state = chain();
  const failed = await runTo('score', fakeEnv(state, { fail: 'tidy' }), { context });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(statuses(failed), [['extract', 'completed'], ['tidy', 'failed'], ['score', 'not-started']]);
  assert.match(failed.steps[1].message, /NameError/);

  const env = fakeEnv(state);
  const again = await runTo('score', env, { context });
  assert.equal(again.status, 'completed');
  assert.deepEqual(env.calls, ['tidy', 'score']);
  assert.deepEqual(statuses(again), [['extract', 'reused'], ['tidy', 'completed'], ['score', 'completed']]);
});

test('a Generate that ends without finishing its rows (stopped from its window) stops the task', async () => {
  const task = await runTo('score', fakeEnv(chain(), { runStatus: 'stopped' }), { context });
  assert.equal(task.status, 'stopped');
  assert.deepEqual(statuses(task), [['extract', 'stopped'], ['tidy', 'not-started'], ['score', 'not-started']]);
});

test('stopping ends the task after the step in progress', async () => {
  const controller = new AbortController();
  const env = fakeEnv(chain(), { during: (id) => { if (id === 'extract') controller.abort(); } });
  const task = await runTo('score', env, { context, signal: controller.signal });
  assert.equal(task.status, 'stopped');
  assert.deepEqual(env.calls, ['extract']);
  assert.deepEqual(statuses(task), [['extract', 'completed'], ['tidy', 'not-started'], ['score', 'not-started']]);
});

test('a plan that changed since the user confirmed it is refused, and so is one with problems', async () => {
  const state = chain();
  const approved = planRunTo(state, 'score', context);
  state.nodes.find((item) => item.nodeId === 'tidy').dfResults = JSON.stringify({ outputs: { result: table(3) } });
  const env = fakeEnv(state);
  const changed = await runTo('score', env, { context, approvedPlan: approved });
  assert.equal(changed.status, 'failed');
  assert.match(changed.error, /canvas changed/);
  assert.deepEqual(env.calls, []);

  const broken = await runTo('score', env, { context: { ...context, credentialIds: new Set() } });
  assert.equal(broken.status, 'failed');
  assert.match(broken.error, /no usable model/);
  assert.deepEqual(env.calls, []);
});

test('nothing to run when everything is current', async () => {
  const state = chain();
  await runTo('score', fakeEnv(state), { context });
  const env = fakeEnv(state);
  const task = await runTo('score', env, { context });
  assert.equal(task.status, 'completed');
  assert.equal(task.plan.toRun, 0);
  assert.deepEqual(env.calls, []);
});

test('the steps, their Prompts and the Datasets they read are held while it runs, and released after', async () => {
  const state = chain();
  const held = [];
  const env = fakeEnv(state, { fail: 'score', during: () => held.push(taskLockedIds().sort()) });
  await runTo('score', env, { context });
  assert.deepEqual(held[0], ['docs', 'extract', 'p-extract', 'p-score', 'score', 'tidy']);
  assert.deepEqual(taskLockedIds(), []);
  assert.equal(isTaskLocked('extract'), false);
  assert.deepEqual(planHeldNodeIds(state, planRunTo(chain(), 'tidy', context)).sort(), ['docs', 'extract', 'p-extract', 'tidy']);
});

test('a step held by another run in progress is refused', async () => {
  const state = chain();
  let inner;
  const env = fakeEnv(state, {
    during: (id) => { if (id === 'extract' && !inner) inner = runTo('tidy', fakeEnv(chain()), { context }); },
  });
  await runTo('score', env, { context });
  const refused = await inner;
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /another run in progress/);
});

test('while held, a step cannot have its inputs changed', async () => {
  const { checkDisconnect } = await import('../src/nodePorts.js');
  const { holdNodes } = await import('../src/runTaskLocks.js');
  const state = chain();
  assert.equal(checkDisconnect(state, { nodeId: 'score', portId: 'input' }).ok, true);
  const release = holdNodes(['score']);
  try {
    const result = checkDisconnect(state, { nodeId: 'score', portId: 'input' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /part of a run in progress/);
  } finally {
    release();
  }
});

test('the Agent run_to card shows the plan the user confirms', async () => {
  const { previewRunRequest } = await import('../src/agent/execution/runJobs.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, json: async () => (String(url).includes('/api/settings') ? { python_path: 'python' } : { models: [] }) });
  try {
    const state = chain();
    state.nodes.find((item) => item.nodeId === 'extract').runCompleted = '1';
    state.nodes.find((item) => item.nodeId === 'extract').runResults = JSON.stringify([{ input_row_index: 0, output: { answer: 'a' } }]);
    const env = { getCanvasState: () => state, credentialsById: new Map([['cred', { id: 'cred', model: 'some/model' }]]) };
    const preview = await previewRunRequest({ jobs: [{ kind: 'run_to', node: 'score' }] }, env);
    assert.equal(preview.ok, true, preview.error);
    assert.equal(preview.items[0].title, 'Run to "Score"');
    assert.deepEqual(preview.items[0].planSteps, [
      { nodeId: 'extract', action: 'reuse' }, { nodeId: 'tidy', action: 'run' }, { nodeId: 'score', action: 'run' },
    ]);
    assert.deepEqual(preview.items[0].lines, [
      'Inputs: Docs (3 rows)',
      'Uses existing results: Extract',
      'Runs, in order: Tidy → Score',
      'Model calls: unknown until the steps before them have run.',
    ]);
    const refused = await previewRunRequest({ jobs: [{ kind: 'run_to', node: 'p-score' }] }, env);
    assert.match(refused.error, /run_to works on a Generate or a Process/);

    // only_this: just that step, which needs current results before it.
    const lone = await previewRunRequest({ jobs: [{ kind: 'run_to', node: 'tidy', only_this: true }] }, env);
    assert.equal(lone.ok, true, lone.error);
    assert.equal(lone.items[0].title, 'Run "Tidy"');
    assert.deepEqual(lone.items[0].planSteps, [{ nodeId: 'tidy', action: 'run' }]);
    const early = await previewRunRequest({ jobs: [{ kind: 'run_to', node: 'score', only_this: true }] }, env);
    assert.match(early.error, /"Tidy" has no current result/);

    // Everything current: it runs the step again.
    const again = await previewRunRequest({ jobs: [{ kind: 'run_to', node: 'extract' }] }, env);
    assert.equal(again.ok, true, again.error);
    assert.deepEqual(again.items[0].planSteps, [{ nodeId: 'extract', action: 'rerun' }]);
    assert.match(again.items[0].lines.at(-2), /Extract \(again; its result is current\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('running again executes a current step once more, through its normal single-step run', async () => {
  const state = chain();
  await runTo('tidy', fakeEnv(state), { context });
  const env = fakeEnv(state);
  const task = await runTo('tidy', env, { context, planOptions: { rerun: true } });
  assert.equal(task.status, 'completed');
  assert.deepEqual(env.calls, ['tidy']);
  assert.deepEqual(statuses(task), [['extract', 'reused'], ['tidy', 'completed']]);
});

test('Run this step refuses while a step before it has no result', async () => {
  const env = fakeEnv(chain());
  const task = await runTo('tidy', env, { context, planOptions: { onlyThis: true } });
  assert.equal(task.status, 'failed');
  assert.match(task.error, /Use Run to here/);
  assert.deepEqual(env.calls, []);
});
