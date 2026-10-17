import { canonicalJson, datasetSignature, processInputSignature, runInputSignature, stepOutputSignature } from './runHistorySignature.js';
import {
  RESULT_PORT, processInputSources, processPrimarySource, runInputSource, setProcessInputs, setRunInputSource, sourceKey,
} from './stepInputs.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const nodeId = (node) => String(node?.nodeId || node?.id || '');

/** A Process's df and its inputs with their aliases, by source key and sorted, for telling whether a selection changes them. */
function processInputsOf(state, processId) {
  return {
    primary: sourceKey(processPrimarySource(state, processId)),
    inputs: processInputSources(state, processId)
      .map((source) => [sourceKey(source), source.alias]).sort(([a], [b]) => a.localeCompare(b)),
  };
}

/** processInputsOf for the inputs a selected record gives a Process, written the way setProcessInputs stores them. */
function selectedProcessInputs(processId, { primary, inputs }) {
  const state = {
    nodes: [{ nodeId: processId, type: 'process' }, ...[primary, ...inputs].map((input) => ({ nodeId: input.nodeId, type: input.kind }))],
    connections: [],
  };
  setProcessInputs(state, processId, { primary, inputs });
  return processInputsOf(state, processId);
}

/** The key a recorded input was signed under: a Dataset's node ID, or `node:port` for a step's output. */
const recordedInputKey = (input) => (input?.kind === 'step' ? `${input.nodeId}:${input.port || RESULT_PORT}` : String(input?.nodeId || ''));

/** Preview the input changes required to select one coherent History lineage. */
export async function planHistorySelection(state, recordId, { loadRecord, recordEntries = [], runningNodeIds = [] }) {
  const next = copy(state || {});
  next.nodes = Array.isArray(next.nodes) ? next.nodes : [];
  next.connections = Array.isArray(next.connections) ? next.connections : [];
  const nodes = new Map(next.nodes.map((node) => [nodeId(node), node]));
  const desired = new Map();
  const selectedRecords = new Map();
  const promptEdges = new Map();
  const scoreEdges = new Map();
  const runInputs = new Map(); // Generate node id -> input source { nodeId, port, kind }
  const processInputs = new Map(); // Process node id -> { primary: source, inputs: [{ nodeId, port, kind, alias }] }
  const active = new Set();
  const recordCache = new Map();

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

  /** A recorded Dataset input: its table is restored, so the node reads what the record read. */
  async function visitDataset(dataset) {
    if (!dataset?.nodeId || !dataset.content) throw new Error('History Dataset snapshot is incomplete.');
    demand(dataset.nodeId, 'dataset', { datasetContent: dataset.content });
    const signature = await datasetSignature({ nodeId: dataset.nodeId, content: dataset.content });
    return { nodeId: dataset.nodeId, port: RESULT_PORT, kind: 'dataset', key: dataset.nodeId, signature };
  }

  /**
   * Selects the upstream record a recorded step input refers to, so its output is what the node
   * reads again, and returns the input as a source with its signature. A record without `kind`
   * predates step inputs and reads a Dataset.
   */
  async function visitInput(input) {
    if (input?.kind !== 'step') return visitDataset(input);
    if (!input.nodeId || !input.recordId) throw new Error('History step input is incomplete.');
    const upstream = await visitRecord(input.recordId);
    if (upstream.nodeId !== input.nodeId) throw new Error(`History step input does not match: ${input.nodeId}`);
    const port = String(input.port || RESULT_PORT);
    return {
      nodeId: input.nodeId, port, kind: upstream.kind, key: `${input.nodeId}:${port}`,
      signature: await stepOutputSignature({ nodeId: input.nodeId, recordId: upstream.id, port }),
    };
  }

  async function visitRecord(id) {
    if (active.has(id)) throw new Error(`History dependency cycle at record ${id}.`);
    const record = await historyRecord(id);
    if (!record || record.id !== id || !['run', 'process', 'score'].includes(record.kind) || !record.inputs) {
      throw new Error(`History record is missing or invalid: ${id}`);
    }
    const previous = selectedRecords.get(record.nodeId);
    if (previous && previous !== id) throw new Error(`History selection conflicts at ${record.kind} node ${record.nodeId}.`);
    if (previous) return record;
    requireNode(record.nodeId, record.kind);
    selectedRecords.set(record.nodeId, id);
    active.add(id);
    try {
      if (record.kind === 'score') {
        if (record.evaluationVersion !== 1 || record.status !== 'completed' || !record.inputs.groundTruth?.content) {
          throw new Error('This legacy evaluation has no complete input snapshot. Run Evaluate to create one.');
        }
        const upstream = await visitRecord(record.inputs.runRecordId);
        if (upstream.kind !== 'run' || upstream.nodeId !== record.inputs.runNodeId) throw new Error('Evaluate history source is invalid.');
        await visitDataset(record.inputs.groundTruth);
        demand(record.nodeId, 'score', {
          scoreGroundTruthId: record.inputs.groundTruthId,
          scoreMapping: typeof record.inputs.mapping === 'string' ? record.inputs.mapping : JSON.stringify(record.inputs.mapping),
          scoreMatchCode: record.inputs.matchCode || '', scoreActiveMatchMode: record.inputs.activeMatchMode,
          scoreRowExcludedFromScoring: record.inputs.exclusions || {}, historyRecordId: record.id,
        });
        scoreEdges.set(record.nodeId, upstream.nodeId);
      } else if (record.kind === 'run') {
        const prompt = record.inputs.prompt;
        const dataset = record.inputs.dataset;
        if (!prompt?.nodeId || !dataset?.nodeId) throw new Error(`Generate history inputs are incomplete: ${id}`);
        demand(prompt.nodeId, 'prompt', {
          text: String(prompt.text || ''), outputFormat: prompt.outputFormat || { returnShape: 'single', fields: [] },
        });
        const input = await visitInput(dataset);
        const selectionSignature = await runInputSignature({
          promptNodeId: prompt.nodeId, prompt,
          datasetNodeId: input.key, datasetSignature: input.signature,
          mapping: record.inputs.mapping || {},
        });
        runInputs.set(record.nodeId, { nodeId: input.nodeId, port: input.port, kind: input.kind });
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
          const input = await visitInput(binding);
          resolvedBindings.push({ binding, ...input });
        }
        const primary = resolvedBindings.find(({ binding }) => recordedInputKey(binding) === record.inputs.primaryDatasetId);
        if (!primary) throw new Error(`Process history inputs are incomplete: ${id}`);
        const code = String(record.inputs.code || '');
        const selectionSignature = await processInputSignature({
          code, primaryDatasetId: primary.key,
          bindings: resolvedBindings.map(({ binding, key, signature }) => ({ key, alias: binding.alias, signature })),
        });
        demand(record.nodeId, 'process', {
          dfCode: code,
          historyRecordId: record.id,
          historySelectionSignature: selectionSignature,
        });
        processInputs.set(record.nodeId, {
          primary: { nodeId: primary.nodeId, port: primary.port, kind: primary.kind },
          inputs: resolvedBindings.map(({ binding, nodeId: inputId, port, kind }) => ({ nodeId: inputId, port, kind, alias: binding.alias })),
        });
      }
      return record;
    } finally {
      active.delete(id);
    }
  }

  await visitRecord(recordId);

  /** Whether a record read an output of `upstreamId`: a step input refers to it (§3.8). */
  function readsRecord(record, upstreamId) {
    const inputs = record.kind === 'run' ? [record.inputs?.dataset] : record.inputs?.bindings;
    return (inputs || []).some((input) => input?.kind === 'step' && input.recordId === upstreamId);
  }

  // Selecting any point in a saved Pipeline restores the matching Generate/Process records on both
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
    const runInput = runInputs.get(id);
    const processInput = processInputs.get(id);
    const inputChanged = (runInput !== undefined && sourceKey(runInputSource(next, id)) !== sourceKey(runInput))
      || (processInput !== undefined && canonicalJson(processInputsOf(next, id)) !== canonicalJson(selectedProcessInputs(id, processInput)));
    if (inputChanged || Object.entries(patch).some(([key, value]) => canonicalJson(node[key]) !== canonicalJson(value))) {
      changedNodeIds.push(id);
    }
    Object.assign(node, patch);
    if (runInput !== undefined) setRunInputSource(next, id, runInput);
    if (processInput !== undefined) setProcessInputs(next, id, processInput);
  }
  for (const [id, promptId] of promptEdges) {
    const oldPromptId = next.connections.find((edge) => edge.type === 'prompt-to-run' && edge.toId === id)?.fromId;
    if (oldPromptId !== promptId && !changedNodeIds.includes(id)) changedNodeIds.push(id);
    next.connections = next.connections.filter((edge) => !(edge.type === 'prompt-to-run' && edge.toId === id));
    next.connections.push({ type: 'prompt-to-run', fromId: promptId, toId: id });
  }
  for (const [id, runId] of scoreEdges) {
    next.connections = next.connections.filter(edge => !(edge.type === 'run-to-score' && edge.toId === id));
    next.connections.push({ type: 'run-to-score', fromId: runId, toId: id });
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
