/**
 * Brings a saved canvas to the current format. Canvas version 3 stores every Run and Process input
 * as a `data` connection { type: 'data', fromId, fromPort, toId, alias }, and a Dataset saved from a
 * step records that step in `savedFrom` (docs/design/DATA_FLOW_DESIGN.md §3.3, §3.6, §9). Every opened, merged or restored project passes through here, and a
 * merged canvas can mix versions, so each node is converted by the fields it carries rather than by
 * `version`; converting twice changes nothing.
 */
import { buildProcessDatasetBindings, referencedDatasetAliases } from './processDatasetBindings.js';

export const CANVAS_VERSION = 3;
const DATA = 'data';
const RESULT = 'result';
const LEGACY_PROCESS_INPUT = 'dataset-to-process';
const LEGACY_PRODUCER_EDGES = new Set(['process-to-dataset', 'process-to-dataset-snapshot', 'run-to-dataset-snapshot']);
const LEGACY_DATASET_FIELDS = ['sourceRunNodeId', 'processOutputName', 'savedCopy', 'snapshotSourceRecordId',
  'pipelineRunId', 'pipelineLogicalId', 'resultMissing'];

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

  convertSavedDatasets(next);
  next.connections = [
    ...next.connections.filter((edge) => edge?.type !== LEGACY_PROCESS_INPUT && !LEGACY_PRODUCER_EDGES.has(edge?.type)),
    ...added,
  ];
  next.version = CANVAS_VERSION;
  return next;
}

/**
 * Version 2 kept where a Dataset came from in its fields and in producer connections, and read
 * through it (an output that followed History). Every Dataset is now a plain table, and one saved
 * from a step only records that step in `savedFrom` (DATA_FLOW_DESIGN.md §3.6, §9). Changes `state`'s
 * nodes in place; the connections are dropped by the caller.
 */
function convertSavedDatasets(state) {
  for (const node of state.nodes) {
    if (node?.type !== 'dataset') continue;
    const datasetId = nodeIdOf(node);
    const producerEdge = state.connections.find((edge) => LEGACY_PRODUCER_EDGES.has(edge?.type) && String(edge.toId) === datasetId);
    const recordId = String(node.snapshotSourceRecordId || '').trim();
    const runId = String(node.sourceRunNodeId || '').trim();
    let source = null;
    if (runId) source = { kind: 'run', nodeId: runId, port: RESULT };
    else if (producerEdge?.type === 'run-to-dataset-snapshot') source = { kind: 'run', nodeId: String(producerEdge.fromId), port: RESULT };
    else if (producerEdge) {
      source = { kind: 'process', nodeId: String(producerEdge.fromId), port: String(node.processOutputName || '').trim() || RESULT };
    }
    const pipelineRunId = String(node.pipelineRunId || '').trim();
    if (!node.savedFrom && (source || pipelineRunId)) {
      node.savedFrom = pipelineRunId
        ? { kind: 'pipeline', nodeId: source?.nodeId || '', port: source?.port || RESULT, recordId, pipelineRunId }
        : { ...source, recordId };
    }
    for (const field of LEGACY_DATASET_FIELDS) delete node[field];
  }
}
