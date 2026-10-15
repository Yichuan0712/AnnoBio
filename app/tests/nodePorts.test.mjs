import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADD_INPUT_PORT, PORT_TYPES, applyPortOp, checkConnect, checkDisconnect, derivedEdges, edgeEndpoints, keepMappedColumns, keepSharedMapping, nodePorts,
  portLayout, portTitles, unconnectedProcessInputs,
} from '../src/nodePorts.js';
import { buildDefaultProcessCode, isUntouchedSampleCode } from '../src/processSampleCode.js';
import { withProcessParameters } from '../src/processSignature.js';
import { parseScoreMappingBundle, scoreMappingForGroundTruth, serializeScoreMappingBundle } from '../src/scoreMappingBundle.js';
import { DATA_EDGE, RESULT_PORT, processInputSources, runInputSource } from '../src/stepInputs.js';

const data = (fromId, toId, alias, fromPort = RESULT_PORT) => ({ type: DATA_EDGE, fromId, fromPort, toId, ...(alias ? { alias } : {}) });
const edge = (type, fromId, toId) => ({ type, fromId, toId });
const detected = (ports, extra = {}) => ({ ports, dynamic: false, error: '', codeHash: 'h', ...extra });
const table = (headers) => ({ headers, rows: [headers.map((header) => `${header}-1`)] });
const rule = (outputKey, gtColumns) => ({ type: 'rule', outputKey, gtColumns, matchType: 'exact', matchFlags: {} });
const group = (...children) => ({ type: 'group', ops: children.slice(1).map(() => 'AND'), children });

/**
 * One canvas with every node type: Abstracts → Run "Extract" (Prompt v1) → Split (two branches);
 * Merge reads Split's "ready" branch as df and Abstracts as df_abstracts; a Score of Extract against
 * Gold, its Review, a Sampler with its sample, and the lineage lines of each kind.
 */
const canvas = () => ({
  version: 3,
  historyVersion: 1,
  nodes: [
    { type: 'dataset', nodeId: 'abstracts', name: 'Abstracts', datasetContent: table(['pmid', 'text']) },
    { type: 'dataset', nodeId: 'gold', name: 'Gold', datasetContent: table(['pmid', 'kinase']) },
    { type: 'dataset', nodeId: 'sample', name: 'Sample 20', samplerNodeId: 'sampler', datasetContent: table(['pmid', 'text']) },
    { type: 'dataset', nodeId: 'saved', name: 'Saved', savedFrom: { kind: 'run', nodeId: 'extract', port: 'result', recordId: 'r1' }, datasetContent: table(['kinase']) },
    { type: 'sampler', nodeId: 'sampler', name: 'Sample', sourceNodeId: 'abstracts' },
    { type: 'prompt', nodeId: 'v1', name: 'Extract v1', sections: [] },
    { type: 'prompt', nodeId: 'v2', name: 'Extract v2', sections: [] },
    { type: 'prompt', nodeId: 'v3', name: 'Extract v3', sections: [] },
    { type: 'run', nodeId: 'extract', runName: 'Run', runInputToColumn: JSON.stringify({ text: 'text', id: 'pmid' }) },
    { type: 'process', nodeId: 'split', name: 'Split', processOutputPorts: detected(['ready', 'rewrite']), dfCode: 'def process(df):\n    return {"ready": df, "rewrite": df}\n' },
    { type: 'process', nodeId: 'merge', name: 'Merge', processOutputPorts: detected(['result']), dfCode: 'def process(df, df_abstracts):\n    return df\n' },
    { type: 'process', nodeId: 'dyn', name: 'Dyn', processOutputPorts: detected([], { dynamic: true }) },
    { type: 'process', nodeId: 'fresh', name: 'Fresh' },
    { type: 'process', nodeId: 'other', name: 'Other', processOutputPorts: detected(['out']) },
    { type: 'score', nodeId: 'score', scoreName: 'Score', scoreGroundTruthId: 'gold' },
    { type: 'promptReview', nodeId: 'review', name: 'Review' },
  ],
  connections: [
    edge('dataset-to-sampler', 'abstracts', 'sampler'),
    edge('sampler-to-dataset', 'sampler', 'sample'),
    edge('prompt-to-prompt', 'v1', 'v2'),
    edge('prompt-to-run', 'v1', 'extract'),
    data('abstracts', 'extract'),
    data('extract', 'split', 'df'),
    data('split', 'merge', 'df', 'ready'),
    data('abstracts', 'merge', 'df_abstracts'),
    edge('run-to-score', 'extract', 'score'),
    edge('score-to-prompt-review', 'score', 'review'),
    edge('prompt-review-to-prompt', 'review', 'v3'),
  ],
});

const ids = (ports) => ports.map((item) => item.id);
const at = (nodeId, portId) => ({ nodeId, portId });

// ---------- ports ----------

test('each node type has its inputs on the left and outputs on the right', () => {
  const state = canvas();
  const run = nodePorts(state, 'extract');
  assert.deepEqual(ids(run.inputs), ['prompt', 'input']);
  assert.deepEqual(run.inputs.map((item) => item.type), [PORT_TYPES.PROMPT, PORT_TYPES.TABLE]);
  assert.deepEqual(run.inputs[0].source, { nodeId: 'v1', port: 'prompt', kind: 'prompt' });
  assert.deepEqual(run.inputs[1].source, { nodeId: 'abstracts', port: RESULT_PORT, kind: 'dataset' });
  assert.deepEqual(ids(run.outputs), ['result']);

  assert.deepEqual(ids(nodePorts(state, 'abstracts').inputs), []);
  assert.deepEqual(ids(nodePorts(state, 'abstracts').outputs), ['result']);
  assert.deepEqual(nodePorts(state, 'v1').outputs.map((item) => [item.id, item.type]), [['prompt', PORT_TYPES.PROMPT]]);

  const merge = nodePorts(state, 'merge');
  assert.deepEqual(ids(merge.inputs), ['df', 'df_abstracts', '+']);
  assert.deepEqual(merge.inputs[0].source, { nodeId: 'split', port: 'ready', kind: 'process' });
  assert.deepEqual(ids(nodePorts(state, 'split').outputs), ['ready', 'rewrite']);

  const score = nodePorts(state, 'score');
  assert.deepEqual(ids(score.inputs), ['run', 'ground_truth']);
  assert.deepEqual(score.inputs[1].source, { nodeId: 'gold', port: RESULT_PORT, kind: 'dataset' });
  assert.deepEqual(score.outputs.map((item) => [item.id, item.type]), [['score', PORT_TYPES.SCORE]]);
  assert.deepEqual(nodePorts(state, 'review').inputs.map((item) => [item.id, item.type]), [['score', PORT_TYPES.SCORE]]);
  assert.deepEqual(ids(nodePorts(state, 'review').outputs), []);
  assert.equal(nodePorts(state, 'review').lineageOutput.label, 'New prompt');
  assert.equal(nodePorts(state, 'review').lineageOutput.icon, PORT_TYPES.PROMPT);
  assert.deepEqual(nodePorts(state, 'sampler').inputs[0].source, { nodeId: 'abstracts', port: RESULT_PORT, kind: 'dataset' });
  assert.equal(nodePorts(state, 'sampler').inputs[0].hollow, true);
  assert.deepEqual(ids(nodePorts(state, 'sampler').outputs), []);
  assert.equal(nodePorts(state, 'missing'), null);
});

test('the inputs fixed when a node is created say why', () => {
  const state = canvas();
  assert.match(nodePorts(state, 'score').inputs[0].fixed, /Run it was created from/);
  assert.equal(nodePorts(state, 'score').inputs[0].hollow, true);
  assert.equal(nodePorts(state, 'score').inputs[1].fixed, undefined);
  assert.equal(nodePorts(state, 'score').inputs[1].hollow, undefined);
  assert.equal(nodePorts(state, 'score').outputs[0].hollow, undefined);
  assert.match(nodePorts(state, 'review').inputs[0].fixed, /Evaluate node it was created from/);
  assert.equal(nodePorts(state, 'review').inputs[0].hollow, true);
  assert.match(nodePorts(state, 'sampler').inputs[0].fixed, /Dataset it was created from/);
  assert.equal(nodePorts(state, 'extract').inputs.some((item) => item.fixed), false);
});

test('a Process with no known branches offers an output nothing can read yet', () => {
  const state = canvas();
  const dyn = nodePorts(state, 'dyn').outputs;
  assert.deepEqual(dyn.map((item) => [item.id, item.label]), [['result', 'dynamic outputs']]);
  assert.match(dyn[0].unavailable, /once the Process has run/);
  assert.match(nodePorts(state, 'fresh').outputs[0].unavailable, /not known yet/);
  assert.equal(nodePorts(state, 'merge').outputs[0].unavailable, undefined);
  assert.deepEqual(ids(nodePorts(state, 'fresh').inputs), ['df', '+']);
  assert.equal(nodePorts(state, 'fresh').inputs[0].source, null);
});

test('steps show all port labels, while single Dataset and Prompt ports stay unnamed', () => {
  const state = canvas();
  const shown = (nodeId, side) => nodePorts(state, nodeId)[side].map((item) => item.showLabel);
  assert.deepEqual(shown('extract', 'inputs'), [true, true]);
  assert.deepEqual(shown('extract', 'outputs'), [true]);
  assert.deepEqual(shown('abstracts', 'outputs'), [false]);
  assert.deepEqual(shown('v1', 'outputs'), [false]);
  assert.deepEqual(shown('split', 'inputs'), [true, true]);
  assert.deepEqual(shown('split', 'outputs'), [true, true]);
  assert.deepEqual(shown('merge', 'outputs'), [true]);
  assert.deepEqual(shown('dyn', 'outputs'), [true]);
  assert.deepEqual(shown('score', 'inputs'), [true, true]);
  assert.deepEqual(shown('score', 'outputs'), [true]);
  assert.deepEqual(shown('review', 'inputs'), [true]);
});

test('an output lists the input ports that read it', () => {
  const state = canvas();
  assert.deepEqual(nodePorts(state, 'abstracts').outputs[0].readers, [at('extract', 'input'), at('merge', 'df_abstracts')]);
  assert.deepEqual(nodePorts(state, 'extract').outputs[0].readers, [at('split', 'df')]);
  assert.deepEqual(nodePorts(state, 'gold').outputs[0].readers, [at('score', 'ground_truth')]);
  assert.deepEqual(nodePorts(state, 'split').outputs.map((item) => item.readers), [[at('merge', 'df')], []]);
});

test('steps show source names and icons while preserving port ids, aliases and hover details', () => {
  const state = canvas();
  const run = nodePorts(state, 'extract');
  assert.deepEqual(run.inputs.map((item) => [item.id, item.displayLabel, item.icon]), [
    ['prompt', 'Extract v1', 'prompt'], ['input', 'Abstracts', 'table'],
  ]);
  assert.equal(run.outputs[0].displayLabel, 'Output');
  assert.equal(run.outputs[0].icon, PORT_TYPES.TABLE);
  const merge = nodePorts(state, 'merge');
  assert.deepEqual(merge.inputs.map((item) => [item.id, item.displayLabel, item.icon]), [
    ['df', 'Split · ready', 'table'], ['df_abstracts', 'Abstracts', 'table'], [ADD_INPUT_PORT, 'Add input', undefined],
  ]);
  assert.equal(portTitles(state, 'merge', merge).inputs.df_abstracts, 'Input: Abstracts');
  assert.equal(checkConnect(state, at('gold', RESULT_PORT), at('merge', 'df_abstracts')).ok, true);
  assert.deepEqual(nodePorts(state, 'split').outputs.map((item) => item.displayLabel), ['ready', 'rewrite']);
  assert.deepEqual(nodePorts(state, 'split').outputs.map((item) => item.icon), [PORT_TYPES.TABLE, PORT_TYPES.TABLE]);
  assert.equal(nodePorts(state, 'other').outputs[0].displayLabel, 'out');
  assert.equal(nodePorts(state, 'merge').outputs[0].displayLabel, 'Output');
  assert.equal(nodePorts(state, 'dyn').outputs[0].displayLabel, 'Dynamic outputs');
  assert.equal(nodePorts(state, 'fresh').outputs[0].displayLabel, 'Outputs unknown');
  const evaluate = nodePorts(state, 'score');
  assert.deepEqual(evaluate.inputs.map((item) => [item.id, item.displayLabel, item.icon]), [
    ['run', 'Run', 'run'], ['ground_truth', 'Gold', 'table'],
  ]);
  assert.equal(evaluate.outputs[0].displayLabel, 'Output');
  assert.equal(evaluate.outputs[0].icon, PORT_TYPES.TABLE);
  assert.equal(portTitles(state, 'score', evaluate).outputs.score, 'Output: Evaluation results');
  const optimize = nodePorts(state, 'review');
  assert.deepEqual(optimize.inputs.map((item) => [item.id, item.displayLabel, item.icon]), [['score', 'Score', 'evaluate']]);
});

test('disconnected inputs have readable placeholders and type-based hover text while code parameter ids remain', () => {
  const state = canvas();
  state.nodes.push({ type: 'run', nodeId: 'empty-run' });
  const run = nodePorts(state, 'empty-run');
  assert.deepEqual(run.inputs.map((item) => [item.displayLabel, item.unconnected]), [['Connect prompt', true], ['Connect data', true]]);
  assert.deepEqual(portTitles(state, 'empty-run', run).inputs, { prompt: 'Input: Not connected', input: 'Input: Not connected' });
  const fresh = state.nodes.find((node) => node.nodeId === 'fresh');
  fresh.dfCode = 'def process(df, df_reference_genes):\n    return df\n';
  const ports = nodePorts(state, 'fresh');
  assert.deepEqual(ports.inputs.map((item) => item.id), ['df', 'df_reference_genes', ADD_INPUT_PORT]);
  assert.deepEqual(ports.inputs.map((item) => item.displayLabel), ['Connect data', 'Connect reference genes', 'Add input']);
  assert.equal(portTitles(state, 'fresh', ports).inputs.df_reference_genes, 'Input: Not connected');
  assert.deepEqual(unconnectedProcessInputs(state, 'fresh'), ['df_reference_genes']);
});

test('source labels refresh after rename and replacement without rewriting Process parameter aliases', () => {
  const state = canvas();
  state.nodes.find((node) => node.nodeId === 'abstracts').name = 'Renamed abstracts';
  state.nodes.find((node) => node.nodeId === 'v1').name = 'Extract proteins';
  assert.deepEqual(nodePorts(state, 'extract').inputs.map((item) => item.displayLabel), ['Extract proteins', 'Renamed abstracts']);
  assert.equal(nodePorts(state, 'split').inputs[0].displayLabel, 'Run');
  state.nodes.find((node) => node.nodeId === 'extract').runName = 'Kinase extraction';
  assert.equal(nodePorts(state, 'split').inputs[0].displayLabel, 'Kinase extraction');
  assert.equal(nodePorts(state, 'score').inputs[0].displayLabel, 'Kinase extraction');
  state.nodes.find((node) => node.nodeId === 'score').scoreName = 'Accuracy check';
  assert.equal(nodePorts(state, 'review').inputs[0].displayLabel, 'Accuracy check');
  assert.equal(nodePorts(state, 'merge').inputs[1].id, 'df_abstracts');
  assert.equal(nodePorts(state, 'merge').inputs[1].displayLabel, 'Renamed abstracts');
  const replacement = checkConnect(state, at('gold', RESULT_PORT), at('merge', 'df_abstracts'));
  assert.equal(replacement.ok, true);
  applyPortOp(state, replacement.op);
  assert.equal(nodePorts(state, 'merge').inputs[1].displayLabel, 'Gold');
  assert.match(state.nodes.find((node) => node.nodeId === 'merge').dfCode, /df_abstracts/);
});

test('Evaluate and Optimize identify their Prompt and follow renames, version changes and missing inputs', () => {
  const state = canvas();
  const context = (nodeId) => nodePorts(state, nodeId).promptContext;
  const expected = { nodeId: 'v1', name: 'Extract v1' };
  assert.deepEqual(context('score'), expected);
  assert.deepEqual(context('review'), expected);
  assert.equal(context('extract'), undefined);
  state.nodes.find((node) => node.nodeId === 'v1').name = 'Extract kinase pairs';
  assert.equal(context('score').name, 'Extract kinase pairs');
  assert.equal(context('review').name, 'Extract kinase pairs');
  state.connections.find((edge) => edge.type === 'prompt-to-run').fromId = 'v2';
  assert.deepEqual(context('score'), { nodeId: 'v2', name: 'Extract v2' });
  assert.deepEqual(context('review'), context('score'));
  state.connections = state.connections.filter((edge) => edge.type !== 'prompt-to-run');
  assert.deepEqual(context('score'), { nodeId: '', name: 'Not connected' });
  assert.deepEqual(context('review'), context('score'));
});

test('hollow dots appear where a node came from or something was made from it', () => {
  const state = canvas();
  const lineage = (nodeId) => {
    const ports = nodePorts(state, nodeId);
    return [ports.lineageIn, ports.lineageOut];
  };
  assert.deepEqual(lineage('v1'), [false, true]);
  assert.deepEqual(lineage('v2'), [true, false]);
  assert.deepEqual(lineage('v3'), [true, false]);
  assert.deepEqual(lineage('review'), [false, true]);
  assert.deepEqual(lineage('score'), [false, true]);
  assert.deepEqual(lineage('sampler'), [false, true]);
  assert.deepEqual(lineage('sample'), [true, false]);
  assert.deepEqual(lineage('saved'), [true, false]);
  assert.deepEqual(lineage('extract'), [false, true]);
  assert.deepEqual(lineage('abstracts'), [false, true]);
  // The Evaluate relation alone keeps a hollow Run output, independently of saved datasets.
  state.nodes = state.nodes.filter((node) => node.nodeId !== 'saved');
  assert.deepEqual(lineage('extract'), [false, true]);
  assert.equal(nodePorts(state, 'extract').outputs[0].hollow, undefined);
  state.connections = state.connections.filter((edge) => edge.type !== 'run-to-score');
  assert.deepEqual(lineage('extract'), [false, false]);
});

// ---------- edges ----------

test('every kind of connection joins the ports of the table in the plan', () => {
  const state = canvas();
  const ends = (item) => {
    const found = edgeEndpoints(state, item);
    return found && [found.from.portId ?? 'lineage', found.to.portId ?? 'lineage'];
  };
  assert.deepEqual(ends(edge('prompt-to-run', 'v1', 'extract')), ['prompt', 'prompt']);
  assert.deepEqual(ends(data('abstracts', 'extract')), ['result', 'input']);
  assert.deepEqual(ends(data('extract', 'split', 'df')), ['result', 'df']);
  assert.deepEqual(ends(data('split', 'merge', 'df', 'ready')), ['ready', 'df']);
  assert.deepEqual(ends(data('abstracts', 'merge', 'df_abstracts')), ['result', 'df_abstracts']);
  assert.deepEqual(ends(edge('run-to-score', 'extract', 'score')), ['lineage', 'run']);
  assert.deepEqual(ends(edge('ground-truth-to-score', 'gold', 'score')), ['result', 'ground_truth']);
  assert.deepEqual(ends(edge('score-to-prompt-review', 'score', 'review')), ['lineage', 'score']);
  assert.deepEqual(ends(edge('dataset-to-sampler', 'abstracts', 'sampler')), ['lineage', 'source']);
  for (const type of ['prompt-to-prompt', 'prompt-review-to-prompt', 'dataset-to-dataset', 'sampler-to-dataset', 'saved-from']) {
    assert.deepEqual(ends(edge(type, 'v1', 'v2')), ['lineage', 'lineage'], type);
  }
  assert.equal(edgeEndpoints(state, edge('prompt-to-run', 'gone', 'extract')), null);
  assert.equal(edgeEndpoints(state, edge('mystery', 'v1', 'v2')), null);
});

test('the ground truth and saved-from lines come from node fields, once', () => {
  const state = canvas();
  assert.deepEqual(derivedEdges(state).map((item) => [item.type, item.fromId, item.toId]), [
    ['saved-from', 'extract', 'saved'],
    ['ground-truth-to-score', 'gold', 'score'],
  ]);
  state.nodes.find((node) => node.nodeId === 'score').scoreGroundTruthId = 'gone';
  state.connections.push(edge('saved-from', 'extract', 'saved'));
  assert.deepEqual(derivedEdges(state), []);
});

// ---------- connecting ----------

test('a connection that passes every check comes with the op that makes it', () => {
  const state = canvas();
  assert.deepEqual(checkConnect(state, at('gold', 'result'), at('extract', 'input')),
    { ok: true, op: { type: 'run-input', runId: 'extract', source: { nodeId: 'gold', port: 'result', kind: 'dataset' } } });
  assert.deepEqual(checkConnect(state, at('v2', 'prompt'), at('extract', 'prompt')),
    { ok: true, op: { type: 'run-prompt', runId: 'extract', promptId: 'v2' } });
  assert.deepEqual(checkConnect(state, at('gold', 'result'), at('split', 'df')).op.type, 'process-df');
  assert.deepEqual(checkConnect(state, at('gold', 'result'), at('merge', 'df_abstracts')).op, {
    type: 'process-alias', processId: 'merge', alias: 'df_abstracts',
    from: { nodeId: 'abstracts', port: 'result', kind: 'dataset' }, source: { nodeId: 'gold', port: 'result', kind: 'dataset' },
  });
  assert.deepEqual(checkConnect(state, at('abstracts', 'result'), at('score', 'ground_truth')).op,
    { type: 'score-ground-truth', scoreId: 'score', datasetId: 'abstracts' });
  assert.deepEqual(checkConnect(state, at('split', 'rewrite'), at('fresh', 'df')).op.source, { nodeId: 'split', port: 'rewrite', kind: 'process' });
});

test('connecting what an input already reads changes nothing', () => {
  const state = canvas();
  assert.deepEqual(checkConnect(state, at('abstracts', 'result'), at('extract', 'input')), { ok: true, op: null });
  assert.deepEqual(checkConnect(state, at('v1', 'prompt'), at('extract', 'prompt')), { ok: true, op: null });
  assert.deepEqual(checkConnect(state, at('split', 'ready'), at('merge', 'df')), { ok: true, op: null });
});

test('each refused connection says why', () => {
  const state = canvas();
  const reason = (from, to, options) => {
    const result = checkConnect(state, from, to, options);
    assert.equal(result.ok, false);
    return result.reason;
  };
  assert.equal(reason(at('gone', 'result'), at('extract', 'input')), 'There is no such output.');
  assert.equal(reason(at('abstracts', 'result'), at('extract', 'nothing')), 'There is no such input.');
  assert.equal(reason(at('v1', 'prompt'), at('split', 'df')), 'The df input takes a table, not a Prompt.');
  assert.equal(reason(at('abstracts', 'result'), at('extract', 'prompt')), 'The prompt input takes a Prompt, not a table.');
  assert.equal(reason(at('score', 'score'), at('extract', 'input')), 'The input input takes a table, not an Evaluate node.');
  assert.match(reason(at('gold', 'result'), at('score', 'run')), /Run it was created from/);
  assert.match(reason(at('v1', 'prompt'), at('review', 'score')), /takes an Evaluate node, not a Prompt/);
  assert.equal(reason(at('extract', 'result'), at('score', 'ground_truth')), 'The ground truth must be a Dataset.');
  assert.match(reason(at('dyn', 'result'), at('extract', 'input')), /once the Process has run/);
  assert.equal(reason(at('split', 'rewrite'), at('split', 'df')), 'A step cannot read its own output.');
  assert.equal(reason(at('merge', 'result'), at('extract', 'input')), 'This would make a loop: "Merge" already reads "Extract v1".');
  assert.equal(reason(at('abstracts', 'result'), at('merge', 'df')), 'Already df_abstracts of this Process; disconnect it there first.');
  assert.equal(reason(at('gold', 'result'), at('fresh', 'df'), { running: new Set(['fresh']) }), '"Fresh" is running. Stop it before changing its inputs.');
});

test('a running step keeps its inputs, as its window does', () => {
  const state = canvas();
  state.nodes.find((node) => node.nodeId === 'extract').runPending = true;
  state.nodes.find((node) => node.nodeId === 'merge').processPending = true;
  assert.match(checkConnect(state, at('gold', 'result'), at('extract', 'input')).reason, /"Extract v1" is running/);
  assert.match(checkConnect(state, at('gold', 'result'), at('merge', 'df_abstracts')).reason, /"Merge" is running/);
  assert.match(checkDisconnect(state, at('extract', 'input')).reason, /is running/);
});

test('without History, a Run with results keeps its prompt and input', () => {
  const state = canvas();
  delete state.historyVersion;
  const run = state.nodes.find((node) => node.nodeId === 'extract');
  run.runResults = JSON.stringify([{ row_index: 0, output: { kinase: 'AKT1' } }]);
  assert.match(checkConnect(state, at('gold', 'result'), at('extract', 'input')).reason, /already has results/);
  assert.match(checkConnect(state, at('v2', 'prompt'), at('extract', 'prompt')).reason, /already has results/);
  assert.match(checkDisconnect(state, at('extract', 'prompt')).reason, /already has results/);
  state.historyVersion = 1;
  assert.equal(checkConnect(state, at('gold', 'result'), at('extract', 'input')).ok, true);
});

// ---------- disconnecting ----------

test('an input can be left empty, except where the plan keeps it', () => {
  const state = canvas();
  assert.deepEqual(checkDisconnect(state, at('extract', 'input')), { ok: true, op: { type: 'run-input', runId: 'extract', source: null } });
  assert.deepEqual(checkDisconnect(state, at('extract', 'prompt')), { ok: true, op: { type: 'run-prompt', runId: 'extract', promptId: '' } });
  assert.deepEqual(checkDisconnect(state, at('score', 'ground_truth')), { ok: true, op: { type: 'score-ground-truth', scoreId: 'score', datasetId: '' } });
  assert.deepEqual(checkDisconnect(state, at('split', 'df')), { ok: true, op: { type: 'process-df', processId: 'split', source: null } });
  assert.match(checkDisconnect(state, at('score', 'run')).reason, /Run it was created from/);
  assert.match(checkDisconnect(state, at('review', 'score')).reason, /Evaluate node it was created from/);
  assert.match(checkDisconnect(state, at('sampler', 'source')).reason, /Dataset it was created from/);
  assert.deepEqual(checkDisconnect(state, at('merge', 'df_abstracts')).op, { type: 'process-alias-remove', processId: 'merge', alias: 'df_abstracts' });
  assert.match(checkDisconnect(state, at('merge', 'df')).reason, /df cannot be empty while this Process has other inputs/);
  assert.equal(checkDisconnect(state, at('fresh', 'df')).reason, 'This input is not connected.');
  assert.equal(checkDisconnect(state, at('extract', 'nothing')).reason, 'There is no such input.');
});

// ---------- applying ----------

const nodeOf = (state, nodeId) => state.nodes.find((node) => node.nodeId === nodeId);
const apply = (state, from, to, options) => {
  const result = checkConnect(state, from, to);
  assert.equal(result.ok, true, result.reason);
  return applyPortOp(state, result.op, options);
};

test('a new input keeps only the mapped columns its table has', () => {
  const state = canvas();
  const connections = state.connections;
  const fields = apply(state, at('gold', 'result'), at('extract', 'input'));
  assert.equal(state.connections, connections);
  assert.deepEqual(runInputSource(state, 'extract'), { nodeId: 'gold', port: 'result', kind: 'dataset' });
  assert.deepEqual(fields, [{ nodeId: 'extract', field: 'runInputToColumn', value: JSON.stringify({ id: 'pmid' }) }]);
  assert.equal(nodeOf(state, 'extract').runInputToColumn, JSON.stringify({ id: 'pmid' }));
});

test('an input whose columns are not known yet leaves the mapping alone', () => {
  const state = canvas();
  const fields = apply(state, at('other', 'out'), at('extract', 'input'));
  assert.deepEqual(fields, []);
  assert.deepEqual(runInputSource(state, 'extract'), { nodeId: 'other', port: 'out', kind: 'process' });
  const cleared = applyPortOp(state, checkDisconnect(state, at('extract', 'input')).op);
  assert.deepEqual(cleared, []);
  assert.equal(runInputSource(state, 'extract'), null);
});

test('a new Prompt keeps the mapping of the inputs it shares; no Prompt keeps none', () => {
  const state = canvas();
  const fields = apply(state, at('v2', 'prompt'), at('extract', 'prompt'), { promptInputs: (prompt) => (prompt.nodeId === 'v2' ? ['text', 'species'] : []) });
  assert.deepEqual(state.connections.filter((item) => item.type === 'prompt-to-run'), [edge('prompt-to-run', 'v2', 'extract')]);
  assert.deepEqual(fields, [{ nodeId: 'extract', field: 'runInputToColumn', value: JSON.stringify({ text: 'text' }) }]);
  applyPortOp(state, checkDisconnect(state, at('extract', 'prompt')).op);
  assert.equal(state.connections.some((item) => item.type === 'prompt-to-run'), false);
  assert.equal(nodeOf(state, 'extract').runInputToColumn, '{}');
});

test('without the Prompt input names, a new Prompt leaves the mapping alone', () => {
  const state = canvas();
  assert.deepEqual(apply(state, at('v2', 'prompt'), at('extract', 'prompt')), []);
  assert.equal(nodeOf(state, 'extract').runInputToColumn, JSON.stringify({ text: 'text', id: 'pmid' }));
});

test('a new df keeps its alias, and untouched sample code follows its columns', () => {
  const state = canvas();
  const fresh = nodeOf(state, 'fresh');
  fresh.dfCode = withProcessParameters(buildDefaultProcessCode([]), ['df_x']);
  const first = apply(state, at('abstracts', 'result'), at('fresh', 'df'));
  assert.deepEqual(processInputSources(state, 'fresh'), [{ nodeId: 'abstracts', port: 'result', kind: 'dataset', alias: 'df' }]);
  assert.equal(fresh.dfCode, withProcessParameters(buildDefaultProcessCode(['pmid', 'text']), ['df_x']));
  assert.deepEqual(first, [{ nodeId: 'fresh', field: 'dfCode', value: fresh.dfCode }]);
  apply(state, at('gold', 'result'), at('fresh', 'df'));
  assert.equal(fresh.dfCode, withProcessParameters(buildDefaultProcessCode(['pmid', 'kinase']), ['df_x']));
  assert.deepEqual(processInputSources(state, 'fresh'), [{ nodeId: 'gold', port: 'result', kind: 'dataset', alias: 'df' }]);

  // Saved code comes back trimmed and still counts as the sample.
  fresh.dfCode = fresh.dfCode.trim();
  apply(state, at('abstracts', 'result'), at('fresh', 'df'));
  assert.equal(fresh.dfCode, withProcessParameters(buildDefaultProcessCode(['pmid', 'text']), ['df_x']));

  const edited = 'def process(df):\n    return df.head(1)\n';
  fresh.dfCode = edited;
  assert.deepEqual(apply(state, at('abstracts', 'result'), at('fresh', 'df')), []);
  assert.equal(fresh.dfCode, edited);
});

test('a df left empty removes the Process input', () => {
  const state = canvas();
  applyPortOp(state, checkDisconnect(state, at('split', 'df')).op);
  assert.deepEqual(processInputSources(state, 'split'), []);
  assert.equal(nodePorts(state, 'split').inputs[0].source, null);
});

test('another source on an alias keeps the alias and the code', () => {
  const state = canvas();
  const code = nodeOf(state, 'merge').dfCode;
  assert.deepEqual(apply(state, at('gold', 'result'), at('merge', 'df_abstracts')), []);
  assert.deepEqual(processInputSources(state, 'merge'), [
    { nodeId: 'split', port: 'ready', kind: 'process', alias: 'df' },
    { nodeId: 'gold', port: 'result', kind: 'dataset', alias: 'df_abstracts' },
  ]);
  assert.equal(nodeOf(state, 'merge').dfCode, code);
});

test('a new ground truth drops the rules on columns it lacks, as the Score window does', () => {
  const state = canvas();
  const score = nodeOf(state, 'score');
  score.scoreMapping = serializeScoreMappingBundle(group(rule('id', ['pmid'])), group(rule('kinase', ['kinase'])));
  const fields = apply(state, at('abstracts', 'result'), at('score', 'ground_truth'));
  assert.equal(score.scoreGroundTruthId, 'abstracts');
  const kept = parseScoreMappingBundle(score.scoreMapping);
  assert.deepEqual(kept.inputRoot.children.map((item) => item.gtColumns), [['pmid']]);
  assert.deepEqual(kept.outputRoot.children, []);
  assert.deepEqual(fields.map((item) => item.field), ['scoreGroundTruthId', 'scoreMapping']);

  applyPortOp(state, checkDisconnect(state, at('score', 'ground_truth')).op);
  assert.equal(score.scoreGroundTruthId, '');
  assert.equal(nodePorts(state, 'score').inputs[1].source, null);
});

test('a saved mapping object stays an object', () => {
  const state = canvas();
  const score = nodeOf(state, 'score');
  score.scoreMapping = JSON.parse(serializeScoreMappingBundle(group(rule('id', ['pmid'])), group(rule('kinase', ['kinase']))));
  apply(state, at('abstracts', 'result'), at('score', 'ground_truth'));
  assert.equal(typeof score.scoreMapping, 'object');
  assert.deepEqual(score.scoreMapping.output.children, []);
});

test('the ground-truth rule filter leaves a mapping it does not change alone', () => {
  const mapping = serializeScoreMappingBundle(group(rule('id', ['pmid'])), group(rule('kinase', ['kinase'])));
  assert.equal(scoreMappingForGroundTruth(mapping, ['pmid', 'kinase']), null);
  const noInput = parseScoreMappingBundle(scoreMappingForGroundTruth(mapping, ['kinase']));
  assert.deepEqual(noInput.inputRoot.children, []);
  assert.deepEqual(noInput.outputRoot.children, [], 'Output rules go when no Input rule is left');
});

test('mapping helpers keep the shared inputs and the known columns', () => {
  assert.deepEqual(keepSharedMapping({ text: 'a', id: 'b' }, ['text', 'other']), { text: 'a' });
  assert.deepEqual(keepSharedMapping({ text: 'a' }, null), {});
  assert.deepEqual(keepMappedColumns({ text: 'a', id: 'b' }, ['b']), { id: 'b' });
});

test('sample code counts as untouched whatever inputs follow df', () => {
  const sample = buildDefaultProcessCode(['pmid']);
  assert.equal(isUntouchedSampleCode(sample, ['pmid']), true);
  assert.equal(isUntouchedSampleCode(withProcessParameters(sample, ['df_gold']), ['pmid']), true);
  assert.equal(isUntouchedSampleCode(sample.trim(), ['pmid']), true);
  assert.equal(isUntouchedSampleCode(sample, ['text']), false);
  assert.equal(isUntouchedSampleCode(`${sample}# edited\n`, ['pmid']), false);
});

// ---------- how ports are shown ----------

test('all solid and hollow dots use rows below the header, including Dataset and Prompt origins', () => {
  const state = canvas();
  const layout = (nodeId) => {
    const { left, right } = portLayout(nodePorts(state, nodeId));
    const side = ({ rows, lineage }) => ({ rows: ids(rows), lineage });
    return { left: side(left), right: side(right) };
  };
  assert.deepEqual(layout('extract'), {
    left: { rows: ['prompt', 'input'], lineage: null },
    right: { rows: ['result'], lineage: 'row' },
  });
  assert.deepEqual(layout('abstracts'), { left: { rows: [], lineage: null }, right: { rows: ['result'], lineage: 'row' } });
  assert.deepEqual(layout('v2'), { left: { rows: [], lineage: 'row' }, right: { rows: ['prompt'], lineage: null } });
  assert.deepEqual(layout('v3').left, { rows: [], lineage: 'row' });
  for (const id of ['sample', 'saved']) {
    assert.deepEqual(layout(id), { left: { rows: [], lineage: 'row' }, right: { rows: ['result'], lineage: null } });
  }
  state.nodes.push({ type: 'dataset', nodeId: 'abstracts-v2', name: 'Abstracts v2' });
  state.connections.push(edge('dataset-to-dataset', 'abstracts', 'abstracts-v2'));
  assert.deepEqual(layout('abstracts-v2').left, { rows: [], lineage: 'row' });
  assert.deepEqual(layout('split'), { left: { rows: ['df', '+'], lineage: null }, right: { rows: ['ready', 'rewrite'], lineage: null } });
  assert.deepEqual(layout('merge').right, { rows: ['result'], lineage: null });
  assert.deepEqual(layout('score'), { left: { rows: ['run', 'ground_truth'], lineage: null }, right: { rows: ['score'], lineage: 'row' } });
  assert.deepEqual(layout('review'), { left: { rows: ['score'], lineage: null }, right: { rows: [], lineage: 'row' } });
  assert.deepEqual(layout('sampler'), { left: { rows: ['source'], lineage: null }, right: { rows: [], lineage: 'row' } });
  const withLineageRows = portLayout({ inputs: [], outputs: [{ id: 'a', showLabel: true }, { id: 'b', showLabel: true }], lineageIn: false, lineageOut: true });
  assert.equal(withLineageRows.right.lineage, 'row');
});

test('hover text says what an input reads, what an output gives, and where a node came from', () => {
  const state = canvas();
  const titles = (nodeId) => portTitles(state, nodeId, nodePorts(state, nodeId));
  assert.deepEqual(titles('extract').inputs, { prompt: 'Input: Extract v1', input: 'Input: Abstracts' });
  assert.equal(titles('split').inputs.df, 'Input: Run');
  assert.equal(titles('extract').outputs.result, 'Output: no output yet');
  assert.equal(titles('extract').lineageOut, 'Created Evaluate "Score"\nSaved as Dataset "Saved"');
  assert.equal(titles('abstracts').outputs.result, 'Output: 1 row · pmid, text');
  assert.equal(titles('other').outputs.out, 'Output: out · no output yet');
  assert.equal(titles('merge').inputs.df, 'Input: Split · ready');
  assert.equal(titles('fresh').inputs.df, 'Input: Not connected');
  assert.match(titles('score').inputs.run, /^Input: Run\nAn Evaluate node compares/);
  assert.equal(titles('review').inputs.score, 'Input: Score\nAn Optimize node analyzes the Evaluate node it was created from. Start a new Optimize node from another Evaluate node.');
  assert.match(titles('dyn').outputs.result, /once the Process has run/);
  assert.equal(titles('v2').lineageIn, 'New version of "Extract v1"');
  assert.equal(titles('v1').lineageOut, 'New version "Extract v2"');
  assert.equal(titles('v3').lineageIn, 'Created by Apply in Optimize "Review"');
  assert.equal(titles('review').lineageOut, 'Output: New prompt\nApplied as Prompt "Extract v3"');
  assert.equal(titles('score').lineageOut, 'Created Optimize "Review"');
  assert.equal(titles('sample').lineageIn, 'Sampled by "Sample"');
  assert.equal(titles('sampler').lineageOut, 'Sample "Sample 20"');
  assert.equal(titles('abstracts').lineageOut, 'Created Sample "Sample"');
  assert.equal(titles('saved').lineageIn, 'Saved from Run of "Extract v1"');
  assert.equal(titles('abstracts').lineageIn, '');
});

test('Run output hover lists only model output columns, while Process uses a single named branch', () => {
  const state = canvas();
  const run = state.nodes.find((node) => node.nodeId === 'extract');
  run.runCompleted = '1';
  run.runInputContent = JSON.stringify(table(['pmid', 'text']));
  run.runResults = JSON.stringify([{ row_index: 0, input_row_index: 0, output: { kinase: 'AKT1' } }]);
  const runTitle = portTitles(state, 'extract', nodePorts(state, 'extract')).outputs.result;
  assert.equal(runTitle, 'Output: 1 row · kinase');
  assert.equal(runTitle.includes('Input:'), false);

  const process = state.nodes.find((node) => node.nodeId === 'other');
  process.dfResults = JSON.stringify({ outputs: { out: table(['gene']) } });
  assert.equal(portTitles(state, 'other', nodePorts(state, 'other')).outputs.out, 'Output: out · 1 row · gene');
});

// ---------- moving a line ----------

test('a line picked up off one input and dropped on another moves there', () => {
  const state = canvas();
  state.nodes.push({ type: 'run', nodeId: 'second', runName: 'Run' });
  // Checked as the drag does: on a copy where the line is already gone from where it was.
  const lift = checkDisconnect(state, at('extract', 'input'));
  const copy = JSON.parse(JSON.stringify(state));
  applyPortOp(copy, lift.op);
  const drop = checkConnect(copy, at('abstracts', 'result'), at('second', 'input'));
  assert.equal(drop.ok, true);
  applyPortOp(state, lift.op);
  applyPortOp(state, drop.op);
  assert.equal(runInputSource(state, 'extract'), null);
  assert.deepEqual(runInputSource(state, 'second'), { nodeId: 'abstracts', port: 'result', kind: 'dataset' });
});

test('a ground truth line moves from one Score to another', () => {
  const state = canvas();
  state.nodes.push({ type: 'score', nodeId: 'score2', scoreName: 'Score 2' });
  const lift = checkDisconnect(state, at('score', 'ground_truth'));
  const drop = checkConnect(state, at('gold', 'result'), at('score2', 'ground_truth'));
  applyPortOp(state, lift.op);
  applyPortOp(state, drop.op);
  assert.equal(nodeOf(state, 'score').scoreGroundTruthId, '');
  assert.equal(nodeOf(state, 'score2').scoreGroundTruthId, 'gold');
  assert.deepEqual(derivedEdges(state).filter((item) => item.type === 'ground-truth-to-score').map((item) => item.toId), ['score2']);
});

// ---------- Process inputs and the code's parameters ----------

const processWith = (code) => {
  const state = canvas();
  nodeOf(state, 'merge').dfCode = code;
  return state;
};

test('each parameter of the code is a port; one with nothing connected is empty', () => {
  const state = processWith('def process(df, df_abstracts, df_notes):\n    return df\n');
  const inputs = nodePorts(state, 'merge').inputs;
  assert.deepEqual(ids(inputs), ['df', 'df_abstracts', 'df_notes', ADD_INPUT_PORT]);
  assert.equal(inputs[2].source, null);
  assert.deepEqual(unconnectedProcessInputs(state, 'merge'), ['df_notes']);
  assert.deepEqual(unconnectedProcessInputs(state, 'merge', 'def process(df):\n    return df\n'), []);
  assert.equal(portTitles(state, 'merge', nodePorts(state, 'merge')).inputs.df_notes, 'Input: Not connected');
  assert.match(portTitles(state, 'merge', nodePorts(state, 'merge')).inputs[ADD_INPUT_PORT], /^Drop an output here to add it as an input/);
});

test('an input the code uses without declaring it still shows, after the parameters', () => {
  const state = processWith('def process(df):\n    return df.merge(df_abstracts)\n');
  assert.deepEqual(ids(nodePorts(state, 'merge').inputs), ['df', 'df_abstracts', ADD_INPUT_PORT]);
});

test('an output dropped on + becomes an input under the alias its name gives, with a parameter', () => {
  const state = processWith('def process(df, df_abstracts):\n    return df\n');
  const result = checkConnect(state, at('gold', 'result'), at('merge', ADD_INPUT_PORT));
  assert.deepEqual(result.op, { type: 'process-add', processId: 'merge', source: { nodeId: 'gold', port: 'result', kind: 'dataset' } });
  const fields = applyPortOp(state, result.op);
  assert.equal(nodeOf(state, 'merge').dfCode, 'def process(df, df_abstracts, df_gold):\n    return df\n');
  assert.deepEqual(fields, [{ nodeId: 'merge', field: 'dfCode', value: nodeOf(state, 'merge').dfCode }]);
  assert.deepEqual(processInputSources(state, 'merge').map((source) => `${source.alias}=${source.nodeId}`), ['df=split', 'df_abstracts=abstracts', 'df_gold=gold']);
  assert.deepEqual(ids(nodePorts(state, 'merge').inputs), ['df', 'df_abstracts', 'df_gold', ADD_INPUT_PORT]);
});

test('on a Process without df, + takes the first input as df', () => {
  const state = canvas();
  assert.equal(checkConnect(state, at('gold', 'result'), at('fresh', ADD_INPUT_PORT)).op.type, 'process-df');
});

test('an output dropped on an empty parameter is read under that name, and the code stays', () => {
  const code = 'def process(df, df_abstracts, df_notes):\n    return df\n';
  const state = processWith(code);
  const result = checkConnect(state, at('gold', 'result'), at('merge', 'df_notes'));
  assert.deepEqual(result.op, { type: 'process-alias', processId: 'merge', alias: 'df_notes', from: null, source: { nodeId: 'gold', port: 'result', kind: 'dataset' } });
  assert.deepEqual(applyPortOp(state, result.op), []);
  assert.equal(nodeOf(state, 'merge').dfCode, code);
  assert.deepEqual(processInputSources(state, 'merge').find((source) => source.alias === 'df_notes'), { nodeId: 'gold', port: 'result', kind: 'dataset', alias: 'df_notes' });
  assert.deepEqual(unconnectedProcessInputs(state, 'merge'), []);
});

test('a parameter cannot be connected while df is empty', () => {
  const state = canvas();
  nodeOf(state, 'fresh').dfCode = 'def process(df, df_notes):\n    return df\n';
  assert.equal(checkConnect(state, at('gold', 'result'), at('fresh', 'df_notes')).reason, 'This Process has no df yet. Connect df first.');
});

test('disconnecting an input removes its parameter, unless the code uses it', () => {
  const state = processWith('def process(df, df_abstracts):\n    return df\n');
  const result = checkDisconnect(state, at('merge', 'df_abstracts'));
  const fields = applyPortOp(state, result.op);
  assert.equal(nodeOf(state, 'merge').dfCode, 'def process(df):\n    return df\n');
  assert.deepEqual(fields.map((item) => item.field), ['dfCode']);
  assert.deepEqual(processInputSources(state, 'merge').map((source) => source.alias), ['df']);

  const used = processWith('def process(df, df_abstracts):\n    return df.merge(df_abstracts)\n');
  assert.equal(checkDisconnect(used, at('merge', 'df_abstracts')).reason, 'The code uses df_abstracts. Remove that use to stop reading this input.');
});

test('df stays while another input is connected, but not because of an empty parameter', () => {
  const state = canvas();
  nodeOf(state, 'split').dfCode = 'def process(df, df_notes):\n    return df\n';
  assert.equal(checkDisconnect(state, at('split', 'df')).ok, true);
});
