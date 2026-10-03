import { datasetSignature, processInputSignature, runInputSignature } from './runHistorySignature.js';
import { buildProcessDatasetBindings, referencedDatasetAliases } from './processDatasetBindings.js';
import { resolveHistoryCanvasState } from './runHistoryResolver.js';
import { datasetHistorySource } from './datasetHistorySource.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const nodeId = (node) => String(node?.nodeId || node?.id || '');

function parsed(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

/** Freeze exactly the inputs used by one new Run/Process record. */
export async function captureHistoryInput(state, targetNodeId, { index, loadRecord }) {
  const resolved = await resolveHistoryCanvasState(state, { index, loadRecord });
  const canvas = resolved.state;
  const nodes = new Map(canvas.nodes.map((node) => [nodeId(node), node]));
  const target = nodes.get(targetNodeId);
  if (!target || !['run', 'process'].includes(target.type)) throw new Error(`Run or Process node was not found: ${targetNodeId}`);
  const missing = new Set(resolved.missingDatasetIds);

  async function snapshotDataset(id) {
    const dataset = nodes.get(id);
    if (!dataset || dataset.type !== 'dataset' || missing.has(id)) throw new Error(`Input Dataset has no current result: ${id}`);
    const content = dataset.datasetContent || dataset.subsetContent;
    if (!content || !Array.isArray(content.rows)) throw new Error(`Input Dataset is missing: ${id}`);
    const link = datasetHistorySource(dataset, canvas.connections);
    const sourceNodeId = link?.sourceId;
    const sourceRecordId = sourceNodeId ? resolved.currentRecordIds[sourceNodeId] : null;
    const branch = link?.branch || 'result';
    if (sourceNodeId && !sourceRecordId) throw new Error(`Input Dataset has no current source record: ${id}`);
    const signature = await datasetSignature({ nodeId: id, content, sourceRecordId, branch });
    return {
      nodeId: id, name: dataset.name || '', content: copy(content), signature,
      ...(sourceRecordId ? { sourceNodeId, sourceRecordId, branch } : {}),
    };
  }

  if (target.type === 'run') {
    const promptEdge = canvas.connections.find((edge) => edge.type === 'prompt-to-run' && edge.toId === targetNodeId);
    const prompt = nodes.get(promptEdge?.fromId);
    if (!prompt || prompt.type !== 'prompt') throw new Error('Run has no input Prompt.');
    const dataset = await snapshotDataset(String(target.runWorkingSetId || ''));
    const promptSnapshot = {
      nodeId: nodeId(prompt), name: prompt.name || '', sections: copy(prompt.sections || prompt.fields || []),
      outputFormat: copy(prompt.outputFormat || { returnShape: 'single', fields: [] }),
      inputTypes: copy(prompt.inputTypes || {}),
    };
    const mapping = parsed(target.runInputToColumn, {});
    const signature = await runInputSignature({
      promptNodeId: promptSnapshot.nodeId, prompt: promptSnapshot, datasetNodeId: dataset.nodeId,
      datasetSignature: dataset.signature, mapping,
    });
    return {
      nodeId: targetNodeId, kind: 'run', signature,
      inputs: {
        prompt: promptSnapshot, dataset, mapping: copy(mapping),
        settings: copy(target.runSettings || {}), credentialId: target.runCredentialId || '',
      },
      sourceRecordIds: dataset.sourceRecordId ? [dataset.sourceRecordId] : [],
      summary: { promptName: promptSnapshot.name, datasetNames: [dataset.name], rowCount: dataset.content.rows.length },
    };
  }

  const incoming = canvas.connections.filter((edge) => edge.type === 'dataset-to-process' && edge.toId === targetNodeId);
  const primaryDatasetId = String(target.primaryDatasetId || incoming[0]?.fromId || '');
  if (!primaryDatasetId) throw new Error('Process has no input Dataset.');
  const datasets = canvas.nodes.filter((node) => node.type === 'dataset').map((node) => ({ nodeId: nodeId(node), name: node.name || '' }));
  const allBindings = buildProcessDatasetBindings(datasets, primaryDatasetId);
  const code = String(target.dfCode || target.code || '');
  if (!code.trim()) throw new Error('Process has no code.');
  const required = new Set([primaryDatasetId, ...incoming.map((edge) => edge.fromId), ...referencedDatasetAliases(code, allBindings)]);
  const savedAliases = parsed(target.datasetAliases, {});
  const bindings = [];
  for (const binding of allBindings.filter((item) => required.has(item.nodeId))) {
    const dataset = await snapshotDataset(binding.nodeId);
    bindings.push({ ...dataset, alias: savedAliases?.[binding.nodeId] || binding.alias });
  }
  if (!bindings.some((item) => item.nodeId === primaryDatasetId)) throw new Error('Process primary Dataset is missing.');
  return {
    nodeId: targetNodeId, kind: 'process',
    signature: await processInputSignature({ code, primaryDatasetId, bindings }),
    inputs: { code, primaryDatasetId, bindings },
    sourceRecordIds: [...new Set(bindings.map((item) => item.sourceRecordId).filter(Boolean))],
    summary: { codeLine: code.split('\n')[0].trim(), datasetNames: bindings.map((item) => item.name) },
  };
}

export function runningHistoryRecord(capture, {
  createId = () => globalThis.crypto.randomUUID().replaceAll('-', ''),
  now = () => new Date().toISOString(),
} = {}) {
  const at = now();
  return {
    ...capture, id: createId(), status: 'running', createdAt: at, updatedAt: at,
    results: capture.kind === 'run'
      ? { runResults: [], runInputContent: copy(capture.inputs.dataset.content), runOutputFields: [], runProgress: 0 }
      : { dfResults: null },
  };
}
