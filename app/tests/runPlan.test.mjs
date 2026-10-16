import test from 'node:test';
import assert from 'node:assert/strict';

import { planRunTo, upstreamWithoutResult } from '../src/runPlan.js';

const table = (count, header = 'text') => ({ headers: [header], rows: Array.from({ length: count }, (_, i) => [`row ${i}`]) });
const data = (fromId, toId, alias, fromPort = 'result') => ({ type: 'data', fromId, fromPort, toId, ...(alias ? { alias } : {}) });
const promptToRun = (fromId, toId) => ({ type: 'prompt-to-run', fromId, toId });
const prompt = (nodeId, name, text, returnShape = 'single') => ({
  type: 'prompt', nodeId, name, text, outputFormat: { returnShape, fields: [{ key: 'answer', type: 'str' }] },
});
const run = (nodeId, mapping, extra = {}) => ({ type: 'run', nodeId, runInputToColumn: JSON.stringify(mapping), runCredentialId: 'cred', ...extra });
const process = (nodeId, name, code = 'def process(df):\n    return df\n', extra = {}) => ({ type: 'process', nodeId, name, dfCode: code, ...extra });
/** A Run's current complete result over `count` input rows. */
const runDone = (count) => ({
  runCompleted: '1',
  runResults: JSON.stringify(Array.from({ length: count }, (_, i) => ({ input_row_index: i, output: { answer: `a${i}` } }))),
});
const processDone = (count) => ({ dfResults: JSON.stringify({ outputs: { result: table(count) } }) });

const context = { settings: { python_path: 'python' }, credentialIds: new Set(['cred']) };

/** docs (1,000 rows) → Extract → Tidy → Score, nothing run yet. */
function chain() {
  return {
    nodes: [
      { type: 'dataset', nodeId: 'docs', name: 'Docs', datasetContent: table(1000) },
      prompt('p-extract', 'Extract', 'Read {text}'),
      run('extract', { text: 'text' }),
      process('tidy', 'Tidy'),
      prompt('p-score', 'Score', 'Score {answer}'),
      run('score', { answer: 'Output: answer' }),
    ],
    connections: [
      data('docs', 'extract'), promptToRun('p-extract', 'extract'),
      data('extract', 'tidy', 'df'),
      data('tidy', 'score'), promptToRun('p-score', 'score'),
    ],
  };
}
const node = (state, id) => state.nodes.find((item) => item.nodeId === id);
const actions = (plan) => plan.steps.map((step) => [step.nodeId, step.action]);

test('a chain without results runs every step, upstream first', () => {
  const plan = planRunTo(chain(), 'score', context);
  assert.deepEqual(actions(plan), [['extract', 'run'], ['tidy', 'run'], ['score', 'run']]);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.toRun, 3);
  assert.deepEqual(plan.inputs, [{ nodeId: 'docs', name: 'Docs', rows: 1000, readBy: ['extract'] }]);
});

test('a step with a current result is reused and only the rest runs', () => {
  const state = chain();
  Object.assign(node(state, 'extract'), runDone(1000));
  const plan = planRunTo(state, 'score', context);
  assert.deepEqual(actions(plan), [['extract', 'reuse'], ['tidy', 'run'], ['score', 'run']]);
  assert.equal(plan.toRun, 2);
});

test('everything up to the target already current: nothing to run', () => {
  const state = chain();
  Object.assign(node(state, 'extract'), runDone(1000));
  Object.assign(node(state, 'tidy'), processDone(1000));
  const plan = planRunTo(state, 'tidy', context);
  assert.deepEqual(actions(plan), [['extract', 'reuse'], ['tidy', 'reuse']]);
  assert.equal(plan.toRun, 0);
  assert.equal(plan.calls, 0);
});

test('only the target and its upstream are in the plan, not other branches', () => {
  const state = chain();
  state.nodes.push(run('side', { text: 'text' }));
  state.connections.push(data('docs', 'side'), promptToRun('p-extract', 'side'));
  const plan = planRunTo(state, 'tidy', context);
  assert.deepEqual(actions(plan), [['extract', 'run'], ['tidy', 'run']]);
});

test('every Dataset a step reads is an input, including one joined part way', () => {
  const state = chain();
  state.nodes.push({ type: 'dataset', nodeId: 'species', name: 'Species', datasetContent: table(50) });
  node(state, 'tidy').dfCode = 'def process(df, df_Species):\n    return df\n';
  state.connections.push(data('species', 'tidy', 'df_Species'));
  const plan = planRunTo(state, 'score', context);
  assert.deepEqual(plan.inputs, [
    { nodeId: 'docs', name: 'Docs', rows: 1000, readBy: ['extract'] },
    { nodeId: 'species', name: 'Species', rows: 50, readBy: ['tidy'] },
  ]);
  assert.deepEqual(plan.problems, []);
});

test('two Datasets into one Process are both inputs', () => {
  const state = {
    nodes: [
      { type: 'dataset', nodeId: 'a', name: 'A', datasetContent: table(3) },
      { type: 'dataset', nodeId: 'b', name: 'B', datasetContent: table(4) },
      process('merge', 'Merge', 'def process(df, df_B):\n    return df\n'),
    ],
    connections: [data('a', 'merge', 'df'), data('b', 'merge', 'df_B')],
  };
  const plan = planRunTo(state, 'merge', context);
  assert.deepEqual(plan.inputs.map((input) => [input.nodeId, input.readBy]), [['a', ['merge']], ['b', ['merge']]]);
  assert.equal(plan.steps[0].inputRows, 3);
});

test('a Run stopped part way continues, counting only the rows left', () => {
  const state = chain();
  node(state, 'extract').runResumable = true;
  node(state, 'extract').runResults = JSON.stringify([{ input_row_index: 0, output: {} }, { input_row_index: 1, output: {} }]);
  const plan = planRunTo(state, 'extract', context);
  assert.deepEqual(actions(plan), [['extract', 'resume']]);
  assert.equal(plan.steps[0].calls, 998);
});

test('model calls follow the rows through single-row Runs and become unknown after a Process', () => {
  const plan = planRunTo(chain(), 'score', context);
  assert.deepEqual(plan.steps.map((step) => step.calls), [1000, 0, null]);
  assert.equal(plan.calls, null);

  const state = chain();
  state.connections = [data('docs', 'extract'), promptToRun('p-extract', 'extract'), data('extract', 'score'), promptToRun('p-score', 'score')];
  assert.deepEqual(planRunTo(state, 'score', context).steps.map((step) => step.calls), [1000, 1000]);
  node(state, 'p-extract').outputFormat.returnShape = 'table';
  assert.deepEqual(planRunTo(state, 'score', context).steps.map((step) => step.calls), [1000, null]);
});

test('a reused upstream gives the downstream its real row count', () => {
  const state = chain();
  Object.assign(node(state, 'extract'), runDone(1000));
  Object.assign(node(state, 'tidy'), processDone(40));
  const plan = planRunTo(state, 'score', context);
  assert.equal(plan.steps.at(-1).calls, 40);
});

test('what keeps a step from running is a problem on that step', () => {
  const state = chain();
  node(state, 'extract').runPending = true;
  node(state, 'score').runInputToColumn = '{}';
  node(state, 'score').runCredentialId = 'gone';
  const plan = planRunTo(state, 'score', { settings: {}, credentialIds: new Set(['cred']) });
  assert.deepEqual(plan.problems, [
    { nodeId: 'extract', message: '"Extract" is already running.' },
    { nodeId: 'tidy', message: 'No Python interpreter is set. Choose one in Settings → Python.' },
    { nodeId: 'score', message: '"Score" has no column mapped to {answer}.' },
    { nodeId: 'score', message: '"Score" has no usable model. Choose one in Settings → Run.' },
  ]);
});

test('a Run without a Prompt or input, and a Process without process(df), are problems', () => {
  const state = {
    nodes: [run('lonely', {}), process('broken', 'Broken', 'print(1)')],
    connections: [data('lonely', 'broken', 'df')],
  };
  const messages = planRunTo(state, 'broken', context).problems.map((item) => item.message);
  assert.ok(messages.includes('"Run" is not connected to a Prompt.'));
  assert.ok(messages.includes('"Run" has no input. Connect a Dataset or a step to it.'));
  assert.ok(messages.includes('"Broken" does not define process(df).'));
});

test('a branch the upstream Process is known not to return is a problem', () => {
  const state = {
    nodes: [
      { type: 'dataset', nodeId: 'docs', name: 'Docs', datasetContent: table(5) },
      process('split', 'Split', 'def process(df):\n    return {"left": df}\n', { processOutputPorts: JSON.stringify({ ports: ['left'], dynamic: false }) }),
      process('join', 'Join'),
    ],
    connections: [data('docs', 'split', 'df'), data('split', 'join', 'df', 'right')],
  };
  const messages = planRunTo(state, 'join', context).problems.map((item) => item.message);
  assert.ok(messages.includes('Process "Split" does not return branch "right".'), messages.join(' | '));
});

test('the target must be a Run or a Process', () => {
  const state = chain();
  state.nodes.push({ type: 'score', nodeId: 'eval' });
  for (const id of ['eval', 'docs', 'p-extract', 'missing']) {
    const plan = planRunTo(state, id, context);
    assert.deepEqual(plan.problems, [{ nodeId: id, message: 'Execute works on Run and Process steps.' }]);
    assert.deepEqual(plan.steps, []);
  }
});

test('a Process whose window never opened has no code yet, said as such', () => {
  const state = chain();
  node(state, 'tidy').dfCode = '';
  const messages = planRunTo(state, 'tidy', context).problems.map((item) => item.message);
  assert.deepEqual(messages, ['"Tidy" has no code yet. Open it to write its code.']);
});

test('a step that needs updating runs, and its downstream says why it waits', () => {
  const state = chain();
  node(state, 'extract').historyStaleRecordId = 'old-extract';
  const plan = planRunTo(state, 'tidy', context);
  assert.deepEqual(actions(plan), [['extract', 'run'], ['tidy', 'run']]);
  assert.deepEqual(plan.problems, []);
});

test('Execute this step plans only the step, and needs current results before it', () => {
  const state = chain();
  const waiting = planRunTo(state, 'tidy', context, { onlyThis: true });
  assert.equal(waiting.scope, 'this');
  assert.deepEqual(actions(waiting), [['tidy', 'run']]);
  assert.deepEqual(waiting.problems.map((item) => item.message), ['"Extract" has no current result. Use Execute to here to run it first.']);
  assert.equal(upstreamWithoutResult(state, 'tidy'), 'Extract');
  assert.equal(upstreamWithoutResult(state, 'extract'), null);

  Object.assign(node(state, 'extract'), runDone(1000));
  const ready = planRunTo(state, 'tidy', context, { onlyThis: true });
  assert.deepEqual(actions(ready), [['tidy', 'run']]);
  assert.deepEqual(ready.problems, []);
  assert.equal(upstreamWithoutResult(state, 'tidy'), null);
  assert.equal(ready.steps[0].inputRows, 1000);
});

test('when everything is current, rerun runs the target again and reuses the rest', () => {
  const state = chain();
  Object.assign(node(state, 'extract'), runDone(1000));
  Object.assign(node(state, 'tidy'), processDone(1000));
  assert.equal(planRunTo(state, 'tidy', context).toRun, 0);
  const again = planRunTo(state, 'tidy', context, { rerun: true });
  assert.deepEqual(actions(again), [['extract', 'reuse'], ['tidy', 'rerun']]);
  assert.equal(again.toRun, 1);
  const run = planRunTo(state, 'extract', context, { rerun: true, onlyThis: true });
  assert.deepEqual(actions(run), [['extract', 'rerun']]);
  assert.equal(run.steps[0].calls, 1000);
});
