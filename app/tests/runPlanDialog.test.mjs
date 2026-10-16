import test from 'node:test';
import assert from 'node:assert/strict';

import { runPlanView } from '../src/runPlanDialog.js';

const plan = (overrides = {}) => ({
  targetId: 'score',
  steps: [
    { nodeId: 'extract', kind: 'run', name: 'Extract', action: 'reuse', inputRows: 1000, calls: 0, credentialId: 'cred' },
    { nodeId: 'tidy', kind: 'process', name: 'Tidy', action: 'run', inputRows: 1000, calls: 0 },
    { nodeId: 'score', kind: 'run', name: 'Score', action: 'run', inputRows: null, calls: null, credentialId: 'cred' },
  ],
  inputs: [
    { nodeId: 'docs', name: 'Docs', rows: 1000, readBy: ['extract'] },
    { nodeId: 'species', name: 'Species', rows: 1, readBy: ['tidy'] },
  ],
  problems: [],
  toRun: 2,
  calls: null,
  ...overrides,
});
const modelLabel = (id) => (id === 'cred' ? 'claude-sonnet' : id);

test('the plan reads as inputs, reused results and the steps that run, in order', () => {
  const view = runPlanView(plan(), { modelLabel });
  assert.equal(view.title, 'Run to "Score"');
  assert.deepEqual(view.inputs.map((input) => input.text), [
    'Docs · 1,000 rows · read by Extract',
    'Species · 1 row · read by Tidy',
  ]);
  assert.deepEqual(view.reused.map((item) => [item.name, item.detail]), [['Extract', '']]);
  assert.deepEqual(view.toRun.map((item) => [item.name, item.detail]), [
    ['Tidy', 'Runs its Python code'],
    ['Score', 'claude-sonnet · model calls unknown until the steps before it finish'],
  ]);
  assert.equal(view.calls, 'Model calls: unknown until earlier steps finish.');
  assert.equal(view.canStart, true);
  assert.equal(view.hasProblems, false);
});

test('known calls are counted, and a stopped Run says it continues', () => {
  const steps = [{ nodeId: 'extract', kind: 'run', name: 'Extract', action: 'resume', inputRows: 1000, calls: 998, credentialId: 'cred' },
    { nodeId: 'score', kind: 'run', name: 'Score', action: 'run', inputRows: 1000, calls: 1000, credentialId: 'cred' }];
  const view = runPlanView(plan({ steps, calls: 1998 }), { modelLabel });
  assert.deepEqual(view.toRun.map((item) => item.detail), [
    'claude-sonnet · 998 model calls · continues where it stopped',
    'claude-sonnet · 1,000 model calls',
  ]);
  assert.equal(view.calls, 'Model calls: 1,998');
});

test('problems sit on their step or input and keep it from starting', () => {
  const view = runPlanView(plan({ problems: [
    { nodeId: 'score', message: '"Score" has no column mapped to {answer}.' },
    { nodeId: 'species', message: 'Input Dataset "Species" has no current result.' },
    { nodeId: 'elsewhere', message: 'Run to here works on Run and Process steps.' },
  ] }), { modelLabel });
  assert.equal(view.canStart, false);
  assert.equal(view.hasProblems, true);
  assert.deepEqual(view.toRun.find((item) => item.nodeId === 'score').problems, ['"Score" has no column mapped to {answer}.']);
  assert.deepEqual(view.inputs[1].problems, ['Input Dataset "Species" has no current result.']);
  assert.deepEqual(view.otherProblems, ['Run to here works on Run and Process steps.']);
});

test('a plan that runs only Process steps has no model calls line', () => {
  const steps = [{ nodeId: 'tidy', kind: 'process', name: 'Tidy', action: 'run', inputRows: 3, calls: 0 }];
  assert.equal(runPlanView(plan({ steps, calls: 0, toRun: 1 }), { modelLabel }).calls, '');
});
