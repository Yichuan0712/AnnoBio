import test from 'node:test';
import assert from 'node:assert/strict';
import { planChangeSet } from '../src/agent/operations/changeSet.js';
import { inspectWorkflowNode } from '../src/agent/canvas/workflowNodeInspector.js';
import { buildWorkspaceSummary } from '../src/agent/context/workspaceSummary.js';
import { processTrialInputs } from '../src/agent/canvas/processTrialInputs.js';
import { previewRunRequest } from '../src/agent/execution/runJobs.js';
import { previewProposal } from '../src/agent/operations/proposals.js';
import { RunHistorySession } from '../src/runHistorySession.js';
import { processInputAliases, processPrimarySource, runInputSource, validateStepInputs } from '../src/stepInputs.js';
import { graph, recordGraph } from './historyGraphFixture.mjs';

const extractInputFields = (sections) => [...new Set((sections || [])
  .flatMap((section) => [...String(section.content || '').matchAll(/\{([^{}]+)\}/g)].map((match) => match[1])))];
const data = (fromId, toId, alias, fromPort = 'result') => ({ type: 'data', fromId, fromPort, toId, ...(alias ? { alias } : {}) });
const table = (headers, rows) => ({ headers, rows, columnTypes: headers.map(() => 'text') });
const raw = table(['text'], [['a'], ['b']]);

// raw → Extract (r, completed) → Split (kept / dropped); Idle reads raw and has not run; Dynamic builds its branches at run time.
const canvas = () => ({
  historyVersion: 1,
  nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: raw },
    { type: 'prompt', nodeId: 'p', name: 'Extract', sections: [{ name: 'Task', content: 'Read {text}' }],
      outputFormat: { returnShape: 'single', fields: [{ key: 'answer', type: 'str' }] }, inputTypes: {} },
    { type: 'prompt', nodeId: 'judge', name: 'Judge', sections: [{ name: 'Task', content: 'Judge {answer}' }],
      outputFormat: { returnShape: 'single', fields: [{ key: 'verdict', type: 'str' }] }, inputTypes: {} },
    { type: 'run', nodeId: 'r', runName: 'Run', historyRecordId: 'rec-r', runCompleted: '1', runInputToColumn: JSON.stringify({ text: 'text' }),
      runInputContent: JSON.stringify(raw),
      runResults: JSON.stringify([{ row_index: 0, input_row_index: 0, output: { answer: 'A' } }, { row_index: 1, input_row_index: 1, output: { answer: 'B' } }]) },
    { type: 'run', nodeId: 'idle', runName: 'Idle', runInputToColumn: '{}' },
    { type: 'process', nodeId: 'split', name: 'Split', historyRecordId: 'rec-s',
      dfCode: 'def process(df):\n    return {"kept": df, "dropped": df.head(0)}\n',
      processOutputPorts: { ports: ['kept', 'dropped'], dynamic: false, error: '', codeHash: 'h' },
      dfResults: JSON.stringify({ outputs: { kept: table(['answer'], [['A']]), dropped: table(['answer'], []) } }) },
    { type: 'process', nodeId: 'dyn', name: 'Dynamic', dfCode: 'def process(df):\n    return out\n',
      processOutputPorts: { ports: [], dynamic: true, error: '', codeHash: 'h2' } },
  ],
  connections: [
    { type: 'prompt-to-run', fromId: 'p', toId: 'r' }, data('raw', 'r'),
    { type: 'prompt-to-run', fromId: 'p', toId: 'idle' }, data('raw', 'idle'),
    data('r', 'split', 'df'), data('raw', 'dyn', 'df'),
  ],
});
const plan = (operations, state = canvas()) => planChangeSet(state, operations, { extractInputFields });
const addJudge = (extra) => ({ op: 'add_run', ref: '$judge', prompt: 'judge', ...extra });

test('a Run the Agent adds can read a Run\'s results, mapped to the columns its readers get', () => {
  const result = plan([addJudge({ input: 'r', input_mapping: { answer: 'Output: answer' } })]);
  const id = result.refs.$judge;
  assert.deepEqual(runInputSource(result.state, id), { nodeId: 'r', port: 'result', kind: 'run' });
  assert.deepEqual(JSON.parse(result.state.nodes.find((node) => node.nodeId === id).runInputToColumn), { answer: 'Output: answer' });
  assert.deepEqual(result.items[0].lines.slice(0, 2), ['Prompt "Judge" on "Extract"', 'Mapping: answer ← Output: answer']);
  assert.deepEqual(validateStepInputs(result.state), []);
  assert.throws(() => plan([addJudge({ input: 'r', input_mapping: { answer: 'answer' } })]), /"Extract" has no column "answer"\. Columns: Input: #, Input: text, Output: #, Output: answer/);
});

test('a step without a result has no known columns, so its reader is mapped later', () => {
  const result = plan([addJudge({ input: 'idle' })]);
  assert.deepEqual(runInputSource(result.state, result.refs.$judge), { nodeId: 'idle', port: 'result', kind: 'run' });
  assert.match(result.items[0].lines[1], /Not mapped yet: map its inputs once "Extract" has run/);
  assert.throws(() => plan([addJudge({ input: 'idle', input_mapping: { answer: 'Output: answer' } })]),
    /"Extract" has no result yet, so its columns are not known\. Leave out input_mapping, run "Extract", then set input_mapping with update/);
});

test('a Process branch is read by name, once the Process\'s branches are known', () => {
  assert.throws(() => plan([addJudge({ input: 'split' })]), /Process "Split" has several branches \(kept, dropped\); name the one to read with input_branch/);
  assert.throws(() => plan([addJudge({ input: 'split', input_branch: 'other' })]), /Process "Split" has no branch "other"\. Branches: kept, dropped/);
  const result = plan([addJudge({ input: 'split', input_branch: 'kept', input_mapping: { answer: 'answer' } })]);
  assert.deepEqual(runInputSource(result.state, result.refs.$judge), { nodeId: 'split', port: 'kept', kind: 'process' });
  assert.equal(result.items[0].lines[0], 'Prompt "Judge" on "Split · kept"');
  assert.throws(() => plan([addJudge({ input: 'dyn' })]), /Process "Dynamic" has no known branches yet: its code builds them at run time, so run it first/);
  assert.throws(() => plan([addJudge({ input: 'raw', input_branch: 'kept' })]), /a dataset with one output; it has no branch "kept"/);
});

test('a Process added or rewritten in the same proposal cannot be read until its branches are checked', () => {
  const addSplit = { op: 'add_process', ref: '$p', primary_input: 'raw', code: 'def process(df):\n    return {"a": df, "b": df}\n' };
  assert.throws(() => plan([addSplit, addJudge({ input: '$p', input_branch: 'a' })]), /added or changed in this proposal, so its branches are not known yet/);
  const rewrite = { op: 'update', node: 'split', set: { code: 'def process(df):\n    return {"kept": df}\n' } };
  assert.throws(() => plan([rewrite, addJudge({ input: 'split', input_branch: 'kept' })]), /added or changed in this proposal/);
  // A rename is not a code change.
  assert.doesNotThrow(() => plan([{ op: 'update', node: 'split', set: { name: 'Sort' } },
    addJudge({ input: 'split', input_branch: 'kept', input_mapping: { answer: 'answer' } })]));
});

test('reading a step that reads this one is refused as a loop, and input_dataset is gone', () => {
  assert.throws(() => plan([{ op: 'update', node: 'r', set: { input: 'split', input_branch: 'kept' } }]), /reads this step's output, so reading it would make a loop/);
  assert.throws(() => plan([{ op: 'update', node: 'r', set: { input: 'r' } }]), /is this step itself, so reading it would make a loop/);
  assert.throws(() => plan([addJudge({ input_dataset: 'raw' })]), /input_dataset is not used/);
  assert.throws(() => plan([{ op: 'update', node: 'idle', set: { input_dataset: 'raw' } }]), /input_dataset is not used/);
});

test('a Process the Agent adds reads step outputs as df and by alias, as its window does', () => {
  const code = 'def process(df, df_kept):\n    return df.merge(df_kept, on="answer")\n';
  const result = plan([{ op: 'add_process', ref: '$m', name: 'Merge', primary_input: 'r', code }]);
  const id = result.refs.$m;
  assert.deepEqual(processPrimarySource(result.state, id), { nodeId: 'r', port: 'result', kind: 'run' });
  assert.deepEqual(processInputAliases(result.state, id), { 'r:result': 'df', 'split:kept': 'df_kept' });
  assert.deepEqual(result.items[0].lines.slice(0, 2), ['df = "Extract"', 'df_kept = "Split · kept"']);
  // A parameter that matches no input stays unconnected, as an empty port on the canvas, and the card says so.
  const unconnected = plan([{ op: 'add_process', ref: '$u', primary_input: 'r', code: 'def process(df, df_missing):\n    return df\n' }]);
  assert.match(unconnected.items[0].lines.join('\n'), /Not connected yet: df_missing .*Inputs it could read: .*df_kept \("Split · kept"\)/);
  const inspected = inspectWorkflowNode(unconnected.state, unconnected.refs.$u, { extractInputFields });
  assert.deepEqual(inspected.details.unconnectedInputs, ['df_missing']);
  assert.ok(inspected.diagnostics.some((line) => /Not connected: df_missing/.test(line)));

  const moved = plan([{ op: 'update', node: 'split', set: { primary_input: 'raw' } }]);
  assert.deepEqual(processPrimarySource(moved.state, 'split'), { nodeId: 'raw', port: 'result', kind: 'dataset' });
  assert.deepEqual(moved.items[0].lines, ['df = "Raw"', 'Its last output no longer reflects the code until it is run again.']);
});

test('removing a step says which readers lose that input', () => {
  const state = canvas();
  state.connections.push(data('split', 'idle', undefined, 'kept'));
  state.connections.splice(state.connections.findIndex((edge) => edge.fromId === 'raw' && edge.toId === 'idle'), 1);
  const result = plan([{ op: 'remove', node: 'split' }], state);
  assert.deepEqual(result.items[0].lines, ['Run "Idle" loses its input']);
  assert.equal(runInputSource(result.state, 'idle'), null);
  assert.deepEqual(plan([{ op: 'remove', node: 'r' }]).items[0].lines, ['Process "Split" loses its input df']);
});

test('inspect_node describes step inputs, branches, readers and what a step waits for', () => {
  const state = canvas();
  state.connections.push(data('split', 'idle', undefined, 'kept'));
  state.connections.splice(state.connections.findIndex((edge) => edge.fromId === 'raw' && edge.toId === 'idle'), 1);
  const idle = inspectWorkflowNode(state, 'idle', { extractInputFields }).details;
  assert.deepEqual(idle.input, { nodeId: 'split', type: 'process', title: 'Split', branch: 'kept' });
  assert.equal(idle.waitingFor, null);
  assert.equal(idle.inputRows, 1);

  const split = inspectWorkflowNode(state, 'split', {}).details;
  assert.deepEqual(split.primaryInput, { nodeId: 'r', type: 'run', title: 'Run' });
  assert.deepEqual(split.inputs, [{ nodeId: 'r', type: 'run', title: 'Run', alias: 'df' }]);
  assert.deepEqual(split.branches, { names: ['kept', 'dropped'], known: true, dynamic: false, from: 'last run' });
  assert.deepEqual(split.readBy, [{ nodeId: 'idle', type: 'run', title: 'Idle', branch: 'kept', alias: null }]);
  assert.ok(split.availableInputs.some((input) => input.nodeId === 'raw' && input.alias === 'df_raw' && input.isInput === false));

  // Once Extract has no result, everything after it waits, saying so as the windows do.
  const waiting = canvas();
  const run = waiting.nodes.find((node) => node.nodeId === 'r');
  delete run.runCompleted;
  delete run.runResults;
  assert.equal(inspectWorkflowNode(waiting, 'split', {}).details.waitingFor, 'Waiting for upstream results: run "Extract" first.');
  assert.deepEqual(inspectWorkflowNode(waiting, 'dyn', {}).details.branches, { names: [], known: true, dynamic: true, from: 'code' });
});

test('the workspace summary describes steps reading each other, with branches and aliases', async () => {
  const state = canvas();
  state.connections.push(data('split', 'idle', undefined, 'kept'));
  state.connections.splice(state.connections.findIndex((edge) => edge.fromId === 'raw' && edge.toId === 'idle'), 1);
  const summary = await buildWorkspaceSummary(state, { extractInputFields });
  assert.match(summary, /"Split" \[split\]: reads the output of run "Run" \[r\] as df; branches kept, dropped; last output kept \(1 rows\), dropped \(0 rows\)/);
  assert.match(summary, /"Idle" \[idle\]: prompt "Extract" \[p\] on the output of process "Split" \[split\] branch "kept"/);
  assert.match(summary, /"Dynamic" \[dyn\]: reads "Raw" \[raw\] as df; branches are built at run time/);
});

test('try_process gives code the inputs a Process reading primary_input would get', () => {
  const code = 'def process(df, df_kept):\n    return df\n';
  const inputs = processTrialInputs(canvas(), code, 'r');
  assert.deepEqual(inputs.map(({ alias, label, primary }) => [alias, label, primary]), [['df', 'Extract', true], ['df_kept', 'Split · kept', false]]);
  assert.deepEqual(inputs[0].content.headers, ['Input: #', 'Input: text', 'Output: #', 'Output: answer']);
  assert.deepEqual(processTrialInputs(canvas(), 'def process(df):\n    return df\n', 'split', 'kept')[0].content.rows, [['A']]);
  assert.throws(() => processTrialInputs(canvas(), code, 'split'), /several branches \(kept, dropped\); name primary_branch/);
  assert.throws(() => processTrialInputs(canvas(), 'def process(df, df_nope):\n    return df\n', 'raw'), /Unknown input alias df_nope/);
  assert.throws(() => processTrialInputs(canvas(), 'def process(df):\n    return df\n', 'idle'), /Waiting for upstream results: run "Extract" first\./);
  assert.throws(() => processTrialInputs(canvas(), 'def process(df):\n    return df\n', 'p'), /primary_input must be the id of a dataset, run or process/);
});

test('run_nodes refuses a Process whose upstream has no result, with its window\'s message', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, json: async () => (String(url).includes('/api/settings') ? { python_path: 'python' } : { models: [] }) });
  try {
    const state = canvas();
    state.connections.push(data('idle', 'dyn', 'df_idle'));
    state.nodes.find((node) => node.nodeId === 'dyn').dfCode = 'def process(df, df_idle):\n    return df\n';
    const env = { getCanvasState: () => state, extractInputFields, credentialsById: new Map() };
    const refused = await previewRunRequest({ jobs: [{ kind: 'process', node: 'dyn' }] }, env);
    assert.deepEqual(refused, { ok: false, error: 'Job 1: Process "Dynamic": Waiting for upstream results: run "Extract" first.' });
    // A parameter nothing is connected to stops the run, as on the canvas.
    state.nodes.find((node) => node.nodeId === 'split').dfCode = 'def process(df, df_notes):\n    return df\n';
    const unconnected = await previewRunRequest({ jobs: [{ kind: 'process', node: 'split' }] }, env);
    assert.deepEqual(unconnected, { ok: false, error: 'Job 1: Process "Split": df_notes not connected; connect an input to each first.' });
    state.nodes.find((node) => node.nodeId === 'split').dfCode = 'def process(df):\n    return {"kept": df, "dropped": df.head(0)}\n';
    const ready = await previewRunRequest({ jobs: [{ kind: 'process', node: 'split' }] }, env);
    assert.equal(ready.ok, true);
    assert.deepEqual(ready.items[0].lines, ['Runs its Python code on "Extract" (no model calls).']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('select_history through the Agent switches a Process and the Run it read together', async () => {
  const recorded = await recordGraph(graph);
  const records = new Map(recorded.records.map((record) => [record.id, record]));
  const session = new RunHistorySession({
    loadIndex: async () => ({ version: 1, records: [...records.values()].map(({ id, nodeId, kind, signature, status }) => ({ id, nodeId, kind, signature, status })) }),
    loadRecord: async (_project, id) => records.get(id),
    saveRecord: async (_project, record) => { records.set(record.id, record); },
    saveCanvas: async () => {},
  });
  await session.open('project', recorded.state);
  const changed = structuredClone(recorded.state);
  changed.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0] = 'edited';
  const processRecord = recorded.records.find((record) => record.nodeId === 'process');
  const workspace = { previewHistorySelection: (id) => session.select(id, changed) };
  const preview = await previewProposal({ operations: [{ op: 'select_history', record_id: processRecord.id }] }, workspace);
  assert.equal(preview.ok, true);
  assert.deepEqual(new Set(preview.items[0].nodeIds), new Set(['input', 'run', 'process']));
  const selected = await session.select(processRecord.id, changed);
  assert.deepEqual(selected.currentRecordIds, Object.fromEntries(recorded.records.map((record) => [record.nodeId, record.id])));
});
