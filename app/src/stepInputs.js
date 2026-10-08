/**
 * The one place that reads and writes where a Run or Process gets its data (docs/design/
 * DATA_FLOW_DESIGN.md §3.3). Works on plain canvas state ({ nodes, connections }), as saved by
 * getCanvasState(); workflowCanvas.js adapts it to the live DOM.
 *
 * Every input is a `data` connection { type: 'data', fromId, fromPort, toId, alias }. A Run has at
 * most one. A Process has one per input; `alias` is the name its code uses, 'df' for the primary.
 * A source is { nodeId, port }. For now every source is a Dataset and its port is 'result'.
 */
import { buildProcessDatasetBindings, processDatasetInputs, referencedDatasetAliases } from './processDatasetBindings.js';

export const RESULT_PORT = 'result';
export const DATA_EDGE = 'data';

const nodeIdOf = (node) => String(node?.nodeId || node?.id || '').trim();
const findNode = (state, id) => (state?.nodes || []).find((node) => nodeIdOf(node) === String(id || '').trim());
const datasetsOf = (state) => (state?.nodes || []).filter((node) => node?.type === 'dataset')
  .map((node) => ({ nodeId: nodeIdOf(node), name: node.name || 'Dataset' }));
const dataEdges = (state) => (state?.connections || []).filter((edge) => edge?.type === DATA_EDGE);
const dataEdgesInto = (state, toId) => dataEdges(state).filter((edge) => String(edge.toId) === String(toId).trim());
const sourceOf = (edge) => ({ nodeId: String(edge.fromId), port: String(edge.fromPort || RESULT_PORT) });

/** Removes every data connection into `toId`, in place, so the live connections array stays shared. */
function removeDataEdgesInto(state, toId) {
  const connections = state.connections;
  for (let index = connections.length - 1; index >= 0; index -= 1) {
    if (connections[index]?.type === DATA_EDGE && String(connections[index].toId) === String(toId)) connections.splice(index, 1);
  }
}

/** A stable string for a source, for option values and lookups. */
export function sourceKey(source) {
  return source?.nodeId ? String(source.nodeId) : '';
}

// ---------- Run ----------

/** @returns {{ nodeId: string, port: string } | null} the source a Run reads */
export function runInputSource(state, runId) {
  const edge = dataEdgesInto(state, runId)[0];
  return edge ? sourceOf(edge) : null;
}

/** Points a Run at `source`, or clears its input when `source` is null. Changes `state` in place. */
export function setRunInputSource(state, runId, source) {
  if (!findNode(state, runId)) return;
  removeDataEdgesInto(state, runId);
  if (source?.nodeId) {
    state.connections.push({ type: DATA_EDGE, fromId: String(source.nodeId), fromPort: source.port || RESULT_PORT, toId: nodeIdOf(findNode(state, runId)) });
  }
}

/** The table a Run reads: its input Dataset's content, or null when it has none. */
export function runInputTable(state, runId) {
  const source = runInputSource(state, runId);
  const dataset = source ? findNode(state, source.nodeId) : null;
  return dataset?.datasetContent || dataset?.subsetContent || null;
}

// ---------- Process ----------

/** A Process's `df`: the input recorded as df, otherwise its first input. */
export function processPrimarySource(state, processId) {
  const edges = dataEdgesInto(state, processId);
  const edge = edges.find((item) => item.alias === 'df') || edges[0];
  return edge ? sourceOf(edge) : null;
}

/**
 * Records `source` as the Process's `df` (connecting it if it is not an input yet), or clears the
 * record when `source` is null. The former df keeps no alias until the inputs are set again. In place.
 */
export function setProcessPrimarySource(state, processId, source) {
  if (!findNode(state, processId)) return;
  const edges = dataEdgesInto(state, processId);
  for (const edge of edges) {
    if (edge.alias === 'df' && String(edge.fromId) !== String(source?.nodeId || '')) delete edge.alias;
  }
  if (!source?.nodeId) return;
  const edge = edges.find((item) => String(item.fromId) === String(source.nodeId));
  if (edge) edge.alias = 'df';
  else state.connections.push({ type: DATA_EDGE, fromId: String(source.nodeId), fromPort: source.port || RESULT_PORT, toId: nodeIdOf(findNode(state, processId)), alias: 'df' });
}

/** The alias each input was recorded with: { sourceNodeId: alias }. */
export function processInputAliases(state, processId) {
  return Object.fromEntries(dataEdgesInto(state, processId).filter((edge) => edge.alias).map((edge) => [String(edge.fromId), edge.alias]));
}

/** Every source a Process could read, in canvas order. */
export function processCandidateSources(state, processId) {
  return datasetsOf(state).map((dataset) => ({ ...dataset, port: RESULT_PORT, kind: 'dataset' }));
}

/**
 * Each candidate as the Process window shows it (processDatasetBindings.js processDatasetInputs):
 * its alias, and whether `code` makes it an input. `primaryId` overrides the recorded `df`.
 * @returns {Array<{ nodeId, port, name, alias, primary, input, used, parameter }>}
 */
export function processInputBindings(state, processId, { code = '', primaryId } = {}) {
  const primaryDatasetId = primaryId !== undefined ? String(primaryId || '') : (processPrimarySource(state, processId)?.nodeId || '');
  return processDatasetInputs({
    datasets: datasetsOf(state), primaryDatasetId, savedAliases: processInputAliases(state, processId), code,
  }).map((binding) => ({ ...binding, port: RESULT_PORT }));
}

/**
 * What a Process runs with, and what its History record signs: its `df`, every connected input, and
 * every Dataset `code` names by alias, each under its recorded alias or the one its name gives.
 * @returns {{ primaryId: string, bindings: Array<{ nodeId, port, name, alias, primary }> }}
 */
export function processRequiredInputs(state, processId, { code = '' } = {}) {
  const primaryId = processPrimarySource(state, processId)?.nodeId || '';
  if (!primaryId) return { primaryId: '', bindings: [] };
  const savedAliases = processInputAliases(state, processId);
  const aliased = buildProcessDatasetBindings(datasetsOf(state), primaryId)
    .map((binding) => ({ ...binding, alias: savedAliases[binding.nodeId] || binding.alias }));
  const required = new Set([
    primaryId,
    ...dataEdgesInto(state, processId).map((edge) => String(edge.fromId)),
    ...referencedDatasetAliases(code, aliased, savedAliases),
  ]);
  return {
    primaryId,
    bindings: aliased.filter((binding) => required.has(binding.nodeId))
      .map(({ nodeId, name, alias, primary }) => ({ nodeId, port: RESULT_PORT, name, alias, primary })),
  };
}

/**
 * Makes `inputs` exactly the Process's inputs, `primary` its `df`, and records each input's alias.
 * Changes `state` (and its connections array) in place.
 * @param {{ primary: { nodeId: string } | null, inputs: Array<{ nodeId: string, port?: string, alias: string }> }} value
 */
export function setProcessInputs(state, processId, { primary, inputs }) {
  const processNode = findNode(state, processId);
  if (!processNode) return;
  const toId = nodeIdOf(processNode);
  const primaryId = String(primary?.nodeId || '');
  removeDataEdgesInto(state, toId);
  for (const input of inputs) {
    const fromId = String(input.nodeId);
    const alias = fromId === primaryId ? 'df' : input.alias;
    state.connections.push({ type: DATA_EDGE, fromId, fromPort: input.port || RESULT_PORT, toId, ...(alias ? { alias } : {}) });
  }
  if (primaryId && !inputs.some((input) => String(input.nodeId) === primaryId)) {
    state.connections.push({ type: DATA_EDGE, fromId: primaryId, fromPort: primary.port || RESULT_PORT, toId, alias: 'df' });
  }
}

/**
 * Moves one input of a Process from `from` to `to`, keeping its alias and whether it is `df`, so
 * the code needs no change. In place. Returns false when the Process does not read `from`.
 */
export function replaceProcessInputSource(state, processId, from, to) {
  const edge = dataEdgesInto(state, processId).find((item) => String(item.fromId) === String(from?.nodeId));
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
    ...edge, alias: processPrimarySource(state, edge.toId)?.nodeId === edge.fromId ? 'df' : edge.alias,
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
