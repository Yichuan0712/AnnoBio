/**
 * Brings a saved canvas to the current format. Canvas version 3 stores every Run and Process input
 * as a `data` connection { type: 'data', fromId, fromPort, toId, alias } (docs/design/
 * DATA_FLOW_DESIGN.md §3.3, §9). Every opened, merged or restored project passes through here, and a
 * merged canvas can mix versions, so each node is converted by the fields it carries rather than by
 * `version`; converting twice changes nothing.
 */
import { buildProcessDatasetBindings, referencedDatasetAliases } from './processDatasetBindings.js';

export const CANVAS_VERSION = 3;
const DATA = 'data';
const RESULT = 'result';
const LEGACY_PROCESS_INPUT = 'dataset-to-process';

const nodeIdOf = (node) => String(node?.nodeId || node?.id || '').trim();

function parsedAliases(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * The inputs a version 2 Process ran with and signed in History: its df (the recorded primary when
 * that Dataset exists, else its first input), every connected input, and every Dataset its code names
 * by alias, each under its saved alias or the one its name gives. Frozen copy of the version 2 rules,
 * so the History signatures of upgraded Processes do not change.
 */
function legacyProcessInputs(state, processNode) {
  const processId = nodeIdOf(processNode);
  const datasets = state.nodes.filter((node) => node?.type === 'dataset')
    .map((node) => ({ nodeId: nodeIdOf(node), name: node.name || 'Dataset' }));
  const incoming = state.connections
    .filter((edge) => edge?.type === LEGACY_PROCESS_INPUT && String(edge.toId) === processId)
    .map((edge) => String(edge.fromId));
  const recorded = String(processNode.primaryDatasetId || '').trim();
  const primaryId = datasets.some((dataset) => dataset.nodeId === recorded) ? recorded : (incoming[0] || '');
  if (!primaryId) return [];
  const savedAliases = parsedAliases(processNode.datasetAliases);
  const aliased = buildProcessDatasetBindings(datasets, primaryId)
    .map((binding) => ({ ...binding, alias: savedAliases[binding.nodeId] || binding.alias }));
  const code = String(processNode.dfCode || processNode.code || '');
  const required = new Set([primaryId, ...incoming, ...referencedDatasetAliases(code, aliased, savedAliases)]);
  return aliased.filter((binding) => required.has(binding.nodeId))
    .map((binding) => ({ nodeId: binding.nodeId, alias: binding.nodeId === primaryId ? 'df' : binding.alias }));
}

/** @returns {object} a new canvas state in version 3; `state` is not changed */
export function upgradeCanvasState(state) {
  const next = {
    ...(state || {}),
    nodes: (Array.isArray(state?.nodes) ? state.nodes : []).map((node) => (node && typeof node === 'object' ? { ...node } : node)),
    connections: (Array.isArray(state?.connections) ? state.connections : []).map((edge) => (edge && typeof edge === 'object' ? { ...edge } : edge)),
  };
  const ids = new Set(next.nodes.map(nodeIdOf));
  const hasDataInput = (toId) => next.connections.some((edge) => edge?.type === DATA && String(edge.toId) === toId);
  const added = [];

  for (const node of next.nodes) {
    if (node?.type !== 'process') continue;
    const processId = nodeIdOf(node);
    const legacy = 'primaryDatasetId' in node || 'datasetAliases' in node
      || next.connections.some((edge) => edge?.type === LEGACY_PROCESS_INPUT && String(edge.toId) === processId);
    if (!legacy) continue;
    if (!hasDataInput(processId)) {
      for (const input of legacyProcessInputs(next, node)) {
        added.push({ type: DATA, fromId: input.nodeId, fromPort: RESULT, toId: processId, alias: input.alias });
      }
    }
    delete node.primaryDatasetId;
    delete node.datasetAliases;
  }

  for (const node of next.nodes) {
    if (node?.type !== 'run' || !('runWorkingSetId' in node)) continue;
    const runId = nodeIdOf(node);
    const sourceId = String(node.runWorkingSetId || '').trim();
    delete node.runWorkingSetId;
    if (sourceId && ids.has(sourceId) && !hasDataInput(runId)) {
      added.push({ type: DATA, fromId: sourceId, fromPort: RESULT, toId: runId });
    }
  }

  next.connections = [...next.connections.filter((edge) => edge?.type !== LEGACY_PROCESS_INPUT), ...added];
  next.version = CANVAS_VERSION;
  return next;
}
