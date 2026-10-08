/**
 * The one place that reads and writes where a Run or Process gets its data (docs/design/
 * DATA_FLOW_DESIGN.md §3.3). Works on plain canvas state ({ nodes, connections }), as saved by
 * getCanvasState(); workflowCanvas.js adapts it to the live DOM.
 *
 * A source is { nodeId, port }. For now every source is a Dataset and its port is 'result'.
 */
import { buildProcessDatasetBindings, processDatasetInputs, referencedDatasetAliases } from './processDatasetBindings.js';

export const RESULT_PORT = 'result';
const DATASET_TO_PROCESS = 'dataset-to-process';

const nodeIdOf = (node) => String(node?.nodeId || node?.id || '').trim();
const findNode = (state, id) => (state?.nodes || []).find((node) => nodeIdOf(node) === String(id || '').trim());
const datasetsOf = (state) => (state?.nodes || []).filter((node) => node?.type === 'dataset')
  .map((node) => ({ nodeId: nodeIdOf(node), name: node.name || 'Dataset' }));
const processEdgesInto = (state, processId) => (state?.connections || [])
  .filter((edge) => edge?.type === DATASET_TO_PROCESS && String(edge.toId) === String(processId));

function savedAliasesOf(processNode) {
  const value = processNode?.datasetAliases;
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

/** A stable string for a source, for option values and lookups. */
export function sourceKey(source) {
  return source?.nodeId ? String(source.nodeId) : '';
}

/** @returns {{ nodeId: string, port: string } | null} the source a Run reads */
export function runInputSource(state, runId) {
  const id = String(findNode(state, runId)?.runWorkingSetId || '').trim();
  return id ? { nodeId: id, port: RESULT_PORT } : null;
}

/** Points a Run at `source`, or clears its input when `source` is null. Changes `state` in place. */
export function setRunInputSource(state, runId, source) {
  const run = findNode(state, runId);
  if (!run) return;
  if (source?.nodeId) run.runWorkingSetId = String(source.nodeId);
  else delete run.runWorkingSetId;
}

/** The table a Run reads: its input Dataset's content, or null when it has none. */
export function runInputTable(state, runId) {
  const source = runInputSource(state, runId);
  const dataset = source ? findNode(state, source.nodeId) : null;
  return dataset?.datasetContent || dataset?.subsetContent || null;
}

/** One { fromId, fromPort, toId } per Run that has an input, for drawing and Pipeline detection. */
export function runInputEdges(state) {
  return (state?.nodes || []).filter((node) => node?.type === 'run').flatMap((run) => {
    const source = runInputSource(state, nodeIdOf(run));
    return source ? [{ fromId: source.nodeId, fromPort: source.port, toId: nodeIdOf(run) }] : [];
  });
}

/** A Process's `df`: its recorded primary when that Dataset exists, otherwise its first input. */
export function processPrimarySource(state, processId) {
  const recorded = String(findNode(state, processId)?.primaryDatasetId || '').trim();
  if (recorded && findNode(state, recorded)?.type === 'dataset') return { nodeId: recorded, port: RESULT_PORT };
  const first = processEdgesInto(state, processId)[0];
  return first ? { nodeId: String(first.fromId), port: RESULT_PORT } : null;
}

/** Records `source` as the Process's `df` (or clears it) without touching its other inputs. In place. */
export function setProcessPrimarySource(state, processId, source) {
  const processNode = findNode(state, processId);
  if (!processNode) return;
  if (source?.nodeId) processNode.primaryDatasetId = String(source.nodeId);
  else delete processNode.primaryDatasetId;
}

/** The alias each input was recorded with: { sourceNodeId: alias }. */
export function processInputAliases(state, processId) {
  return { ...savedAliasesOf(findNode(state, processId)) };
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
    datasets: datasetsOf(state), primaryDatasetId, savedAliases: savedAliasesOf(findNode(state, processId)), code,
  }).map((binding) => ({ ...binding, port: RESULT_PORT }));
}

/**
 * What a Process runs with, and what its History record signs: its `df`, every connected input, and
 * every Dataset `code` names by alias, each under the alias it has always run with (a saved alias,
 * else the one its name gives). Kept apart from processInputBindings so signatures never change.
 * @returns {{ primaryId: string, bindings: Array<{ nodeId, port, name, alias, primary }> }}
 */
export function processRequiredInputs(state, processId, { code = '' } = {}) {
  const primaryId = processPrimarySource(state, processId)?.nodeId || '';
  if (!primaryId) return { primaryId: '', bindings: [] };
  const savedAliases = savedAliasesOf(findNode(state, processId));
  const aliased = buildProcessDatasetBindings(datasetsOf(state), primaryId)
    .map((binding) => ({ ...binding, alias: savedAliases[binding.nodeId] || binding.alias }));
  const required = new Set([
    primaryId,
    ...processEdgesInto(state, processId).map((edge) => String(edge.fromId)),
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
 * @param {{ primary: { nodeId: string } | null, inputs: Array<{ nodeId: string, alias: string }> }} value
 */
export function setProcessInputs(state, processId, { primary, inputs }) {
  const processNode = findNode(state, processId);
  if (!processNode) return;
  setProcessPrimarySource(state, processId, primary);
  processNode.datasetAliases = JSON.stringify(Object.fromEntries(inputs.map((input) => [String(input.nodeId), input.alias])));
  const connections = state.connections;
  for (let index = connections.length - 1; index >= 0; index -= 1) {
    if (connections[index]?.type === DATASET_TO_PROCESS && String(connections[index].toId) === String(processId)) connections.splice(index, 1);
  }
  for (const input of inputs) connections.push({ fromId: String(input.nodeId), toId: String(processId), type: DATASET_TO_PROCESS });
}

/**
 * Moves one input of a Process from `from` to `to`, keeping its alias and whether it is `df`, so
 * the code needs no change. In place. Returns false when the Process does not read `from`.
 */
export function replaceProcessInputSource(state, processId, from, to) {
  const edge = processEdgesInto(state, processId).find((item) => String(item.fromId) === String(from?.nodeId));
  const processNode = findNode(state, processId);
  if (!edge || !processNode || !to?.nodeId) return false;
  const wasPrimary = processPrimarySource(state, processId)?.nodeId === String(from.nodeId);
  edge.fromId = String(to.nodeId);
  if (wasPrimary) processNode.primaryDatasetId = String(to.nodeId);
  const aliases = savedAliasesOf(processNode);
  if (String(from.nodeId) in aliases) {
    aliases[String(to.nodeId)] = aliases[String(from.nodeId)];
    delete aliases[String(from.nodeId)];
    processNode.datasetAliases = JSON.stringify(aliases);
  }
  return true;
}

/** One { fromId, fromPort, toId, alias } per Process input, in connection order. */
export function processInputEdges(state) {
  return (state?.connections || []).filter((edge) => edge?.type === DATASET_TO_PROCESS).map((edge) => {
    const toId = String(edge.toId);
    const primary = processPrimarySource(state, toId)?.nodeId === String(edge.fromId);
    const alias = primary ? 'df' : String(savedAliasesOf(findNode(state, toId))[String(edge.fromId)] || '');
    return { fromId: String(edge.fromId), fromPort: RESULT_PORT, toId, alias };
  });
}

/** Every Run and Process input, for drawing, colours and Pipeline detection. */
export function stepInputEdges(state) {
  return [...runInputEdges(state), ...processInputEdges(state)];
}
