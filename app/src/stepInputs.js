/**
 * The one place that reads and writes where a Run or Process gets its data (docs/design/
 * DATA_FLOW_DESIGN.md §3.3). Works on plain canvas state ({ nodes, connections }), as saved by
 * getCanvasState(); workflowCanvas.js adapts it to the live DOM.
 *
 * Every input is a `data` connection { type: 'data', fromId, fromPort, toId, alias }. A Run has at
 * most one. A Process has one per input; `alias` is the name its code uses, 'df' for the primary.
 * A source is { nodeId, port, kind }: a Dataset ('dataset', port 'result'), a Run's results ('run',
 * port 'result') or one output branch of a Process ('process', port = the branch) (§3.2, §3.4).
 * Functions that take a source look its kind up in `state` when it is not given.
 */
import { datasetHistorySource } from './datasetHistorySource.js';
import { buildProcessDatasetBindings, processDatasetInputs, referencedDatasetAliases } from './processDatasetBindings.js';
import { effectiveProcessOutputs } from './processOutputPorts.js';
import { stepOutputTable } from './stepOutputs.js';

export const RESULT_PORT = 'result';
export const DATA_EDGE = 'data';
const STEP_KINDS = new Set(['run', 'process']);

const nodeIdOf = (node) => String(node?.nodeId || node?.id || '').trim();
const findNode = (state, id) => (state?.nodes || []).find((node) => nodeIdOf(node) === String(id || '').trim());
const dataEdges = (state) => (state?.connections || []).filter((edge) => edge?.type === DATA_EDGE);
const dataEdgesInto = (state, toId) => dataEdges(state).filter((edge) => String(edge.toId) === String(toId).trim());

/** 'run' or 'process' for a step's output; 'dataset' otherwise, including a node no longer on the canvas. */
function kindOf(state, nodeId) {
  const type = findNode(state, nodeId)?.type;
  return STEP_KINDS.has(type) ? type : 'dataset';
}
const sourceOf = (state, edge) => ({ nodeId: String(edge.fromId), port: String(edge.fromPort || RESULT_PORT), kind: kindOf(state, edge.fromId) });

/**
 * A stable string for a source, for option values, lookups and History: a Dataset's node ID, or
 * `node:port` for a step's output, since two branches of one Process can both be inputs.
 */
export function sourceKey(source) {
  if (!source?.nodeId) return '';
  return STEP_KINDS.has(source.kind) ? `${source.nodeId}:${source.port || RESULT_PORT}` : String(source.nodeId);
}
const keyIn = (state, source) => sourceKey(source?.nodeId ? { ...source, kind: source.kind || kindOf(state, source.nodeId) } : null);
const edgeKey = (state, edge) => sourceKey(sourceOf(state, edge));

/** Removes every data connection into `toId`, in place, so the live connections array stays shared. */
function removeDataEdgesInto(state, toId) {
  const connections = state.connections;
  for (let index = connections.length - 1; index >= 0; index -= 1) {
    if (connections[index]?.type === DATA_EDGE && String(connections[index].toId) === String(toId)) connections.splice(index, 1);
  }
}

// ---------- names ----------

/** A Run is named by its Prompt, as Current Pipeline names it; every Run is called "Run" by default. */
function runLabel(state, run) {
  const edge = (state?.connections || []).find((item) => item?.type === 'prompt-to-run' && String(item.toId) === nodeIdOf(run));
  return String(findNode(state, edge?.fromId)?.name || '').trim() || String(run.runName || '').trim() || 'Run';
}

/** How a source is shown: a Dataset's name, a Run's Prompt, or a Process with its branch ("Process · branch"). */
export function stepSourceLabel(state, source) {
  const node = findNode(state, source?.nodeId);
  if (!node) return String(source?.nodeId || '');
  if (node.type === 'run') return runLabel(state, node);
  if (node.type === 'process') {
    const name = String(node.name || '').trim() || 'Process';
    return (source.port || RESULT_PORT) === RESULT_PORT ? name : `${name} · ${source.port}`;
  }
  return String(node.name || '').trim() || 'Dataset';
}

/**
 * Why a step cannot read `source` yet (stepOutputs.js `waiting`), as the windows, a run and the
 * Agent say it.
 */
export function stepInputWaitingMessage(state, source, waiting) {
  if (STEP_KINDS.has(source?.kind)) {
    const name = stepSourceLabel(state, { ...source, port: RESULT_PORT });
    if (waiting === 'missing-port') return `Process "${name}" does not return branch "${source.port}".`;
    return `Waiting for upstream results: run "${name}" first.`;
  }
  return `Input Dataset "${stepSourceLabel(state, source)}" has no current result. Run its upstream node first.`;
}

/**
 * The note a step shows while an upstream Run it reads has rows that failed: they are passed on
 * (§3.7). Empty when there are none.
 */
export function stepInputErrorNotice(state, source, errorRowCount) {
  if (!errorRowCount) return '';
  const rows = `${errorRowCount} row${errorRowCount === 1 ? '' : 's'}`;
  return `Upstream "${stepSourceLabel(state, source)}" has ${rows} with errors; they are passed on with the error text in their output columns.`;
}

// ---------- candidates ----------

/**
 * Every node that reads `nodeId`'s data, directly or further down: through data connections, and
 * through a Dataset that follows a step's result (datasetHistorySource.js) until those are removed.
 */
function downstreamOf(state, nodeId) {
  const children = new Map();
  const link = (from, to) => {
    if (!children.has(from)) children.set(from, []);
    children.get(from).push(to);
  };
  for (const edge of dataEdges(state)) link(String(edge.fromId), String(edge.toId));
  for (const node of state?.nodes || []) {
    const source = node?.type === 'dataset' ? datasetHistorySource(node, state.connections) : null;
    if (source) link(source.sourceId, nodeIdOf(node));
  }
  const found = new Set();
  const queue = [String(nodeId)];
  while (queue.length) {
    for (const child of children.get(queue.shift()) || []) {
      if (!found.has(child)) { found.add(child); queue.push(child); }
    }
  }
  return found;
}

/**
 * Every source a step could read: each Dataset in canvas order, then each Run's results and each
 * Process output branch (processOutputPorts.js), leaving out the step itself and every step that
 * reads it, which would make a cycle. `name` is what an alias is made from (§3.5); `label` is how
 * the source is shown.
 * @returns {Array<{ nodeId: string, port: string, kind: 'dataset'|'run'|'process', name: string, label: string }>}
 */
function candidateSources(state, stepId) {
  const id = String(stepId || '').trim();
  const excluded = downstreamOf(state, id);
  excluded.add(id);
  const nodes = state?.nodes || [];
  const datasets = nodes.filter((node) => node?.type === 'dataset').map((node) => {
    const name = String(node.name || '').trim() || 'Dataset';
    return { nodeId: nodeIdOf(node), port: RESULT_PORT, kind: 'dataset', name, label: name };
  });
  const steps = nodes.filter((node) => STEP_KINDS.has(node?.type) && !excluded.has(nodeIdOf(node))).flatMap((node) => {
    if (node.type === 'run') {
      const label = runLabel(state, node);
      return [{ nodeId: nodeIdOf(node), port: RESULT_PORT, kind: 'run', name: label, label }];
    }
    const { ports } = effectiveProcessOutputs({ detected: node.processOutputPorts, dfResults: node.dfResults });
    return ports.map((port) => {
      const source = { nodeId: nodeIdOf(node), port, kind: 'process' };
      return { ...source, name: port === RESULT_PORT ? String(node.name || '').trim() || 'Process' : port, label: stepSourceLabel(state, source) };
    });
  });
  return [...datasets, ...steps];
}

/**
 * Candidates as the input pickers list them (§5.3): Datasets, then step outputs. A group without
 * items is left out.
 * @returns {Array<{ label: 'Datasets' | 'Step outputs', items: object[] }>}
 */
export function candidateGroups(candidates) {
  return [
    { label: 'Datasets', items: candidates.filter((candidate) => candidate.kind === 'dataset') },
    { label: 'Step outputs', items: candidates.filter((candidate) => candidate.kind !== 'dataset') },
  ].filter((group) => group.items.length);
}

/** Every source a Run could read. */
export function runCandidateSources(state, runId) {
  return candidateSources(state, runId);
}

/** Every source a Process could read. */
export function processCandidateSources(state, processId) {
  return candidateSources(state, processId);
}

// ---------- Run ----------

/** @returns {{ nodeId: string, port: string, kind: string } | null} the source a Run reads */
export function runInputSource(state, runId) {
  const edge = dataEdgesInto(state, runId)[0];
  return edge ? sourceOf(state, edge) : null;
}

/** Points a Run at `source`, or clears its input when `source` is null. Changes `state` in place. */
export function setRunInputSource(state, runId, source) {
  if (!findNode(state, runId)) return;
  removeDataEdgesInto(state, runId);
  if (source?.nodeId) {
    state.connections.push({ type: DATA_EDGE, fromId: String(source.nodeId), fromPort: source.port || RESULT_PORT, toId: nodeIdOf(findNode(state, runId)) });
  }
}

/** The table a Run reads (stepOutputs.js), or null when it has no input or the input has no result yet. */
export function runInputTable(state, runId) {
  return stepOutputTable(state, runInputSource(state, runId)).table || null;
}

// ---------- Process ----------

/** A Process's `df`: the input recorded as df, otherwise its first input. */
export function processPrimarySource(state, processId) {
  const edges = dataEdgesInto(state, processId);
  const edge = edges.find((item) => item.alias === 'df') || edges[0];
  return edge ? sourceOf(state, edge) : null;
}

/**
 * Records `source` as the Process's `df` (connecting it if it is not an input yet), or clears the
 * record when `source` is null. The former df keeps no alias until the inputs are set again. In place.
 */
export function setProcessPrimarySource(state, processId, source) {
  if (!findNode(state, processId)) return;
  const key = keyIn(state, source);
  const edges = dataEdgesInto(state, processId);
  for (const edge of edges) {
    if (edge.alias === 'df' && edgeKey(state, edge) !== key) delete edge.alias;
  }
  if (!key) return;
  const edge = edges.find((item) => edgeKey(state, item) === key);
  if (edge) edge.alias = 'df';
  else state.connections.push({ type: DATA_EDGE, fromId: String(source.nodeId), fromPort: source.port || RESULT_PORT, toId: nodeIdOf(findNode(state, processId)), alias: 'df' });
}

/** The alias each input was recorded with: { sourceKey: alias }. */
export function processInputAliases(state, processId) {
  return Object.fromEntries(dataEdgesInto(state, processId).filter((edge) => edge.alias).map((edge) => [edgeKey(state, edge), edge.alias]));
}

/** A Process's inputs as sources with their aliases; the df input's alias is always 'df'. */
export function processInputSources(state, processId) {
  const primaryKey = keyIn(state, processPrimarySource(state, processId));
  return dataEdgesInto(state, processId).map((edge) => {
    const source = sourceOf(state, edge);
    return { ...source, alias: sourceKey(source) === primaryKey ? 'df' : String(edge.alias || '') };
  });
}

/** The candidates under their keys, as processDatasetBindings.js works on them. */
function keyedCandidates(state, processId) {
  const candidates = processCandidateSources(state, processId).map((candidate) => ({ ...candidate, key: sourceKey(candidate) }));
  return { candidates, byKey: new Map(candidates.map((candidate) => [candidate.key, candidate])) };
}

/**
 * Each candidate as the Process window shows it (processDatasetBindings.js processDatasetInputs):
 * its alias, and whether `code` makes it an input. `primaryId` (a source key) overrides the
 * recorded `df`.
 * @returns {Array<{ key, nodeId, port, kind, name, label, alias, primary, input, used, parameter }>}
 */
export function processInputBindings(state, processId, { code = '', primaryId } = {}) {
  const { candidates, byKey } = keyedCandidates(state, processId);
  const primaryKey = primaryId !== undefined ? String(primaryId || '') : keyIn(state, processPrimarySource(state, processId));
  return processDatasetInputs({
    datasets: candidates.map((candidate) => ({ nodeId: candidate.key, name: candidate.name })),
    primaryDatasetId: primaryKey, savedAliases: processInputAliases(state, processId), code,
  }).map((binding) => {
    const { key, nodeId, port, kind, name, label } = byKey.get(binding.nodeId);
    return { ...binding, key, nodeId, port, kind, name, label };
  });
}

/**
 * What a Process runs with, and what its History record signs: its `df`, every connected input, and
 * every source `code` names by alias, each under its recorded alias or the one its name gives. A
 * connected input that is no longer a candidate (a branch the Process no longer returns) stays an
 * input under its recorded alias, so the Process waits for it instead of running without it.
 * @returns {{ primaryId: string, bindings: Array<{ key, nodeId, port, kind, name, alias, primary }> }}
 *   primaryId is the df input's source key
 */
export function processRequiredInputs(state, processId, { code = '' } = {}) {
  const primaryKey = keyIn(state, processPrimarySource(state, processId));
  if (!primaryKey) return { primaryId: '', bindings: [] };
  const { candidates, byKey } = keyedCandidates(state, processId);
  const savedAliases = processInputAliases(state, processId);
  const aliased = buildProcessDatasetBindings(candidates.map((candidate) => ({ nodeId: candidate.key, name: candidate.name })), primaryKey)
    .map((binding) => ({ ...binding, alias: savedAliases[binding.nodeId] || binding.alias }));
  const connected = processInputSources(state, processId);
  const required = new Set([
    primaryKey,
    ...connected.map(sourceKey),
    ...referencedDatasetAliases(code, aliased, savedAliases),
  ]);
  const bindings = aliased.filter((binding) => required.has(binding.nodeId)).map(({ nodeId: key, alias, primary }) => {
    const { nodeId, port, kind, name } = byKey.get(key);
    return { key, nodeId, port, kind, name, alias, primary };
  });
  for (const source of connected) {
    const key = sourceKey(source);
    if (byKey.has(key)) continue;
    bindings.push({ key, nodeId: source.nodeId, port: source.port, kind: source.kind, name: stepSourceLabel(state, source), alias: source.alias, primary: key === primaryKey });
  }
  return { primaryId: primaryKey, bindings };
}

/**
 * Makes `inputs` exactly the Process's inputs, `primary` its `df`, and records each input's alias.
 * Changes `state` (and its connections array) in place.
 * @param {{ primary: { nodeId: string, port?: string } | null, inputs: Array<{ nodeId: string, port?: string, alias: string }> }} value
 */
export function setProcessInputs(state, processId, { primary, inputs }) {
  const processNode = findNode(state, processId);
  if (!processNode) return;
  const toId = nodeIdOf(processNode);
  const primaryKey = keyIn(state, primary);
  removeDataEdgesInto(state, toId);
  for (const input of inputs) {
    const alias = keyIn(state, input) === primaryKey ? 'df' : input.alias;
    state.connections.push({ type: DATA_EDGE, fromId: String(input.nodeId), fromPort: input.port || RESULT_PORT, toId, ...(alias ? { alias } : {}) });
  }
  if (primaryKey && !inputs.some((input) => keyIn(state, input) === primaryKey)) {
    state.connections.push({ type: DATA_EDGE, fromId: String(primary.nodeId), fromPort: primary.port || RESULT_PORT, toId, alias: 'df' });
  }
}

/**
 * Moves one input of a Process from `from` to `to`, keeping its alias and whether it is `df`, so
 * the code needs no change. In place. Returns false when the Process does not read `from`.
 */
export function replaceProcessInputSource(state, processId, from, to) {
  const key = keyIn(state, from);
  const edge = dataEdgesInto(state, processId).find((item) => edgeKey(state, item) === key);
  if (!edge || !to?.nodeId) return false;
  edge.fromId = String(to.nodeId);
  edge.fromPort = to.port || RESULT_PORT;
  return true;
}

// ---------- every input ----------

/** One { fromId, fromPort, toId, alias } per data connection, in connection order. */
export function stepInputEdges(state) {
  return dataEdges(state).map((edge) => ({
    fromId: String(edge.fromId), fromPort: String(edge.fromPort || RESULT_PORT), toId: String(edge.toId), alias: String(edge.alias || ''),
  }));
}

/** The inputs of the Runs in `state`. */
export function runInputEdges(state) {
  return stepInputEdges(state).filter((edge) => findNode(state, edge.toId)?.type === 'run')
    .map(({ fromId, fromPort, toId }) => ({ fromId, fromPort, toId }));
}

/** The inputs of the Processes in `state`; the df input's alias is always 'df'. */
export function processInputEdges(state) {
  return stepInputEdges(state).filter((edge) => findNode(state, edge.toId)?.type === 'process').map((edge) => ({
    ...edge,
    alias: keyIn(state, processPrimarySource(state, edge.toId)) === keyIn(state, { nodeId: edge.fromId, port: edge.fromPort }) ? 'df' : edge.alias,
  }));
}

/**
 * What breaks the rules above: a Run with more than one input, a Process whose inputs have no df or
 * several, or two inputs of one Process under one alias. Empty when the state is consistent.
 * @returns {string[]}
 */
export function validateStepInputs(state) {
  const problems = [];
  for (const node of state?.nodes || []) {
    const id = nodeIdOf(node);
    const edges = dataEdgesInto(state, id);
    if (node?.type === 'run' && edges.length > 1) problems.push(`Run ${id} has ${edges.length} inputs.`);
    if (node?.type !== 'process' || !edges.length) continue;
    const dfCount = edges.filter((edge) => edge.alias === 'df').length;
    if (dfCount !== 1) problems.push(`Process ${id} has ${dfCount} df inputs.`);
    const aliases = edges.map((edge) => edge.alias).filter(Boolean);
    if (new Set(aliases).size !== aliases.length) problems.push(`Process ${id} uses an alias twice.`);
  }
  return problems;
}
