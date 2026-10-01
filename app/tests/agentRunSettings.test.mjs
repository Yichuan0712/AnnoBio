import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectWorkflowNode } from '../src/agent/canvas/workflowNodeInspector.js';
import { ChangeSetError, planChangeSet } from '../src/agent/operations/changeSet.js';

const extractInputFields = (sections) => [...new Set(sections
  .flatMap((section) => [...String(section.content || '').matchAll(/\{([^{}]+)\}/g)].map((match) => match[1])))];

function canvas(run = {}) {
  return {
    nodes: [
      { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: {
        headers: ['text'], columnTypes: ['text'], rows: [['a'], ['b']],
      } },
      { type: 'prompt', nodeId: 'p', name: 'Extract', sections: [{ name: 'Task', content: 'Read {text}' }],
        outputFormat: { returnShape: 'single', fields: [{ key: 'answer', type: 'str' }] } },
      { type: 'run', nodeId: 'r', runName: 'Run', runWorkingSetId: 'raw',
        runInputToColumn: JSON.stringify({ text: 'text' }), runCredentialId: 'cred-a', ...run },
    ],
    connections: [{ fromId: 'p', toId: 'r', type: 'prompt-to-run' }],
  };
}

const ctx = { extractInputFields, credentialIds: new Set(['cred-a', 'cred-b']) };
const plan = (state, operations) => planChangeSet(state, operations, ctx);
const runOf = (result, id = 'r') => result.state.nodes.find((node) => node.nodeId === id);

test('add_run stores the same per-Run settings as the Run settings dialog', () => {
  const result = plan(canvas(), [{
    op: 'add_run', ref: '$run', prompt: 'p', input_dataset: 'raw', input_mapping: { text: 'text' },
    settings: { run_max_tokens: 4096, run_concurrency: '3' },
  }]);
  const added = runOf(result, result.refs.$run);
  assert.deepEqual(added.runSettings, { run_max_tokens: 4096, run_concurrency: 3 });
  assert.ok(result.items[0].lines.includes('Settings: Max tokens 4096, Max retries on error default, Concurrency 3'));

  const plain = plan(canvas(), [{ op: 'add_run', ref: '$run', prompt: 'p', input_dataset: 'raw', input_mapping: { text: 'text' } }]);
  assert.equal('runSettings' in runOf(plain, plain.refs.$run), false);
});

test('update changes only the given settings and null restores the default', () => {
  const state = canvas({ runSettings: { run_max_tokens: 4096, run_max_retries: 1 } });
  const merged = plan(state, [{ op: 'update', node: 'r', set: { settings: { run_max_retries: null, run_concurrency: 10 } } }]);
  assert.deepEqual(runOf(merged).runSettings, { run_max_tokens: 4096, run_concurrency: 10 });
  const blank = plan(state, [{ op: 'update', node: 'r', set: { settings: { run_max_retries: ' ' } } }]);
  assert.deepEqual(runOf(blank).runSettings, { run_max_tokens: 4096 }, 'blank is the default, not 0 retries');
  assert.deepEqual(state.nodes[2].runSettings, { run_max_tokens: 4096, run_max_retries: 1 }, 'the plan must not mutate the live state');

  const cleared = plan(state, [{ op: 'update', node: 'r', set: { settings: null } }]);
  assert.equal('runSettings' in runOf(cleared), false);
});

test('settings use the dialog ranges and keys', () => {
  const bad = [
    { run_max_tokens: 100 },
    { run_max_retries: 6 },
    { run_concurrency: 1.5 },
    { temperature: 0 },
    [],
  ];
  for (const settings of bad) {
    assert.throws(() => plan(canvas(), [{ op: 'update', node: 'r', set: { settings } }]), ChangeSetError);
  }
});

test('a Run with results keeps its model, as in the Run settings dialog', () => {
  const withResults = canvas({ runResults: JSON.stringify([{ input_row_index: 0, output: { answer: 'x' } }]) });
  assert.throws(
    () => plan(withResults, [{ op: 'update', node: 'r', set: { credential_id: 'cred-b' } }]),
    /already has results/,
  );
  assert.throws(
    () => plan(canvas({ runCompleted: '1' }), [{ op: 'update', node: 'r', set: { credential_id: 'cred-b' } }]),
    /already has results/,
  );
  const settingsOnly = plan(withResults, [{ op: 'update', node: 'r', set: { settings: { run_concurrency: 2 } } }]);
  assert.deepEqual(runOf(settingsOnly).runSettings, { run_concurrency: 2 });
  assert.equal(runOf(plan(canvas(), [{ op: 'update', node: 'r', set: { credential_id: 'cred-b' } }])).runCredentialId, 'cred-b');
});

test('inspect_node reports each Run setting or its default', () => {
  const inspected = inspectWorkflowNode(canvas({ runSettings: { run_max_tokens: 2048 } }), 'r', { extractInputFields });
  assert.deepEqual(inspected.details.settings, {
    run_max_tokens: 2048, run_max_retries: 'default', run_concurrency: 'default',
  });
});
