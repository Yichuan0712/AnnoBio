import { publishedPipelineCopy } from './datasetHistorySource.js';

const rows = (content) => Array.isArray(content?.rows) ? content.rows.length : null;
const count = (value, noun) => `${value} ${noun}${value === 1 ? '' : 's'}`;

function parsed(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function datasetLabel(dataset) {
  return String(dataset?.name || '').trim() || 'Unnamed dataset';
}

/** An input is named as the Dataset that restoring this record would read (runHistorySelection.js). */
function inputLabel(dataset, canvasState, recordById) {
  const upstreamRecordId = String(dataset?.sourceRecordId || dataset?.upstreamPipelineRecordId || '');
  const sourceRecord = upstreamRecordId ? recordById?.get(upstreamRecordId) : null;
  return datasetLabel(publishedPipelineCopy(canvasState, dataset, sourceRecord) || dataset);
}

function datasetProducer(dataset, connections) {
  if (dataset.sourceRunNodeId) return { sourceId: String(dataset.sourceRunNodeId), kind: 'run', branch: 'result' };
  const id = String(dataset.nodeId || dataset.id || '');
  const edge = connections.find((item) => item.toId === id && [
    'run-to-dataset-snapshot', 'process-to-dataset', 'process-to-dataset-snapshot',
  ].includes(item.type));
  if (!edge) return null;
  return {
    sourceId: String(edge.fromId),
    kind: edge.type === 'run-to-dataset-snapshot' ? 'run' : 'process',
    branch: String(dataset.processOutputName || 'result'),
  };
}

function exportedDatasetNames(record, canvasState, branch = 'result', singleBranch = false, currentRecordIds = null) {
  const nodes = Array.isArray(canvasState?.nodes) ? canvasState.nodes : [];
  const connections = Array.isArray(canvasState?.connections) ? canvasState.connections : [];
  const candidates = nodes.filter((node) => {
    if (node.type !== 'dataset') return false;
    const snapshotRecordId = String(node.snapshotSourceRecordId || '');
    const isExactSnapshot = snapshotRecordId === record.id;
    const isCurrentOutput = !node.savedCopy
      && (currentRecordIds == null || currentRecordIds[record.nodeId] === record.id);
    if (!isExactSnapshot && !isCurrentOutput) return false;
    const source = datasetProducer(node, connections);
    if (!source || source.sourceId !== record.nodeId || source.kind !== record.kind) return false;
    return record.kind === 'run'
      || String(source.branch || 'result') === branch
      || (singleBranch && !String(node.processOutputName || '').trim());
  });
  if (!candidates.length) return [];
  const live = candidates.filter((node) => {
    if (record.kind === 'run') return String(node.sourceRunNodeId || '') === record.nodeId;
    return connections.some((edge) => (
      edge.type === 'process-to-dataset' && edge.fromId === record.nodeId
      && edge.toId === String(node.nodeId || node.id || '')
    ));
  });
  const selected = live.find((node) => !node.savedCopy) || live[0]
    || candidates.find((node) => !node.savedCopy) || candidates[0];
  return [datasetLabel(selected)];
}

function outputLabel(rowCount) {
  return `${rowCount == null ? 'Unknown row count' : count(rowCount, 'row')} (not exported as a Dataset node)`;
}

/** Human-readable facts for a Run/Process History entry, including old saved records.
 * `recordById` (record id -> record) lets an input from a Pipeline run be named as its published copy. */
export function describeHistoryRecord(record, canvasState = null, { currentRecordIds = null, recordById = null } = {}) {
  if (!record) return { title: 'Saved result', input: 'Input details unavailable', output: 'Result details unavailable', meta: '' };
  if (record.kind === 'run') {
    const prompt = String(record.inputs?.prompt?.name || record.summary?.promptName || '').trim();
    const input = record.inputs?.dataset;
    const resultRows = Array.isArray(record.results?.runResults)
      ? record.results.runResults.length : record.summary?.rowCount;
    const errorRows = record.summary?.errorCount
      ?? (Array.isArray(record.results?.runResults)
        ? record.results.runResults.filter((item) => item?.error).length : 0);
    const model = record.model || record.summary?.model || '';
    const exported = exportedDatasetNames(record, canvasState, 'result', false, currentRecordIds);
    return {
      title: prompt ? `Prompt: ${prompt}` : 'Run result',
      input: `Input: ${input ? inputLabel(input, canvasState, recordById) : (record.summary?.datasetNames || []).join(', ') || 'Unknown dataset'}`,
      output: `Output: ${exported.length ? exported.join(', ') : outputLabel(resultRows)}`,
      meta: [errorRows ? count(errorRows, 'error') : '', model ? `Model: ${model}` : ''].filter(Boolean).join(' · '),
    };
  }
  const bindings = Array.isArray(record.inputs?.bindings) ? record.inputs.bindings : [];
  const result = parsed(record.results?.dfResults);
  const outputs = result?.outputs && typeof result.outputs === 'object'
    ? result.outputs : (Array.isArray(result?.rows) ? { result } : {});
  const branches = Object.entries(outputs).map(([name, table]) => {
    const exported = exportedDatasetNames(record, canvasState, name, Object.keys(outputs).length === 1, currentRecordIds);
    if (exported.length) return exported.join(', ');
    const branchLabel = Object.keys(outputs).length > 1 ? `${name.replaceAll('_', ' ')}: ` : '';
    return `${branchLabel}${outputLabel(rows(table))}`;
  });
  return {
    title: '',
    input: `Input: ${bindings.length
      ? bindings.map((binding) => inputLabel(binding, canvasState, recordById)).join(', ')
      : (record.summary?.datasetNames || []).join(', ') || 'Unknown dataset'}`,
    output: branches.length ? `Output: ${branches.join(' · ')}` : 'Output: no result saved',
    meta: '',
  };
}

export function historyStatusLabel(status) {
  return {
    completed: 'Completed', running: 'Running', stopped: 'Stopped', failed: 'Failed',
  }[status] || 'Saved';
}
