import { datasetSignature, processInputSignature, runInputSignature } from './runHistorySignature.js';
import { buildProcessDatasetBindings, referencedDatasetAliases } from './processDatasetBindings.js';
import { buildRunResultsTable } from './runResultsExport.js';
import { cloneCell } from './datasetContent.js';
import { historyEditFor } from './datasetHistoryEdits.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const nodeId = (node) => String(node?.nodeId || node?.id || '');
const emptyTable = () => ({ headers: [], rows: [], columnTypes: [], rowIds: [] });

function parsed(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function runTable(record) {
  const results = parsed(record?.results?.runResults, []);
  if (!Array.isArray(results) || (!results.length && record?.status !== 'completed')) return null;
  const format = record.inputs?.prompt?.outputFormat;
  return buildRunResultsTable({
    results,
    runContent: parsed(record.results?.runInputContent, null),
    schemaFields: Array.isArray(format) ? format : format?.fields || [],
  });
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
 * Missing current results clear node output caches and all dependent derived Dataset content.
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
  const missingDatasetIds = [];
  const missingResultNodeIds = [];
  const recordCache = new Map();
  const resolvedNodes = new Map();
  const visiting = new Set();

  async function recordFor(node, signature) {
    const key = `${nodeId(node)}\u0000${signature}`;
    const candidates = bySignature.get(key) || [];
    const preferred = byId.get(String(node.historyRecordId || ''));
    const entry = preferred?.nodeId === nodeId(node) && preferred?.signature === signature
      ? preferred : candidates.at(-1);
    if (!entry || entry.kind !== node.type) return null;
    if (!recordCache.has(entry.id)) recordCache.set(entry.id, Promise.resolve(loadRecord(entry.id)));
    const record = await recordCache.get(entry.id);
    if (!record || record.id !== entry.id || record.signature !== signature || record.nodeId !== nodeId(node)) {
      throw new Error(`History record is missing or invalid: ${entry.id}`);
    }
    return record;
  }

  async function resolveDataset(id) {
    const dataset = nodes.get(id);
    if (!dataset || dataset.type !== 'dataset') return null;
    const runSourceId = String(dataset.sourceRunNodeId || '');
    const processEdge = !runSourceId && next.connections.find((edge) => edge.type === 'process-to-dataset' && edge.toId === id);
    const sourceId = runSourceId || processEdge?.fromId;
    if (sourceId) {
      const branch = runSourceId ? 'result' : String(dataset.processOutputName || 'result');
      const source = await resolveNode(sourceId);
      const table = source && (runSourceId ? runTable(source) : processTable(source, branch));
      if (!table) {
        dataset.datasetContent = emptyTable();
        dataset.resultMissing = true;
        delete dataset.historyEdited;
        if (!missingDatasetIds.includes(id)) missingDatasetIds.push(id);
        return null;
      }
      delete dataset.resultMissing;
      const edited = historyEditFor(dataset.historyEdits, source.id, branch);
      if (edited) {
        dataset.datasetContent = copy(edited);
        dataset.historyEdited = true;
      } else {
        delete dataset.historyEdited;
        dataset.datasetContent = {
          headers: copy(table.headers), rows: table.rows.map((row) => row.map(cloneCell)),
          columnTypes: copy(table.columnTypes || []),
          rowIds: table.rows.map((_, index) => table.rowIds?.[index] || `${source.id}:${branch}:${index}`),
        };
      }
      return {
        signature: await datasetSignature({ nodeId: id, sourceRecordId: source.id, branch, editedContent: edited }),
        sourceRecordId: source.id,
      };
    }
    delete dataset.resultMissing;
    const content = dataset.datasetContent || dataset.subsetContent;
    return content ? { signature: await datasetSignature({ nodeId: id, content }) } : null;
  }

  async function resolveNode(id) {
    if (resolvedNodes.has(id)) return resolvedNodes.get(id);
    const node = nodes.get(id);
    if (!node || !['run', 'process'].includes(node.type)) return null;
    if (visiting.has(id)) throw new Error(`History dependency cycle at ${id}`);
    visiting.add(id);
    try {
      let signature = null;
      if (node.type === 'run') {
        const promptEdge = next.connections.find((edge) => edge.type === 'prompt-to-run' && edge.toId === id);
        const prompt = nodes.get(promptEdge?.fromId);
        const datasetId = String(node.runWorkingSetId || '');
        const dataset = await resolveDataset(datasetId);
        if (prompt?.type === 'prompt' && dataset) {
          signature = await runInputSignature({
            promptNodeId: nodeId(prompt), prompt, datasetNodeId: datasetId,
            datasetSignature: dataset.signature, mapping: parsed(node.runInputToColumn, {}),
          });
        }
      } else {
        const incoming = next.connections.filter((edge) => edge.type === 'dataset-to-process' && edge.toId === id);
        const primaryDatasetId = String(node.primaryDatasetId || incoming[0]?.fromId || '');
        if (primaryDatasetId) {
          const datasets = next.nodes.filter((item) => item.type === 'dataset').map((item) => ({ nodeId: nodeId(item), name: item.name || '' }));
          const allBindings = buildProcessDatasetBindings(datasets, primaryDatasetId);
          const code = String(node.dfCode || node.code || '');
          const required = new Set([primaryDatasetId, ...incoming.map((edge) => edge.fromId), ...referencedDatasetAliases(code, allBindings)]);
          const savedAliases = parsed(node.datasetAliases, {});
          const bindings = [];
          let complete = true;
          for (const binding of allBindings.filter((item) => required.has(item.nodeId))) {
            const dataset = await resolveDataset(binding.nodeId);
            if (!dataset) { complete = false; break; }
            bindings.push({ nodeId: binding.nodeId, alias: savedAliases?.[binding.nodeId] || binding.alias, signature: dataset.signature });
          }
          if (complete && bindings.some((item) => item.nodeId === primaryDatasetId)) {
            signature = await processInputSignature({ code, primaryDatasetId, bindings });
          }
        }
      }
      const record = signature ? await recordFor(node, signature) : null;
      if (record) {
        applyResult(node, record);
        node.historyRecordId = record.id;
        currentRecordIds[id] = record.id;
      } else {
        clearResult(node);
        delete node.historyRecordId;
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
  for (const node of next.nodes) {
    if (node.type === 'dataset') await resolveDataset(nodeId(node));
  }
  return { state: next, currentRecordIds, missingDatasetIds, missingResultNodeIds };
}
