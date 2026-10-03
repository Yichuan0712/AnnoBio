import { editedSourceRecordIds, historyEditFor } from './datasetHistoryEdits.js';
import { canonicalJson, signedTable } from './runHistorySignature.js';

const rows = (content) => Array.isArray(content?.rows) ? content.rows.length : null;
const count = (value, noun) => `${value} ${noun}${value === 1 ? '' : 's'}`;

function parsed(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function datasetLabel(dataset) {
  return String(dataset?.name || '').trim() || 'Unnamed dataset';
}

/** Input snapshot label; marks a derived input that was edited manually before this record ran. */
function inputLabel(dataset) {
  return `${datasetLabel(dataset)}${dataset?.edited ? ' (edited manually)' : ''}`;
}

const same = (a, b) => canonicalJson(a) === canonicalJson(b);

/** Whether a Dataset input snapshot no longer matches that Dataset on the current canvas. */
function datasetEditedSince(snapshot, canvasState) {
  const nodes = Array.isArray(canvasState?.nodes) ? canvasState.nodes : [];
  const connections = Array.isArray(canvasState?.connections) ? canvasState.connections : [];
  const node = nodes.find((item) => item.type === 'dataset' && item.nodeId === snapshot?.nodeId);
  if (!node || !snapshot.content) return false;
  const sourceId = node.sourceRunNodeId
    || connections.find((edge) => edge.type === 'process-to-dataset' && edge.toId === node.nodeId)?.fromId || '';
  if (snapshot.sourceRecordId) {
    // A derived input follows its upstream record; only a manual edit on that record counts.
    if (sourceId !== snapshot.sourceNodeId) return false;
    const edit = historyEditFor(node.historyEdits, snapshot.sourceRecordId, snapshot.branch);
    return !same(edit ? signedTable(edit) : null, snapshot.edited ? signedTable(snapshot.content) : null);
  }
  const content = node.datasetContent || node.subsetContent;
  return !sourceId && !!content && !same(signedTable(content), signedTable(snapshot.content));
}

/** Reminders that inputs were edited after this record ran, or that its output was edited downstream. */
function historyNotes(record, canvasState) {
  const nodes = Array.isArray(canvasState?.nodes) ? canvasState.nodes : [];
  if (!nodes.length) return [];
  const notes = [];
  if (record.kind === 'run') {
    const snapshot = record.inputs?.prompt;
    const prompt = nodes.find((node) => node.type === 'prompt' && node.nodeId === snapshot?.nodeId);
    const promptFields = (p) => ({ sections: p.sections || p.fields || [], outputFormat: p.outputFormat || null, inputTypes: p.inputTypes || {} });
    if (snapshot && prompt && !same(promptFields(prompt), promptFields(snapshot))) notes.push('Prompt edited since this result');
  } else {
    const process = nodes.find((node) => node.type === 'process' && node.nodeId === record.nodeId);
    if (process && record.inputs?.code != null && String(process.dfCode || process.code || '') !== String(record.inputs.code)) {
      notes.push('Code edited since this result');
    }
  }
  const inputs = record.kind === 'run' ? [record.inputs?.dataset] : (record.inputs?.bindings || []);
  const editedInputs = inputs.filter((snapshot) => snapshot && datasetEditedSince(snapshot, canvasState)).map(datasetLabel);
  if (editedInputs.length) notes.push(`Input edited since this result: ${editedInputs.join(', ')}`);
  const editedOutputs = nodes.filter((node) => node.type === 'dataset' && editedSourceRecordIds(node.historyEdits).has(record.id))
    .map(datasetLabel);
  if (editedOutputs.length) notes.push(`Output edited manually in: ${editedOutputs.join(', ')}`);
  return notes;
}

function exportedDatasetNames(record, canvasState, branch = 'result', singleBranch = false) {
  const nodes = Array.isArray(canvasState?.nodes) ? canvasState.nodes : [];
  const connections = Array.isArray(canvasState?.connections) ? canvasState.connections : [];
  const linkedIds = record.kind === 'run'
    ? nodes.filter((node) => node.type === 'dataset' && node.sourceRunNodeId === record.nodeId).map((node) => node.nodeId)
    : connections.filter((edge) => edge.type === 'process-to-dataset' && edge.fromId === record.nodeId)
      .map((edge) => edge.toId);
  return nodes.filter((node) => node.type === 'dataset' && linkedIds.includes(node.nodeId)
    && (record.kind === 'run' || String(node.processOutputName || (singleBranch ? branch : 'result')) === branch))
    .map(datasetLabel);
}

function outputLabel(rowCount) {
  return `${rowCount == null ? 'Unknown row count' : count(rowCount, 'row')} (not exported as a Dataset node)`;
}

/** Human-readable facts for a Run/Process History entry, including old saved records. */
export function describeHistoryRecord(record, canvasState = null) {
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
    const exported = exportedDatasetNames(record, canvasState);
    return {
      title: prompt ? `Prompt: ${prompt}` : 'Run result',
      input: `Input: ${input ? inputLabel(input) : (record.summary?.datasetNames || []).join(', ') || 'Unknown dataset'}`,
      output: `Output: ${exported.length ? exported.join(', ') : outputLabel(resultRows)}`,
      notes: historyNotes(record, canvasState),
      meta: [errorRows ? count(errorRows, 'error') : '', model ? `Model: ${model}` : ''].filter(Boolean).join(' · '),
    };
  }
  const bindings = Array.isArray(record.inputs?.bindings) ? record.inputs.bindings : [];
  const result = parsed(record.results?.dfResults);
  const outputs = result?.outputs && typeof result.outputs === 'object'
    ? result.outputs : (Array.isArray(result?.rows) ? { result } : {});
  const branches = Object.entries(outputs).map(([name, table]) => {
    const exported = exportedDatasetNames(record, canvasState, name, Object.keys(outputs).length === 1);
    if (exported.length) return exported.join(', ');
    const branchLabel = Object.keys(outputs).length > 1 ? `${name.replaceAll('_', ' ')}: ` : '';
    return `${branchLabel}${outputLabel(rows(table))}`;
  });
  return {
    title: '',
    input: `Input: ${bindings.length ? bindings.map(inputLabel).join(', ') : (record.summary?.datasetNames || []).join(', ') || 'Unknown dataset'}`,
    output: branches.length ? `Output: ${branches.join(' · ')}` : 'Output: no result saved',
    notes: historyNotes(record, canvasState),
    meta: '',
  };
}

export function historyStatusLabel(status) {
  return {
    completed: 'Completed', running: 'Running', stopped: 'Stopped', failed: 'Failed',
  }[status] || 'Saved';
}
