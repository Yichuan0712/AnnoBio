import { datasetSignature, processInputSignature, runInputSignature, stepOutputSignature } from './runHistorySignature.js';
import { processRequiredInputs, runInputSource, sourceKey } from './stepInputs.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const nodeId = (node) => String(node?.nodeId || node?.id || '');

function parsed(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function processTable(record, branch) {
  const result = parsed(record?.results?.dfResults, null);
  const outputs = result?.outputs && typeof result.outputs === 'object'
    ? result.outputs : (Array.isArray(result?.headers) && Array.isArray(result?.rows) ? { result } : {});
  const table = outputs[branch];
  return table && Array.isArray(table.headers) && Array.isArray(table.rows) ? table : null;
}

function clearResult(node) {
  if (node.type === 'run') {
    for (const key of ['runResults', 'runInputContent', 'runOutputFields', 'runCompleted', 'runProgress', 'runPending', 'runResumable']) delete node[key];
  } else if (node.type === 'process') {
    delete node.dfResults;
    delete node.results;
    delete node.processPending;
    delete node.processResumable;
  }
}

function applyResult(node, record) {
  const result = record.results || {};
  if (node.type === 'run') {
    node.runResults = JSON.stringify(result.runResults || []);
    node.runInputContent = result.runInputContent == null ? undefined : JSON.stringify(result.runInputContent);
    node.runOutputFields = JSON.stringify(result.runOutputFields || []);
    node.runProgress = result.runProgress || (record.status === 'completed' ? 100 : 0);
    node.runCompleted = record.status === 'completed' ? '1' : undefined;
    node.runPending = record.status === 'running';
    node.runResumable = record.status === 'stopped';
  } else {
    node.dfResults = result.dfResults == null ? undefined : JSON.stringify(result.dfResults);
    delete node.results;
    node.processPending = record.status === 'running';
    node.processResumable = record.status === 'stopped';
  }
}

/**
 * Resolve the visible canvas from current inputs and the history index. Nothing is persisted here.
 * A Run or Process without a matching record has its output cache cleared; one with an input that
 * has no result yet also gets `waitingForUpstream`. When its last result no longer matches its
 * inputs, `historyStaleRecordId` points to that record: the node "needs updating", and its window
 * shows the earlier result. Nothing downstream reads it (docs/design/RUN_TO_HERE_PLAN.md step 5).
 */
export async function resolveHistoryCanvasState(state, { index, loadRecord }) {
  const next = copy(state || {});
  next.nodes = Array.isArray(next.nodes) ? next.nodes : [];
  next.connections = Array.isArray(next.connections) ? next.connections : [];
  const nodes = new Map(next.nodes.map((node) => [nodeId(node), node]));
  const indexEntries = Array.isArray(index?.records) ? index.records : [];
  const bySignature = new Map();
  const byId = new Map();
  for (const entry of indexEntries) {
    const key = `${entry.nodeId}\u0000${entry.signature}`;
    if (!bySignature.has(key)) bySignature.set(key, []);
    bySignature.get(key).push(entry);
    byId.set(entry.id, entry);
  }
  const currentRecordIds = {};
  const missingResultNodeIds = [];
  const recordCache = new Map();
  const resolvedNodes = new Map();
  const visiting = new Set();

  /** The completed record a node showed last, if it is still in History. */
  function staleEntry(node) {
    const entry = byId.get(String(node.historyRecordId || node.historyStaleRecordId || ''));
    return entry && entry.nodeId === nodeId(node) && entry.kind === node.type && entry.status === 'completed' ? entry : null;
  }

  async function recordFor(node, signature) {
    const key = `${nodeId(node)}\u0000${signature}`;
    const candidates = bySignature.get(key) || [];
    const preferred = byId.get(String(node.historyRecordId || ''));
    const selectedSignature = String(node.historySelectionSignature || '');
    const entry = preferred?.nodeId === nodeId(node)
      && (preferred?.signature === signature || selectedSignature === signature)
      ? preferred : candidates.at(-1);
    if (!entry || entry.kind !== node.type) return null;
    if (!recordCache.has(entry.id)) recordCache.set(entry.id, Promise.resolve(loadRecord(entry.id)));
    const record = await recordCache.get(entry.id);
    if (!record || record.id !== entry.id || record.signature !== entry.signature || record.nodeId !== nodeId(node)) {
      throw new Error(`History record is missing or invalid: ${entry.id}`);
    }
    return record;
  }

  async function resolveDataset(id) {
    const dataset = nodes.get(id);
    if (!dataset || dataset.type !== 'dataset') return null;
    const content = dataset.datasetContent || dataset.subsetContent;
    return content ? { signature: await datasetSignature({ nodeId: id, content }) } : null;
  }

  /**
   * What one input signs, or null while it has no result: a Dataset's content, or the current
   * completed record of the step whose output it reads (§3.8).
   */
  async function resolveSource(source) {
    if (!source?.nodeId) return null;
    if (source.kind !== 'run' && source.kind !== 'process') {
      const dataset = await resolveDataset(source.nodeId);
      return dataset && { key: sourceKey(source), signature: dataset.signature };
    }
    const upstream = await resolveNode(source.nodeId);
    if (upstream?.status !== 'completed') return null;
    if (source.kind === 'run' ? source.port !== 'result' : !processTable(upstream, source.port)) return null;
    return {
      key: sourceKey(source),
      signature: await stepOutputSignature({ nodeId: source.nodeId, recordId: upstream.id, port: source.port }),
    };
  }

  async function resolveNode(id) {
    if (resolvedNodes.has(id)) return resolvedNodes.get(id);
    const node = nodes.get(id);
    if (!node || !['run', 'process'].includes(node.type)) return null;
    if (visiting.has(id)) throw new Error(`History dependency cycle at ${id}`);
    visiting.add(id);
    try {
      let signature = null;
      let waiting = false;
      if (node.type === 'run') {
        const promptEdge = next.connections.find((edge) => edge.type === 'prompt-to-run' && edge.toId === id);
        const prompt = nodes.get(promptEdge?.fromId);
        const source = runInputSource(next, id);
        const input = await resolveSource(source);
        waiting = !!source && !input;
        if (prompt?.type === 'prompt' && input) {
          signature = await runInputSignature({
            promptNodeId: nodeId(prompt), prompt, datasetNodeId: input.key,
            datasetSignature: input.signature, mapping: parsed(node.runInputToColumn, {}),
          });
        }
      } else {
        const code = String(node.dfCode || node.code || '');
        const { primaryId: primaryDatasetId, bindings: required } = processRequiredInputs(next, id, { code });
        if (primaryDatasetId) {
          const bindings = [];
          for (const binding of required) {
            const input = await resolveSource(binding);
            if (!input) { waiting = true; break; }
            bindings.push({ key: input.key, alias: binding.alias, signature: input.signature });
          }
          if (!waiting && bindings.some((item) => item.key === primaryDatasetId)) {
            signature = await processInputSignature({ code, primaryDatasetId, bindings });
          }
        }
      }
      if (waiting) node.waitingForUpstream = true;
      else delete node.waitingForUpstream;
      const record = signature ? await recordFor(node, signature) : null;
      if (record) {
        applyResult(node, record);
        node.historyRecordId = record.id;
        if (record.signature === signature) delete node.historySelectionSignature;
        delete node.historyStaleRecordId;
        currentRecordIds[id] = record.id;
      } else {
        const stale = staleEntry(node);
        clearResult(node);
        delete node.historyRecordId;
        delete node.historySelectionSignature;
        if (stale) node.historyStaleRecordId = stale.id;
        else delete node.historyStaleRecordId;
        missingResultNodeIds.push(id);
      }
      resolvedNodes.set(id, record);
      return record;
    } finally {
      visiting.delete(id);
    }
  }

  for (const node of next.nodes) {
    if (node.type === 'run' || node.type === 'process') await resolveNode(nodeId(node));
  }
  return { state: next, currentRecordIds, missingResultNodeIds };
}
