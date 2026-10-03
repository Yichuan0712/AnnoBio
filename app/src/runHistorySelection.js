import { canonicalJson } from './runHistorySignature.js';
import { datasetHistorySource } from './datasetHistorySource.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const nodeId = (node) => String(node?.nodeId || node?.id || '');

/** Preview the input changes required to select a Run/Process record and its ancestors. */
export async function planHistorySelection(state, recordId, { loadRecord, runningNodeIds = [] }) {
  const next = copy(state || {});
  next.nodes = Array.isArray(next.nodes) ? next.nodes : [];
  next.connections = Array.isArray(next.connections) ? next.connections : [];
  const nodes = new Map(next.nodes.map((node) => [nodeId(node), node]));
  const desired = new Map();
  const selectedRecords = new Map();
  const promptEdges = new Map();
  const processInputs = new Map();
  const datasetSources = new Map();
  const active = new Set();

  function requireNode(id, type) {
    const node = nodes.get(String(id || ''));
    if (!node || node.type !== type) throw new Error(`History needs a missing ${type} node: ${id}`);
    return node;
  }

  function demand(id, type, patch) {
    requireNode(id, type);
    const values = desired.get(id) || {};
    for (const [key, value] of Object.entries(patch)) {
      if (Object.hasOwn(values, key) && canonicalJson(values[key]) !== canonicalJson(value)) {
        throw new Error(`History selection conflicts at ${type} node ${id}.`);
      }
      values[key] = copy(value);
    }
    desired.set(id, values);
  }

  function demandSource(dataset, source) {
    const id = String(dataset?.nodeId || '');
    requireNode(id, 'dataset');
    if (datasetSources.has(id) && canonicalJson(datasetSources.get(id)) !== canonicalJson(source)) {
      throw new Error(`History selection conflicts at dataset node ${id}.`);
    }
    datasetSources.set(id, source);
    demand(id, 'dataset', { datasetContent: dataset.content });
  }

  async function visitDataset(dataset) {
    if (!dataset?.nodeId || !dataset.content) throw new Error('History Dataset snapshot is incomplete.');
    if (dataset.sourceRecordId) {
      if (!dataset.sourceNodeId || !dataset.branch) throw new Error(`History Dataset source is incomplete: ${dataset.nodeId}`);
      const sourceRecord = await visitRecord(dataset.sourceRecordId);
      if (sourceRecord.nodeId !== dataset.sourceNodeId) throw new Error(`History Dataset source does not match: ${dataset.nodeId}`);
      demandSource(dataset, { kind: sourceRecord.kind, nodeId: sourceRecord.nodeId, branch: dataset.branch });
    } else {
      demandSource(dataset, null);
    }
  }

  async function visitRecord(id) {
    if (active.has(id)) throw new Error(`History dependency cycle at record ${id}.`);
    const record = await loadRecord(id);
    if (!record || record.id !== id || !['run', 'process'].includes(record.kind) || !record.inputs) {
      throw new Error(`History record is missing or invalid: ${id}`);
    }
    const previous = selectedRecords.get(record.nodeId);
    if (previous && previous !== id) throw new Error(`History selection conflicts at ${record.kind} node ${record.nodeId}.`);
    if (previous) return record;
    requireNode(record.nodeId, record.kind);
    selectedRecords.set(record.nodeId, id);
    active.add(id);
    try {
      if (record.kind === 'run') {
        const prompt = record.inputs.prompt;
        const dataset = record.inputs.dataset;
        if (!prompt?.nodeId || !dataset?.nodeId) throw new Error(`Run history inputs are incomplete: ${id}`);
        demand(prompt.nodeId, 'prompt', {
          sections: prompt.sections || [], outputFormat: prompt.outputFormat || { returnShape: 'single', fields: [] },
          inputTypes: prompt.inputTypes || {},
        });
        await visitDataset(dataset);
        demand(record.nodeId, 'run', {
          runWorkingSetId: dataset.nodeId, runInputToColumn: JSON.stringify(record.inputs.mapping || {}),
          historyRecordId: record.id,
        });
        promptEdges.set(record.nodeId, prompt.nodeId);
      } else {
        const bindings = record.inputs.bindings;
        if (!Array.isArray(bindings) || !bindings.length || !record.inputs.primaryDatasetId) {
          throw new Error(`Process history inputs are incomplete: ${id}`);
        }
        for (const binding of bindings) await visitDataset(binding);
        demand(record.nodeId, 'process', {
          dfCode: String(record.inputs.code || ''), primaryDatasetId: record.inputs.primaryDatasetId,
          datasetAliases: JSON.stringify(Object.fromEntries(bindings.map((binding) => [binding.nodeId, binding.alias]))),
          historyRecordId: record.id,
        });
        processInputs.set(record.nodeId, bindings.map((binding) => binding.nodeId));
      }
      return record;
    } finally {
      active.delete(id);
    }
  }

  await visitRecord(recordId);
  const changedNodeIds = [];
  for (const [id, patch] of desired) {
    const node = nodes.get(id);
    if (Object.entries(patch).some(([key, value]) => canonicalJson(node[key]) !== canonicalJson(value))) {
      changedNodeIds.push(id);
    }
    Object.assign(node, patch);
  }
  for (const [id, source] of datasetSources) {
    const node = nodes.get(id);
    // A saved copy (datasetHistorySource.js) or a legacy snapshot keeps its pipeline link; it is still an
    // independent input table, so only its content is restored.
    if (!source && (node.savedCopy || next.connections.some((edge) => (
      edge.toId === id && ['run-to-dataset-snapshot', 'process-to-dataset-snapshot'].includes(edge.type)
    )))) continue;
    const oldSource = datasetHistorySource(node, next.connections)?.sourceId || '';
    const newSource = source?.nodeId || '';
    if (oldSource !== newSource && !changedNodeIds.includes(id)) changedNodeIds.push(id);
    // A record made while this output still followed History restores that, too.
    if (source) delete node.savedCopy;
    node.sourceRunNodeId = source?.kind === 'run' ? source.nodeId : '';
    node.processOutputName = source?.kind === 'process' ? source.branch : '';
    next.connections = next.connections.filter((edge) => !(edge.type === 'process-to-dataset' && edge.toId === id));
    if (source?.kind === 'process') next.connections.push({ type: 'process-to-dataset', fromId: source.nodeId, toId: id });
  }
  for (const [id, promptId] of promptEdges) {
    const oldPromptId = next.connections.find((edge) => edge.type === 'prompt-to-run' && edge.toId === id)?.fromId;
    if (oldPromptId !== promptId && !changedNodeIds.includes(id)) changedNodeIds.push(id);
    next.connections = next.connections.filter((edge) => !(edge.type === 'prompt-to-run' && edge.toId === id));
    next.connections.push({ type: 'prompt-to-run', fromId: promptId, toId: id });
  }
  for (const [id, datasetIds] of processInputs) {
    const oldIds = next.connections.filter((edge) => edge.type === 'dataset-to-process' && edge.toId === id).map((edge) => edge.fromId).sort();
    if (canonicalJson(oldIds) !== canonicalJson(datasetIds.slice().sort()) && !changedNodeIds.includes(id)) changedNodeIds.push(id);
    next.connections = next.connections.filter((edge) => !(edge.type === 'dataset-to-process' && edge.toId === id));
    datasetIds.forEach((datasetId) => next.connections.push({ type: 'dataset-to-process', fromId: datasetId, toId: id }));
  }

  // A changed ancestor also changes every descendant's visible result, even if its own inputs
  // are not directly rewritten by this planner. Block a switch while any such node is running.
  const affected = new Set([...selectedRecords.keys(), ...changedNodeIds]);
  const adjacency = new Map();
  const link = (from, to) => {
    if (!from || !to) return;
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from).add(to);
  };
  for (const edge of [...(state?.connections || []), ...next.connections]) link(edge.fromId, edge.toId);
  for (const node of next.nodes) {
    if (node.type === 'run') link(node.runWorkingSetId, nodeId(node));
    if (node.type === 'dataset') link(node.sourceRunNodeId, nodeId(node));
  }
  const queue = [...affected];
  while (queue.length) {
    for (const child of adjacency.get(queue.shift()) || []) {
      if (!affected.has(child)) { affected.add(child); queue.push(child); }
    }
  }
  const running = new Set(runningNodeIds);
  const blocked = [...affected].find((id) => running.has(id));
  if (blocked) throw new Error(`Cannot switch history while node ${blocked} is running.`);
  return { state: next, selectedRecordIds: Object.fromEntries(selectedRecords), changedNodeIds, affectedNodeIds: [...affected] };
}
