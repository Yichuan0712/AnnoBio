import test from 'node:test';
import assert from 'node:assert/strict';
import { planChangeSet } from '../src/agent/operations/changeSet.js';
import { inspectWorkflowNode } from '../src/agent/canvas/workflowNodeInspector.js';
import { checkConnect, checkDisconnect } from '../src/nodePorts.js';
import { parseScoreMappingBundle, serializeScoreMappingBundle } from '../src/scoreMappingBundle.js';
import { processInputSources, runInputSource } from '../src/stepInputs.js';
import { extractInputFields } from '../src/promptText.js';

const data = (fromId, toId, alias, fromPort = 'result') => ({ type: 'data', fromId, fromPort, toId, ...(alias ? { alias } : {}) });
const table = (headers, rows) => ({ headers, rows, columnTypes: headers.map(() => 'text') });
const rule = (outputKey, gtColumns) => ({ type: 'rule', outputKey, gtColumns, matchType: 'exact', matchFlags: {} });

// Raw → Extract (r, completed) → Split (kept / dropped) → Merge (df = kept, df_raw = Raw); Idle reads Raw;
// Score of Extract against Gold. The Agent's connect and disconnect follow the canvas rules (nodePorts.js).
const canvas = () => ({
  historyVersion: 1,
  nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: table(['text'], [['a'], ['b']]) },
    { type: 'dataset', nodeId: 'gold', name: 'Gold', datasetContent: table(['text', 'label'], [['a', 'x']]) },
    { type: 'dataset', nodeId: 'other', name: 'Other', datasetContent: table(['body'], [['c']]) },
    { type: 'prompt', nodeId: 'p', name: 'Extract', text: 'Read {text}',
      outputFormat: { returnShape: 'single', fields: [{ key: 'answer', type: 'str' }] }, inputTypes: {} },
    { type: 'prompt', nodeId: 'q', name: 'Judge', text: 'Judge {answer}',
      outputFormat: { returnShape: 'single', fields: [{ key: 'verdict', type: 'str' }] }, inputTypes: {} },
    { type: 'run', nodeId: 'r', runName: 'Run', runCompleted: '1', runInputToColumn: JSON.stringify({ text: 'text' }),
      runResults: JSON.stringify([{ row_index: 0, input_row_index: 0, output: { answer: 'A' } }]) },
    { type: 'run', nodeId: 'idle', runName: 'Idle', runInputToColumn: JSON.stringify({ text: 'text' }) },
    { type: 'process', nodeId: 'split', name: 'Split',
      dfCode: 'def process(df):\n    return {"kept": df, "dropped": df.head(0)}\n',
      processOutputPorts: { ports: ['kept', 'dropped'], dynamic: false, error: '', codeHash: 'h' },
      dfResults: JSON.stringify({ outputs: { kept: table(['answer'], [['A']]), dropped: table(['answer'], []) } }) },
    { type: 'process', nodeId: 'merge', name: 'Merge', dfCode: 'def process(df, df_raw, df_notes):\n    return df\n',
      processOutputPorts: { ports: ['result'], dynamic: false, error: '', codeHash: 'h2' } },
    { type: 'score', nodeId: 's', scoreName: 'Score', scoreGroundTruthId: 'gold',
      scoreMapping: JSON.parse(serializeScoreMappingBundle({ type: 'group', ops: [], children: [rule('[text]', ['text'])] }, { type: 'group', ops: [], children: [rule('answer', ['label'])] })) },
  ],
  connections: [
    { type: 'prompt-to-run', fromId: 'p', toId: 'r' }, data('raw', 'r'),
    { type: 'prompt-to-run', fromId: 'p', toId: 'idle' }, data('raw', 'idle'),
    data('r', 'split', 'df'), data('split', 'merge', 'df', 'kept'), data('raw', 'merge', 'df_raw'),
    { type: 'run-to-score', fromId: 'r', toId: 's' },
  ],
});
const plan = (operations, state = canvas()) => planChangeSet(state, operations, { extractInputFields });
const nodeOf = (state, id) => state.nodes.find((node) => node.nodeId === id);

test('connect points a Generate at another input, as dragging a line onto its input does', () => {
  const result = plan([{ op: 'connect', node: 'idle', input: 'input', source: 'split', branch: 'kept' }]);
  assert.deepEqual(runInputSource(result.state, 'idle'), { nodeId: 'split', port: 'kept', kind: 'process' });
  assert.equal(result.items[0].title, 'Connect Generate "Idle"');
  assert.equal(result.items[0].lines[0], 'input reads "Split · kept" instead of "Raw"');
  // The mapping keeps only the columns the new table has, as on the canvas.
  assert.equal(nodeOf(result.state, 'idle').runInputToColumn, '{}');
  assert.match(result.items[0].lines[1], /^Mapping:/);
});

test('connect gives a Generate another Prompt and keeps the mapping of the inputs they share', () => {
  const result = plan([{ op: 'connect', node: 'idle', input: 'prompt', source: 'q' }]);
  assert.deepEqual(result.state.connections.filter((edge) => edge.type === 'prompt-to-run' && edge.toId === 'idle').map((edge) => edge.fromId), ['q']);
  assert.equal(result.items[0].lines[0], 'prompt reads "Judge" instead of "Extract"');
  assert.equal(nodeOf(result.state, 'idle').runInputToColumn, '{}');
});

test('connect fills an empty parameter, and + adds an input with its parameter', () => {
  const filled = plan([{ op: 'connect', node: 'merge', input: 'df_notes', source: 'gold' }]);
  assert.equal(processInputSources(filled.state, 'merge').find((source) => source.alias === 'df_notes').nodeId, 'gold');
  assert.deepEqual(filled.items[0].diffs, []);

  const added = plan([{ op: 'connect', node: 'merge', input: '+', source: 'other' }]);
  assert.equal(nodeOf(added.state, 'merge').dfCode, 'def process(df, df_raw, df_notes, df_other):\n    return df\n');
  assert.deepEqual(added.items[0].lines, ['df_other reads "Other"', "df_other is added to process()'s parameters."]);
  assert.equal(added.items[0].diffs[0].label, 'Code');
  // Its code changed in this proposal, so its branches cannot be read yet.
  assert.throws(() => plan([{ op: 'connect', node: 'merge', input: '+', source: 'other' }, { op: 'connect', node: 'idle', input: 'input', source: 'merge' }]),
    /is added or changed in this proposal/);
});

test('connect sets a Score\'s ground truth and drops the rules on columns it lacks', () => {
  const result = plan([{ op: 'connect', node: 's', input: 'ground_truth', source: 'raw' }]);
  assert.equal(nodeOf(result.state, 's').scoreGroundTruthId, 'raw');
  const bundle = parseScoreMappingBundle(nodeOf(result.state, 's').scoreMapping);
  assert.deepEqual(bundle.inputRoot.children.map((item) => item.gtColumns), [['text']]);
  assert.deepEqual(bundle.outputRoot.children, []);
  // update ground_truth goes the same way.
  const updated = plan([{ op: 'update', node: 's', set: { ground_truth: 'raw' } }]);
  assert.deepEqual(parseScoreMappingBundle(nodeOf(updated.state, 's').scoreMapping).outputRoot.children, []);
});

test('connect refuses what dragging refuses, with the same reason', () => {
  const state = canvas();
  const sameSource = checkConnect(state, { nodeId: 'raw', portId: 'result' }, { nodeId: 'merge', portId: 'df_notes' }).reason;
  assert.equal(sameSource, 'Already df_raw of this Process; disconnect it there first.');
  assert.throws(() => plan([{ op: 'connect', node: 'merge', input: 'df_notes', source: 'raw' }]), new RegExp(`Merge: ${sameSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.throws(() => plan([{ op: 'connect', node: 's', input: 'run', source: 'idle' }]), /An Evaluate node compares the results of the Generate it was created from/);
  assert.throws(() => plan([{ op: 'connect', node: 'r', input: 'input', source: 'split', branch: 'kept' }]), /would make a loop/);
  assert.throws(() => plan([{ op: 'connect', node: 'idle', input: 'prompt', source: 'raw' }]), /is a Dataset, not a Prompt/);
  assert.throws(() => plan([{ op: 'connect', node: 'idle', input: 'nothing', source: 'raw' }]), /has no input "nothing"\. Its inputs: prompt, input/);
});

test('disconnect leaves an input empty, and a parameter goes with its input', () => {
  const run = plan([{ op: 'disconnect', node: 'idle', input: 'input' }]);
  assert.equal(runInputSource(run.state, 'idle'), null);
  assert.equal(run.items[0].lines[0], 'input no longer reads "Raw"; it stays empty until something is connected.');

  const prompt = plan([{ op: 'disconnect', node: 'idle', input: 'prompt' }]);
  assert.deepEqual(prompt.items[0].lines, ['prompt no longer reads "Extract"; it stays empty until something is connected.', 'Its column mapping is cleared.']);

  const alias = plan([{ op: 'disconnect', node: 'merge', input: 'df_raw' }]);
  assert.equal(nodeOf(alias.state, 'merge').dfCode, 'def process(df, df_notes):\n    return df\n');
  assert.deepEqual(processInputSources(alias.state, 'merge').map((source) => source.alias), ['df']);
  assert.equal(alias.items[0].lines[1], "df_raw is removed from process()'s parameters.");

  const gt = plan([{ op: 'disconnect', node: 's', input: 'ground_truth' }]);
  assert.equal(nodeOf(gt.state, 's').scoreGroundTruthId, '');
});

test('disconnect refuses what dragging refuses', () => {
  const state = canvas();
  nodeOf(state, 'merge').dfCode = 'def process(df, df_raw):\n    return df.merge(df_raw)\n';
  assert.throws(() => plan([{ op: 'disconnect', node: 'merge', input: 'df_raw' }], state),
    new RegExp(checkDisconnect(state, { nodeId: 'merge', portId: 'df_raw' }).reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.throws(() => plan([{ op: 'disconnect', node: 'merge', input: 'df' }]), /df cannot be empty while this Process has other inputs/);
  assert.throws(() => plan([{ op: 'disconnect', node: 's', input: 'run' }]), /An Evaluate node compares the results of the Generate it was created from/);
  assert.throws(() => plan([{ op: 'disconnect', node: 'merge', input: 'df_notes' }]), /This input is not connected/);
});

test('inspect_node lists the ports connect and disconnect use', () => {
  const merge = inspectWorkflowNode(canvas(), 'merge', { extractInputFields });
  assert.deepEqual(merge.ports.inputs.map((input) => [input.id, input.source?.title || null]), [['df', 'Split'], ['df_raw', 'Raw'], ['df_notes', null], ['+', null]]);
  assert.equal(merge.ports.inputs[0].source.branch, 'kept');
  assert.deepEqual(merge.ports.outputs.map((output) => output.id), ['result']);
  const score = inspectWorkflowNode(canvas(), 's', { extractInputFields });
  assert.match(score.ports.inputs[0].fixed, /Generate it was created from/);
  const raw = inspectWorkflowNode(canvas(), 'raw', { extractInputFields });
  assert.deepEqual(raw.ports.outputs[0].readBy.map((reader) => `${reader.nodeId}.${reader.portId}`), ['r.input', 'idle.input', 'merge.df_raw']);
});
