import { canonicalJson, datasetSignature, processInputSignature, runInputSignature } from './runHistorySignature.js';
import { buildProcessDatasetBindings, referencedDatasetAliases } from './processDatasetBindings.js';
import { buildRunResultsTable } from './runResultsExport.js';
import { cloneCell } from './datasetContent.js';

const copy = (value) => JSON.parse(JSON.stringify(value));

function parsed(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function nodeId(node) { return String(node?.nodeId || node?.id || ''); }

function processOutputs(node) {
  const result = parsed(node?.dfResults ?? node?.results, null);
  if (result?.outputs && typeof result.outputs === 'object') return result.outputs;
  if (Array.isArray(result?.headers) && Array.isArray(result?.rows)) return { result };
  return {};
}

function sameTable(saved, output) {
  if (!saved || !output || !Array.isArray(saved.headers) || !Array.isArray(saved.rows)
    || !Array.isArray(output.headers) || !Array.isArray(output.rows)) return false;
  // Exported Dataset row IDs are allocated on creation, rather than copied from the result.
  // Older Process exports also did not carry column types.
  return canonicalJson({ headers: saved.headers, rows: saved.rows })
    === canonicalJson({ headers: output.headers, rows: output.rows.map((row) => row.map(cloneCell)) })
    && (!Array.isArray(output.columnTypes) || !Array.isArray(saved.columnTypes)
      || canonicalJson(saved.columnTypes) === canonicalJson(output.columnTypes));
}

function runOutput(node, prompt) {
  const results = parsed(node?.runResults, []);
  if (!Array.isArray(results) || (!results.length && node?.runCompleted !== '1' && node?.runCompleted !== true)) return null;
  const format = prompt?.outputFormat;
  return buildRunResultsTable({
    results,
    runContent: parsed(node?.runInputContent, null),
    schemaFields: Array.isArray(format) ? format : format?.fields || [],
  });
}

/**
 * Prepare old canvas results for the history format, without writing to disk or mutating state.
 * The caller persists records first, then saves the returned canvas. It should invoke this only
 * when opening a project without a history index, before the new history behavior is enabled.
 */
export async function planLegacyHistoryMigration(state, {
  createId = () => globalThis.crypto.randomUUID().replaceAll('-', ''),
  now = () => new Date().toISOString(),
  existingEntries = [],
  onlyNodeIds = null,
  sourceRecordIds = {},
} = {}) {
  const next = copy(state || {});
  next.nodes = Array.isArray(next.nodes) ? next.nodes : [];
  next.connections = Array.isArray(next.connections) ? next.connections : [];
  const nodes = new Map(next.nodes.map((node) => [nodeId(node), node]));
  const included = onlyNodeIds ? new Set(onlyNodeIds) : null;
  const resultNodes = next.nodes.filter((node) => (!included || included.has(nodeId(node))) && (
    (node.type === 'run' && Array.isArray(parsed(node.runResults, null))
      && (parsed(node.runResults, []).length > 0 || node.runCompleted === '1' || node.runCompleted === true))
    || (node.type === 'process' && Object.keys(processOutputs(node)).length > 0)
  ));
  const existingByNode = new Map();
  for (const entry of existingEntries) {
    if (!entry?.nodeId || !entry?.id) continue;
    if (existingByNode.has(entry.nodeId) && existingByNode.get(entry.nodeId) !== entry.id) {
      throw new Error(`Cannot resume legacy migration with multiple records for node ${entry.nodeId}.`);
    }
    existingByNode.set(entry.nodeId, entry.id);
  }
  const ids = new Map(Object.entries(sourceRecordIds));
  resultNodes.forEach((node) => ids.set(nodeId(node), existingByNode.get(nodeId(node)) || createId()));
  const resultNodeIds = new Set(resultNodes.map(nodeId));
  const promptForRun = (runId) => {
    const edge = next.connections.find((item) => item.type === 'prompt-to-run' && item.toId === runId);
    const prompt = nodes.get(edge?.fromId);
    return prompt?.type === 'prompt' ? prompt : null;
  };
  const candidateSources = new Map();
  const invalidExistingSources = new Set();
  const detachedDatasetIds = [];
  for (const dataset of next.nodes.filter((node) => node.type === 'dataset')) {
    const id = nodeId(dataset);
    let sourceId = String(dataset.sourceRunNodeId || '');
    let branch = 'result';
    let output = null;
    if (sourceId) {
      const run = nodes.get(sourceId);
      output = run?.type === 'run' ? runOutput(run, promptForRun(sourceId)) : null;
    } else {
      const edge = next.connections.find((item) => item.type === 'process-to-dataset' && item.toId === id);
      if (edge) {
        sourceId = edge.fromId;
        branch = String(dataset.processOutputName || 'result');
        output = processOutputs(nodes.get(sourceId))[branch] || null;
      }
    }
    if (!sourceId) continue;
    if (ids.has(sourceId) && sameTable(dataset.datasetContent || dataset.subsetContent, output)) {
      candidateSources.set(id, { sourceId, branch });
    } else if (sourceRecordIds[sourceId]) {
      invalidExistingSources.add(id);
    } else if (!included || resultNodeIds.has(sourceId)) {
      detachedDatasetIds.push(id);
    } else {
      // An existing history-backed Dataset with no current result stays derived and unavailable.
      invalidExistingSources.add(id);
    }
  }

  const records = new Map();
  const visiting = new Set();
  const unmigratedNodeIds = [];
  async function resolveDataset(datasetId) {
    if (invalidExistingSources.has(datasetId)) throw new Error(`Input Dataset has no matching source result: ${datasetId}`);
    const dataset = nodes.get(datasetId);
    const content = dataset?.datasetContent || dataset?.subsetContent;
    if (!dataset || dataset.type !== 'dataset' || !content) {
      throw new Error(`Input Dataset is missing: ${datasetId}`);
    }
    const source = candidateSources.get(datasetId);
    if (source) {
      let sourceRecord = null;
      try { sourceRecord = await resolveRecord(source.sourceId); } catch (_) { /* keep the old table as an ordinary Dataset */ }
      if (sourceRecord) {
        const signature = await datasetSignature({ nodeId: datasetId, sourceRecordId: sourceRecord.id, branch: source.branch });
        return {
          nodeId: datasetId, name: dataset.name || '', content: copy(content),
          sourceNodeId: source.sourceId, sourceRecordId: sourceRecord.id, branch: source.branch, signature,
        };
      }
      if (!detachedDatasetIds.includes(datasetId)) detachedDatasetIds.push(datasetId);
      candidateSources.delete(datasetId);
    }
    return {
      nodeId: datasetId, name: dataset.name || '', content: copy(content),
      signature: await datasetSignature({ nodeId: datasetId, content }),
    };
  }

  async function resolveRecord(id) {
    if (records.has(id)) return records.get(id);
    if (!ids.has(id)) return null;
    if (!resultNodeIds.has(id)) return { id: ids.get(id), nodeId: id };
    if (visiting.has(id)) throw new Error(`History dependency cycle at ${id}`);
    const node = nodes.get(id);
    visiting.add(id);
    try {
      const createdAt = now();
      let inputs;
      let signature;
      let results;
      let status;
      let summary;
      let sourceRecordIds;
      if (node.type === 'run') {
        const prompt = promptForRun(id);
        if (!prompt) throw new Error(`Run Prompt is missing: ${id}`);
        const dataset = await resolveDataset(String(node.runWorkingSetId || ''));
        const mapping = parsed(node.runInputToColumn, {});
        const promptSnapshot = {
          nodeId: nodeId(prompt), name: prompt.name || '', sections: copy(prompt.sections || prompt.fields || []),
          outputFormat: copy(prompt.outputFormat || { returnShape: 'single', fields: [] }),
          inputTypes: copy(prompt.inputTypes || {}),
        };
        inputs = {
          prompt: promptSnapshot, dataset, mapping: copy(mapping),
          settings: copy(node.runSettings || {}), credentialId: node.runCredentialId || '',
        };
        signature = await runInputSignature({
          promptNodeId: promptSnapshot.nodeId, prompt: promptSnapshot,
          datasetNodeId: dataset.nodeId, datasetSignature: dataset.signature, mapping,
        });
        results = {
          runResults: copy(parsed(node.runResults, [])), runInputContent: copy(parsed(node.runInputContent, null)),
          runOutputFields: copy(parsed(node.runOutputFields, [])), runProgress: node.runProgress || 0,
        };
        status = node.runCompleted === '1' || node.runCompleted === true ? 'completed' : 'stopped';
        summary = { promptName: promptSnapshot.name, datasetNames: [dataset.name], rowCount: results.runResults.length };
        sourceRecordIds = dataset.sourceRecordId ? [dataset.sourceRecordId] : [];
      } else {
        const incoming = next.connections.filter((edge) => edge.type === 'dataset-to-process' && edge.toId === id);
        const primaryDatasetId = String(node.primaryDatasetId || incoming[0]?.fromId || '');
        if (!primaryDatasetId) throw new Error(`Process input Dataset is missing: ${id}`);
        const datasets = next.nodes.filter((item) => item.type === 'dataset').map((item) => ({ nodeId: nodeId(item), name: item.name || '' }));
        const allBindings = buildProcessDatasetBindings(datasets, primaryDatasetId);
        const code = String(node.dfCode || node.code || '');
        const required = new Set([primaryDatasetId, ...incoming.map((edge) => edge.fromId), ...referencedDatasetAliases(code, allBindings)]);
        const savedAliases = parsed(node.datasetAliases, {});
        const bindings = [];
        for (const binding of allBindings.filter((item) => required.has(item.nodeId))) {
          const dataset = await resolveDataset(binding.nodeId);
          bindings.push({ ...dataset, alias: savedAliases?.[binding.nodeId] || binding.alias });
        }
        if (!bindings.some((item) => item.nodeId === primaryDatasetId)) throw new Error(`Process primary Dataset is missing: ${id}`);
        inputs = { code, primaryDatasetId, bindings };
        signature = await processInputSignature({ code, primaryDatasetId, bindings });
        results = { dfResults: copy(parsed(node.dfResults ?? node.results, null)) };
        status = /^cancelled\b/i.test(String(results.dfResults?.statusText || '')) ? 'stopped' : 'completed';
        summary = { codeLine: code.split('\n')[0].trim(), datasetNames: bindings.map((item) => item.name), branchCount: Object.keys(processOutputs(node)).length };
        sourceRecordIds = [...new Set(bindings.map((item) => item.sourceRecordId).filter(Boolean))];
      }
      const record = {
        id: ids.get(id), nodeId: id, kind: node.type, signature, status, createdAt,
        updatedAt: createdAt, inputs, results, summary, sourceRecordIds,
      };
      records.set(id, record);
      return record;
    } finally {
      visiting.delete(id);
    }
  }

  for (const node of resultNodes) {
    const id = nodeId(node);
    try { await resolveRecord(id); } catch (_) { unmigratedNodeIds.push(id); }
  }
  for (const datasetId of detachedDatasetIds) {
    const dataset = nodes.get(datasetId);
    if (dataset.sourceRunNodeId) {
      // Keep the old visual lineage without claiming that the saved table is the Run's live result.
      next.connections = next.connections.filter((edge) => !(edge.type === 'process-to-dataset' && edge.toId === datasetId));
      if (nodes.has(dataset.sourceRunNodeId)) next.connections.push({
        type: 'run-to-dataset-snapshot', fromId: dataset.sourceRunNodeId, toId: datasetId,
      });
      delete dataset.sourceRunNodeId;
    } else {
      const edge = next.connections.find((item) => item.type === 'process-to-dataset' && item.toId === datasetId);
      if (edge) edge.type = 'process-to-dataset-snapshot';
    }
  }
  next.historyVersion = 1;
  return { state: next, records: [...records.values()], detachedDatasetIds, unmigratedNodeIds };
}
