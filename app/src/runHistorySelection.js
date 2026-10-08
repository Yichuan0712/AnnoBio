import { canonicalJson, datasetSignature, processInputSignature, runInputSignature } from './runHistorySignature.js';
import { datasetHistorySource, publishedPipelineCopy } from './datasetHistorySource.js';
import { RESULT_PORT, runInputSource, setRunInputSource } from './stepInputs.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const nodeId = (node) => String(node?.nodeId || node?.id || '');

/** Preview the input and output connection changes required to select one coherent History lineage. */
export async function planHistorySelection(state, recordId, { loadRecord, recordEntries = [], runningNodeIds = [] }) {
  const next = copy(state || {});
  next.nodes = Array.isArray(next.nodes) ? next.nodes : [];
  next.connections = Array.isArray(next.connections) ? next.connections : [];
  const nodes = new Map(next.nodes.map((node) => [nodeId(node), node]));
  const desired = new Map();
  const selectedRecords = new Map();
  const promptEdges = new Map();
  const runInputs = new Map(); // Run node id -> input Dataset id
  const processInputs = new Map();
  const datasetSources = new Map();
  const active = new Set();
  const recordCache = new Map();
  const originalCurrentRecordIds = new Map(next.nodes
    .filter((node) => ['run', 'process'].includes(node.type) && node.historyRecordId)
    .map((node) => [nodeId(node), String(node.historyRecordId)]));

  async function historyRecord(id) {
    if (!recordCache.has(id)) recordCache.set(id, Promise.resolve(loadRecord(id)));
    return recordCache.get(id);
  }

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
    const upstreamRecordId = dataset.sourceRecordId || dataset.upstreamPipelineRecordId;
    const sourceRecord = upstreamRecordId ? await visitRecord(upstreamRecordId) : null;
    const publishedCopy = publishedPipelineCopy(next, dataset, sourceRecord);
    const resolved = publishedCopy
      ? { ...dataset, nodeId: nodeId(publishedCopy), name: publishedCopy.name || dataset.name }
      : dataset;
    if (dataset.sourceRecordId) {
      if (!dataset.sourceNodeId || !dataset.branch) throw new Error(`History Dataset source is incomplete: ${dataset.nodeId}`);
      if (sourceRecord.nodeId !== dataset.sourceNodeId) throw new Error(`History Dataset source does not match: ${dataset.nodeId}`);
      demandSource(resolved, {
        kind: sourceRecord.kind, nodeId: sourceRecord.nodeId, branch: dataset.branch, recordId: sourceRecord.id,
        preserveSavedCopy: !!publishedCopy,
      });
    } else {
      demandSource(resolved, null);
    }
    const signature = await datasetSignature({
      nodeId: resolved.nodeId,
      content: resolved.content,
      ...((dataset.sourceRecordId && !publishedCopy)
        ? { sourceRecordId: sourceRecord.id, branch: dataset.branch } : {}),
    });
    return { nodeId: resolved.nodeId, signature };
  }

  async function visitRecord(id) {
    if (active.has(id)) throw new Error(`History dependency cycle at record ${id}.`);
    const record = await historyRecord(id);
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
        const resolvedDataset = await visitDataset(dataset);
        const selectionSignature = await runInputSignature({
          promptNodeId: prompt.nodeId, prompt,
          datasetNodeId: resolvedDataset.nodeId, datasetSignature: resolvedDataset.signature,
          mapping: record.inputs.mapping || {},
        });
        runInputs.set(record.nodeId, resolvedDataset.nodeId);
        demand(record.nodeId, 'run', {
          runInputToColumn: JSON.stringify(record.inputs.mapping || {}),
          historyRecordId: record.id,
          historySelectionSignature: selectionSignature,
        });
        promptEdges.set(record.nodeId, prompt.nodeId);
      } else {
        const bindings = record.inputs.bindings;
        if (!Array.isArray(bindings) || !bindings.length || !record.inputs.primaryDatasetId) {
          throw new Error(`Process history inputs are incomplete: ${id}`);
        }
        const resolvedBindings = [];
        for (const binding of bindings) {
          const resolvedDataset = await visitDataset(binding);
          resolvedBindings.push({ binding, ...resolvedDataset });
        }
        const primaryDatasetId = resolvedBindings.find(({ binding }) => (
          binding.nodeId === record.inputs.primaryDatasetId
        ))?.nodeId || record.inputs.primaryDatasetId;
        const code = String(record.inputs.code || '');
        const selectionSignature = await processInputSignature({
          code, primaryDatasetId,
          bindings: resolvedBindings.map(({ binding, nodeId: id, signature }) => ({
            nodeId: id, alias: binding.alias, signature,
          })),
        });
        demand(record.nodeId, 'process', {
          dfCode: code, primaryDatasetId,
          datasetAliases: JSON.stringify(Object.fromEntries(resolvedBindings.map(({ binding, nodeId: id }) => [id, binding.alias]))),
          historyRecordId: record.id,
          historySelectionSignature: selectionSignature,
        });
        processInputs.set(record.nodeId, resolvedBindings.map(({ nodeId: id }) => id));
      }
      return record;
    } finally {
      active.delete(id);
    }
  }

  await visitRecord(recordId);

  function readsRecord(record, upstreamId) {
    if ((record.sourceRecordIds || []).includes(upstreamId)) return true;
    const snapshots = record.kind === 'run' ? [record.inputs?.dataset] : record.inputs?.bindings;
    return (snapshots || []).some((snapshot) => (
      snapshot?.sourceRecordId === upstreamId || snapshot?.upstreamPipelineRecordId === upstreamId
    ));
  }

  // Selecting any point in a saved Pipeline restores the matching Run/Process records on both
  // sides. When the same downstream node was rerun from one parent, retain its current attempt if
  // compatible; otherwise choose the latest saved attempt for that parent.
  if (recordEntries.length) {
    const candidates = (await Promise.all(recordEntries
      .filter((entry) => ['run', 'process'].includes(entry.kind) && nodes.has(entry.nodeId))
      .map((entry) => historyRecord(entry.id))))
      .filter((record) => record?.id && record?.inputs);
    const expanded = new Set();
    while (true) {
      const parentId = [...selectedRecords.values()].find((id) => !expanded.has(id));
      if (!parentId) break;
      expanded.add(parentId);
      const byNode = new Map();
      for (const candidate of candidates) {
        if (selectedRecords.has(candidate.nodeId) || !readsRecord(candidate, parentId)) continue;
        if (!byNode.has(candidate.nodeId)) byNode.set(candidate.nodeId, []);
        byNode.get(candidate.nodeId).push(candidate);
      }
      for (const [childNodeId, records] of byNode) {
        const preferredId = String(nodes.get(childNodeId)?.historyRecordId || '');
        const child = records.find((record) => record.id === preferredId) || records.at(-1);
        await visitRecord(child.id);
      }
    }
  }

  const changedNodeIds = [];
  for (const [id, patch] of desired) {
    const node = nodes.get(id);
    const inputId = runInputs.get(id);
    const inputChanged = inputId !== undefined && runInputSource(next, id)?.nodeId !== inputId;
    if (inputChanged || Object.entries(patch).some(([key, value]) => canonicalJson(node[key]) !== canonicalJson(value))) {
      changedNodeIds.push(id);
    }
    Object.assign(node, patch);
    if (inputId !== undefined) setRunInputSource(next, id, { nodeId: inputId, port: RESULT_PORT });
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
    if (source) {
      if (!source.preserveSavedCopy) delete node.savedCopy;
      node.snapshotSourceRecordId = source.recordId;
    }
    node.sourceRunNodeId = source?.kind === 'run' ? source.nodeId : '';
    node.processOutputName = source?.kind === 'process' ? source.branch : '';
    next.connections = next.connections.filter((edge) => !(edge.toId === id && [
      'run-to-dataset-snapshot', 'process-to-dataset', 'process-to-dataset-snapshot',
    ].includes(edge.type)));
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

  function datasetProducer(dataset) {
    const id = nodeId(dataset);
    if (dataset.sourceRunNodeId) {
      return { kind: 'run', nodeId: String(dataset.sourceRunNodeId), branch: 'result' };
    }
    const edge = next.connections.find((item) => item.toId === id && [
      'run-to-dataset-snapshot', 'process-to-dataset', 'process-to-dataset-snapshot',
    ].includes(item.type));
    if (!edge) return null;
    return {
      kind: edge.type === 'run-to-dataset-snapshot' ? 'run' : 'process',
      nodeId: String(edge.fromId), branch: String(dataset.processOutputName || 'result'),
    };
  }

  function setDatasetOutput(dataset, source, live, sourceRecordId) {
    const id = nodeId(dataset);
    const wasSavedCopy = !!dataset.savedCopy;
    const before = canonicalJson({
      sourceRunNodeId: dataset.sourceRunNodeId || '', processOutputName: dataset.processOutputName || '',
      savedCopy: !!dataset.savedCopy, snapshotSourceRecordId: dataset.snapshotSourceRecordId || '',
      edges: next.connections.filter((edge) => edge.toId === id && [
        'run-to-dataset-snapshot', 'process-to-dataset', 'process-to-dataset-snapshot',
      ].includes(edge.type)),
    });
    delete dataset.sourceRunNodeId;
    dataset.processOutputName = source.kind === 'process' ? source.branch : '';
    if (wasSavedCopy) dataset.savedCopy = true;
    else delete dataset.savedCopy;
    if (sourceRecordId) dataset.snapshotSourceRecordId = sourceRecordId;
    next.connections = next.connections.filter((edge) => !(edge.toId === id && [
      'run-to-dataset-snapshot', 'process-to-dataset', 'process-to-dataset-snapshot',
    ].includes(edge.type)));
    if (source.kind === 'run') {
      if (live) dataset.sourceRunNodeId = source.nodeId;
      else next.connections.push({ type: 'run-to-dataset-snapshot', fromId: source.nodeId, toId: id });
    } else {
      next.connections.push({
        type: live ? 'process-to-dataset' : 'process-to-dataset-snapshot', fromId: source.nodeId, toId: id,
      });
    }
    const after = canonicalJson({
      sourceRunNodeId: dataset.sourceRunNodeId || '', processOutputName: dataset.processOutputName || '',
      savedCopy: !!dataset.savedCopy, snapshotSourceRecordId: dataset.snapshotSourceRecordId || '',
      edges: next.connections.filter((edge) => edge.toId === id && [
        'run-to-dataset-snapshot', 'process-to-dataset', 'process-to-dataset-snapshot',
      ].includes(edge.type)),
    });
    if (before !== after && !changedNodeIds.includes(id)) changedNodeIds.push(id);
  }

  // Exactly the Dataset snapshots created from a selected record become its live outputs. Other
  // outputs of that Run/Process remain connected as dashed, immutable History snapshots.
  const selectedInputDatasetIds = new Set([...processInputs.values()].flat());
  for (const inputId of runInputs.values()) {
    if (inputId) selectedInputDatasetIds.add(inputId);
  }
  for (const [producerNodeId, selectedRecordId] of selectedRecords) {
    const producer = nodes.get(producerNodeId);
    if (!producer || !['run', 'process'].includes(producer.type)) continue;
    const outputsByBranch = new Map();
    for (const dataset of next.nodes.filter((node) => node.type === 'dataset')) {
      const source = datasetProducer(dataset);
      if (!source || source.nodeId !== producerNodeId || source.kind !== producer.type) continue;
      if (!outputsByBranch.has(source.branch)) outputsByBranch.set(source.branch, []);
      outputsByBranch.get(source.branch).push({ dataset, source });
    }
    for (const outputs of outputsByBranch.values()) {
      const matching = outputs.filter(({ dataset }) => {
        const savedRecordId = String(dataset.snapshotSourceRecordId || '');
        return savedRecordId === selectedRecordId
          || (!savedRecordId && !dataset.savedCopy
            && originalCurrentRecordIds.get(producerNodeId) === selectedRecordId);
      });
      const active = matching.find(({ dataset }) => selectedInputDatasetIds.has(nodeId(dataset)))
        || matching.find(({ dataset }) => !dataset.savedCopy)
        || matching.at(-1)
        || null;
      for (const { dataset, source } of outputs) {
        const savedRecordId = String(dataset.snapshotSourceRecordId || '');
        const previousRecordId = String(dataset.snapshotSourceRecordId
          || originalCurrentRecordIds.get(producerNodeId) || '');
        const live = active?.dataset === dataset;
        setDatasetOutput(dataset, source, live, live ? selectedRecordId : (savedRecordId || previousRecordId));
      }
    }
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
    if (node.type === 'run') link(runInputSource(next, nodeId(node))?.nodeId, nodeId(node));
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
