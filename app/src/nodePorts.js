/**
 * Ports: the dots on the edges of canvas nodes (docs/design/NODE_PORTS_DESIGN.md §4–§6,
 * docs/design/NODE_PORTS_PLAN.md §3). Inputs are on a node's left and outputs on its right; hollow
 * lineage dots show where a node came from and what was made from it. This module says which ports
 * a node has, which ports a connection joins, and whether a connection may be made or removed, so
 * the canvas, dragging and the Agent follow one set of rules.
 *
 * Works on plain canvas state ({ nodes, connections, historyVersion }) as getCanvasState() saves it.
 * Fields read: every node's nodeId, type and name; Run runName, runPending, runCompleted, runResults,
 * runInputToColumn; Process dfCode, processOutputPorts, dfResults, processPending; Score scoreName,
 * scoreGroundTruthId, scoreMapping; Sampler sourceNodeId; Dataset datasetContent, savedFrom; Prompt
 * sections (through `promptInputs`).
 */
import { resolveDataframeProcessCode } from './processCode.js';
import { effectiveProcessOutputs, showsProcessOutputs } from './processOutputPorts.js';
import { buildDefaultProcessCode, isUntouchedSampleCode } from './processSampleCode.js';
import { parseProcessSignature, withProcessParameters } from './processSignature.js';
import { readSavedFrom } from './savedDatasets.js';
import { scoreMappingForGroundTruth } from './scoreMappingBundle.js';
import {
  RESULT_PORT, DATA_EDGE, processInputSources, processPrimarySource, readsFromStep, replaceProcessInputSource,
  runInputSource, setProcessInputs, setProcessPrimarySource, setRunInputSource, sourceKey, stepSourceLabel,
} from './stepInputs.js';
import { stepOutputTable } from './stepOutputs.js';

export const PORT_TYPES = Object.freeze({ TABLE: 'table', PROMPT: 'prompt', SCORE: 'score' });

/** Connections that record where a node came from rather than what it reads (hollow dots). */
export const LINEAGE_EDGE_TYPES = new Set(['prompt-to-prompt', 'prompt-review-to-prompt', 'dataset-to-dataset', 'sampler-to-dataset', 'saved-from']);

const TYPE_NOUN = { table: 'a table', prompt: 'a Prompt', score: 'a Score' };
const FIXED = {
  run: 'A Score compares the results of the Run it was created from. Add a new Score to score another Run.',
  score: 'A Review analyzes the Score it was created from. Start a new Review from another Score.',
  source: 'A Sampler samples the Dataset it was created from. Add a Sampler to another Dataset.',
};
const PROCESS_OUTPUTS_DYNAMIC = 'Its branches are known once the Process has run.';
const PROCESS_OUTPUTS_UNKNOWN = 'Its outputs are not known yet. Check its code or run it.';
const PROCESS_OUTPUT_MISMATCH = 'Branches returned by the last run differ from the code';

const nodeIdOf = (node) => String(node?.nodeId || node?.id || '').trim();
const findNode = (state, id) => (state?.nodes || []).find((node) => nodeIdOf(node) === String(id || '').trim());
const edgesOfType = (state, type) => (state?.connections || []).filter((edge) => edge?.type === type);
const fromOf = (state, type, toId) => String(edgesOfType(state, type).find((edge) => String(edge.toId) === String(toId))?.fromId || '');
const isAlias = (name) => /^df_[A-Za-z0-9_]+$/.test(name);

function parsed(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

/** How a node is named in messages: a Run by its Prompt, as everywhere else (stepInputs.js). */
function nodeLabel(state, nodeId) {
  const node = findNode(state, nodeId);
  if (!node) return String(nodeId || '');
  if (node.type === 'run' || node.type === 'process' || node.type === 'dataset') return stepSourceLabel(state, { nodeId: nodeIdOf(node), port: RESULT_PORT });
  return String(node.name || node.scoreName || '').trim() || { prompt: 'Prompt', score: 'Score', promptReview: 'Review', sampler: 'Sample' }[node.type] || 'Node';
}

const hasRunResults = (node) => {
  const results = parsed(node?.runResults, []);
  return (Array.isArray(results) && results.length > 0) || node?.runCompleted === true || node?.runCompleted === '1';
};

const isRunning = (node, running) => !!node && (node.runPending === true || node.processPending === true || !!running?.has?.(nodeIdOf(node)));

// ---------- edges and their ports ----------

/**
 * Connections the canvas draws from node fields rather than stores: a Score's ground truth, and the
 * step a saved Dataset came from. Each only when both nodes are on the canvas.
 */
export function derivedEdges(state) {
  const stored = new Set((state?.connections || []).map((edge) => `${edge?.type}:${edge?.fromId}:${edge?.toId}`));
  const derived = [];
  const add = (fromId, toId, type) => {
    if (!fromId || !toId || !findNode(state, fromId) || !findNode(state, toId) || stored.has(`${type}:${fromId}:${toId}`)) return;
    stored.add(`${type}:${fromId}:${toId}`);
    derived.push({ fromId, toId, type, derived: true });
  };
  for (const node of state?.nodes || []) {
    if (node?.type === 'dataset') add(readSavedFrom(node.savedFrom)?.nodeId, nodeIdOf(node), 'saved-from');
    if (node?.type === 'score') add(String(node.scoreGroundTruthId || '').trim(), nodeIdOf(node), 'ground-truth-to-score');
  }
  return derived;
}

const allEdges = (state) => [...(state?.connections || []), ...derivedEdges(state)];

/** The alias a Process input is read under: 'df' for its primary input, otherwise the recorded alias. */
function processAliasOf(state, edge) {
  const key = sourceKey({ nodeId: String(edge.fromId), port: String(edge.fromPort || RESULT_PORT), kind: findNode(state, edge.fromId)?.type });
  return processInputSources(state, edge.toId).find((source) => sourceKey(source) === key)?.alias || '';
}

/**
 * The ports `edge` joins (NODE_PORTS_PLAN.md §3.1): `{ from: { nodeId, portId }, to: { nodeId, portId } }`,
 * with `lineage: true` on both ends instead of port IDs for a lineage connection. Null when it joins
 * no ports (an unknown type, a missing node, or a Process input recorded without an alias).
 */
export function edgeEndpoints(state, edge) {
  if (!edge) return null;
  const fromId = String(edge.fromId || '');
  const toId = String(edge.toId || '');
  if (!findNode(state, fromId) || !findNode(state, toId)) return null;
  const ends = (fromPort, toPort) => ({ from: { nodeId: fromId, portId: fromPort }, to: { nodeId: toId, portId: toPort } });
  if (LINEAGE_EDGE_TYPES.has(edge.type)) return { from: { nodeId: fromId, lineage: true }, to: { nodeId: toId, lineage: true } };
  switch (edge.type) {
    case 'prompt-to-run': return ends('prompt', 'prompt');
    case 'run-to-score': return ends(RESULT_PORT, 'run');
    case 'ground-truth-to-score': return ends(RESULT_PORT, 'ground_truth');
    case 'score-to-prompt-review': return ends('score', 'score');
    case 'dataset-to-sampler': return ends(RESULT_PORT, 'source');
    case DATA_EDGE: {
      const fromPort = findNode(state, fromId).type === 'dataset' ? RESULT_PORT : String(edge.fromPort || RESULT_PORT);
      const target = findNode(state, toId);
      if (target.type === 'run') return ends(fromPort, 'input');
      if (target.type !== 'process') return null;
      const alias = processAliasOf(state, edge);
      return alias ? ends(fromPort, alias) : null;
    }
    default: return null;
  }
}

// ---------- the ports of a node ----------

const port = (id, type, label, extra = {}) => ({ id, type, label, ...extra });

function inputPorts(state, node) {
  const id = nodeIdOf(node);
  if (node.type === 'run') {
    const promptId = fromOf(state, 'prompt-to-run', id);
    return [
      port('prompt', PORT_TYPES.PROMPT, 'prompt', { source: promptId ? { nodeId: promptId, port: 'prompt', kind: 'prompt' } : null }),
      port('input', PORT_TYPES.TABLE, 'input', { source: runInputSource(state, id) }),
    ];
  }
  if (node.type === 'process') {
    const sources = processInputSources(state, id);
    const primary = sources.find((source) => source.alias === 'df') || null;
    const others = sources.filter((source) => source.alias && source.alias !== 'df');
    return [
      port('df', PORT_TYPES.TABLE, 'df', { source: primary && { nodeId: primary.nodeId, port: primary.port, kind: primary.kind } }),
      ...others.map(({ alias, ...source }) => port(alias, PORT_TYPES.TABLE, alias, { source })),
    ];
  }
  if (node.type === 'score') {
    const runId = fromOf(state, 'run-to-score', id);
    const groundTruthId = String(node.scoreGroundTruthId || '').trim();
    return [
      port('run', PORT_TYPES.TABLE, 'run', { source: runId ? { nodeId: runId, port: RESULT_PORT, kind: 'run' } : null, fixed: FIXED.run }),
      port('ground_truth', PORT_TYPES.TABLE, 'ground truth', {
        source: groundTruthId && findNode(state, groundTruthId) ? { nodeId: groundTruthId, port: RESULT_PORT, kind: 'dataset' } : null,
      }),
    ];
  }
  if (node.type === 'promptReview') {
    const scoreId = fromOf(state, 'score-to-prompt-review', id);
    return [port('score', PORT_TYPES.SCORE, 'score', { source: scoreId ? { nodeId: scoreId, port: 'score', kind: 'score' } : null, fixed: FIXED.score })];
  }
  if (node.type === 'sampler') {
    const sourceId = fromOf(state, 'dataset-to-sampler', id) || String(node.sourceNodeId || '').trim();
    return [port('source', PORT_TYPES.TABLE, 'source', { source: sourceId ? { nodeId: sourceId, port: RESULT_PORT, kind: 'dataset' } : null, fixed: FIXED.source })];
  }
  return [];
}

function outputPorts(node) {
  if (node.type === 'dataset' || node.type === 'run') return [port(RESULT_PORT, PORT_TYPES.TABLE, 'result')];
  if (node.type === 'prompt') return [port('prompt', PORT_TYPES.PROMPT, 'prompt')];
  if (node.type === 'score') return [port('score', PORT_TYPES.SCORE, 'score')];
  if (node.type !== 'process') return [];
  const outputs = effectiveProcessOutputs({ detected: node.processOutputPorts, dfResults: node.dfResults });
  const mismatch = outputs.mismatch ? { mismatch: PROCESS_OUTPUT_MISMATCH } : {};
  if (outputs.ports.length) return outputs.ports.map((name) => port(name, PORT_TYPES.TABLE, name, mismatch));
  return [port(RESULT_PORT, PORT_TYPES.TABLE, outputs.dynamic ? 'dynamic outputs' : 'result', {
    unavailable: outputs.dynamic ? PROCESS_OUTPUTS_DYNAMIC : PROCESS_OUTPUTS_UNKNOWN,
  })];
}

/**
 * Whether port names are shown on one side (NODE_PORTS_PLAN.md §3.2): with two or more ports, or
 * when the names say something themselves (a Process's df, aliases and named branches).
 */
function labelsShown(node, side, ports) {
  if (ports.length >= 2) return true;
  if (node.type !== 'process' || !ports.length) return false;
  if (side === 'left') return true;
  return showsProcessOutputs(effectiveProcessOutputs({ detected: node.processOutputPorts, dfResults: node.dfResults }));
}

/**
 * The ports of one node, or null when it is not on the canvas.
 * - `inputs[]`: `{ id, type, label, showLabel, source, fixed? }`. `source` is what it reads
 *   (`{ nodeId, port, kind }`) or null; `fixed` says why it cannot be replaced or disconnected.
 * - `outputs[]`: `{ id, type, label, showLabel, readers, unavailable?, mismatch? }`. `readers` are the
 *   input ports reading it; `unavailable` says why nothing can read it yet.
 * - `lineageIn` / `lineageOut`: whether the node has a hollow dot on that side.
 */
export function nodePorts(state, nodeId) {
  const node = findNode(state, nodeId);
  if (!node) return null;
  const id = nodeIdOf(node);
  const edges = allEdges(state).map((edge) => ({ edge, ends: edgeEndpoints(state, edge) })).filter((item) => item.ends);
  const inputs = inputPorts(state, node);
  const outputs = outputPorts(node).map((item) => ({
    ...item,
    readers: edges.filter(({ ends }) => !ends.from.lineage && ends.from.nodeId === id && ends.from.portId === item.id).map(({ ends }) => ends.to),
  }));
  const showIn = labelsShown(node, 'left', inputs);
  const showOut = labelsShown(node, 'right', outputs);
  return {
    inputs: inputs.map((item) => ({ ...item, showLabel: showIn })),
    outputs: outputs.map((item) => ({ ...item, showLabel: showOut })),
    lineageIn: edges.some(({ ends }) => ends.to.lineage && ends.to.nodeId === id),
    lineageOut: edges.some(({ ends }) => ends.from.lineage && ends.from.nodeId === id),
  };
}

// ---------- connecting and disconnecting ----------

const refuse = (reason) => ({ ok: false, reason });

/** Why `node` cannot have its inputs changed right now, or ''. */
function changeBlocked(state, node, inputId, running) {
  if (isRunning(node, running)) return `"${nodeLabel(state, nodeIdOf(node))}" is running. Stop it before changing its inputs.`;
  // As the Run window: without History, a Run's prompt and input lock once it has results.
  if (node.type === 'run' && state?.historyVersion !== 1 && hasRunResults(node) && (inputId === 'prompt' || inputId === 'input')) {
    return 'This Run already has results, so its prompt and input are fixed. Add a new Run instead.';
  }
  return '';
}

/** The op that makes `inputPort` read `source`, given that every check passed. */
function connectOp(nodeId, node, inputPort, source) {
  if (node.type === 'run') {
    return inputPort.id === 'prompt' ? { type: 'run-prompt', runId: nodeId, promptId: source.nodeId } : { type: 'run-input', runId: nodeId, source };
  }
  if (node.type === 'process') {
    return inputPort.id === 'df'
      ? { type: 'process-df', processId: nodeId, source }
      : { type: 'process-alias', processId: nodeId, alias: inputPort.id, from: inputPort.source, source };
  }
  if (node.type === 'score' && inputPort.id === 'ground_truth') return { type: 'score-ground-truth', scoreId: nodeId, datasetId: source.nodeId };
  return null;
}

/**
 * Whether the output `from` may feed the input `to` (both `{ nodeId, portId }`), checked in the
 * order a user would want to hear about it. `{ ok: true, op }` where `op` is for applyPortOp, or null
 * when `to` already reads `from`; otherwise `{ ok: false, reason }`, a sentence for the user.
 * @param {{ running?: Set<string> }} [options] nodes running besides those whose fields say so
 */
export function checkConnect(state, from, to, { running } = {}) {
  const sourceNode = findNode(state, from?.nodeId);
  const targetNode = findNode(state, to?.nodeId);
  const output = sourceNode && nodePorts(state, from.nodeId).outputs.find((item) => item.id === from.portId);
  const input = targetNode && nodePorts(state, to.nodeId).inputs.find((item) => item.id === to.portId);
  if (!output) return refuse('There is no such output.');
  if (!input) return refuse('There is no such input.');
  if (output.type !== input.type) return refuse(`The ${input.label} input takes ${TYPE_NOUN[input.type]}, not ${TYPE_NOUN[output.type]}.`);
  if (input.fixed) return refuse(input.fixed);
  if (input.id === 'ground_truth' && sourceNode.type !== 'dataset') return refuse('The ground truth must be a Dataset.');
  if (output.unavailable) return refuse(output.unavailable);
  const sourceId = nodeIdOf(sourceNode);
  const targetId = nodeIdOf(targetNode);
  const source = { nodeId: sourceId, port: output.id, kind: sourceNode.type };
  const same = (a, b) => !!a && !!b && a.nodeId === b.nodeId && String(a.port || RESULT_PORT) === String(b.port || RESULT_PORT);
  if (same(input.source, source)) return { ok: true, op: null };
  if (sourceId === targetId) return refuse('A step cannot read its own output.');
  if (input.type === PORT_TYPES.TABLE && readsFromStep(state, sourceId, targetId)) {
    return refuse(`This would make a loop: "${nodeLabel(state, sourceId)}" already reads "${nodeLabel(state, targetId)}".`);
  }
  const blocked = changeBlocked(state, targetNode, input.id, running);
  if (blocked) return refuse(blocked);
  if (targetNode.type === 'process') {
    const elsewhere = nodePorts(state, targetId).inputs.find((item) => item.id !== input.id && same(item.source, source));
    if (elsewhere) return refuse(`Already ${elsewhere.id} of this Process; disconnect it there first.`);
  }
  return { ok: true, op: connectOp(targetId, targetNode, input, source) };
}

/**
 * Whether the input `to` (`{ nodeId, portId }`) may be disconnected, leaving it empty: `{ ok: true, op }`
 * or `{ ok: false, reason }`.
 * @param {{ running?: Set<string> }} [options]
 */
export function checkDisconnect(state, to, { running } = {}) {
  const node = findNode(state, to?.nodeId);
  const ports = node && nodePorts(state, to.nodeId);
  const input = ports?.inputs.find((item) => item.id === to.portId);
  if (!input) return refuse('There is no such input.');
  if (!input.source) return refuse('This input is not connected.');
  if (input.fixed) return refuse(input.fixed);
  const blocked = changeBlocked(state, node, input.id, running);
  if (blocked) return refuse(blocked);
  const nodeId = nodeIdOf(node);
  if (node.type === 'run') return { ok: true, op: input.id === 'prompt' ? { type: 'run-prompt', runId: nodeId, promptId: '' } : { type: 'run-input', runId: nodeId, source: null } };
  if (node.type === 'score') return { ok: true, op: { type: 'score-ground-truth', scoreId: nodeId, datasetId: '' } };
  if (input.id !== 'df') return refuse(`Remove ${input.id} from the code to stop reading this input.`);
  // A Process's df is its first input when none is marked (stepInputs.js processPrimarySource), so
  // df can only be left empty with nothing else connected.
  if (ports.inputs.length > 1) return refuse('df cannot be empty while this Process has other inputs. Drag another output onto df instead.');
  return { ok: true, op: { type: 'process-df', processId: nodeId, source: null } };
}

// ---------- applying ----------

/** The mapping a Run keeps when it gets a Prompt with `inputNames`: only the inputs both share. */
export function keepSharedMapping(mapping, inputNames) {
  const names = new Set(inputNames || []);
  return Object.fromEntries(Object.entries(mapping || {}).filter(([name]) => names.has(name)));
}

/** The mapping a Run keeps when it reads a table with `headers`: only the columns that table has. */
export function keepMappedColumns(mapping, headers) {
  const columns = new Set(headers || []);
  return Object.fromEntries(Object.entries(mapping || {}).filter(([, column]) => columns.has(column)));
}

const headersOf = (state, source) => (source ? stepOutputTable(state, source).table?.headers : null) || null;

/**
 * Carries out an op from checkConnect or checkDisconnect on `state`, in place: its `connections`
 * and the fields of the node it changes, as the node's window would. Returns the changed fields,
 * `[{ nodeId, field, value }]`, for a caller that keeps nodes elsewhere (the canvas DOM); `value` is
 * what that field holds as text.
 * @param {{ promptInputs?: (promptNode: object) => string[] }} [options] the input names of a Prompt;
 *   without it, a Run's mapping is kept when its Prompt changes
 */
export function applyPortOp(state, op, { promptInputs } = {}) {
  const fields = [];
  if (!op) return fields;
  const set = (node, field, value, text = value) => {
    node[field] = value;
    fields.push({ nodeId: nodeIdOf(node), field, value: text });
  };
  const mappingOf = (node) => parsed(node.runInputToColumn, {}) || {};
  const setMapping = (node, mapping) => {
    if (JSON.stringify(mapping) !== JSON.stringify(mappingOf(node))) set(node, 'runInputToColumn', JSON.stringify(mapping));
  };

  if (op.type === 'run-prompt') {
    const run = findNode(state, op.runId);
    if (!run) return fields;
    const connections = state.connections;
    for (let index = connections.length - 1; index >= 0; index -= 1) {
      if (connections[index]?.type === 'prompt-to-run' && String(connections[index].toId) === op.runId) connections.splice(index, 1);
    }
    const prompt = op.promptId ? findNode(state, op.promptId) : null;
    if (prompt) connections.push({ fromId: op.promptId, toId: op.runId, type: 'prompt-to-run' });
    // As the Run window: a new Prompt keeps the mapping of the inputs it shares, no Prompt keeps none.
    if (!prompt) setMapping(run, {});
    else if (typeof promptInputs === 'function') setMapping(run, keepSharedMapping(mappingOf(run), promptInputs(prompt)));
    return fields;
  }

  if (op.type === 'run-input') {
    const run = findNode(state, op.runId);
    if (!run) return fields;
    setRunInputSource(state, op.runId, op.source);
    const headers = headersOf(state, op.source);
    if (headers) setMapping(run, keepMappedColumns(mappingOf(run), headers));
    return fields;
  }

  if (op.type === 'process-df') {
    const processNode = findNode(state, op.processId);
    if (!processNode) return fields;
    const current = processPrimarySource(state, op.processId);
    if (!op.source) {
      setProcessInputs(state, op.processId, { primary: null, inputs: [] });
      return fields;
    }
    const code = resolveDataframeProcessCode({ dfCode: processNode.dfCode, code: processNode.code });
    if (current) replaceProcessInputSource(state, op.processId, current, op.source);
    else setProcessPrimarySource(state, op.processId, op.source);
    // Untouched sample code follows the new df's columns, as in the Process window.
    if (code && isUntouchedSampleCode(code, headersOf(state, current) || [])) {
      const aliases = (parseProcessSignature(code)?.params || []).slice(1).map((param) => param.name).filter(isAlias);
      const next = withProcessParameters(buildDefaultProcessCode(headersOf(state, op.source) || []), aliases);
      if (next !== code) set(processNode, 'dfCode', next);
    }
    return fields;
  }

  if (op.type === 'process-alias') {
    replaceProcessInputSource(state, op.processId, op.from, op.source);
    return fields;
  }

  if (op.type === 'score-ground-truth') {
    const score = findNode(state, op.scoreId);
    if (!score) return fields;
    set(score, 'scoreGroundTruthId', op.datasetId || '');
    // As the Score window: rules on ground-truth columns the new Dataset lacks are dropped.
    const headers = op.datasetId ? headersOf(state, { nodeId: op.datasetId, port: RESULT_PORT, kind: 'dataset' }) : null;
    const mapping = headers ? scoreMappingForGroundTruth(score.scoreMapping, headers) : null;
    if (mapping) set(score, 'scoreMapping', typeof score.scoreMapping === 'string' ? mapping : JSON.parse(mapping), mapping);
    return fields;
  }
  return fields;
}
