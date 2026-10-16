import { readSavedFrom } from './savedDatasets.js';
import { stepSourceLabel } from './stepInputs.js';

const rows = (content) => Array.isArray(content?.rows) ? content.rows.length : null;
const count = (value, noun) => `${value} ${noun}${value === 1 ? '' : 's'}`;

function parsed(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function datasetLabel(dataset) {
  return String(dataset?.name || '').trim() || 'Unnamed dataset';
}

/** An input is named as the Dataset it read, or as the step whose output it read: its Prompt, or the Process and its branch. */
function inputLabel(dataset, canvasState) {
  return dataset?.kind === 'step' ? stepSourceLabel(canvasState, dataset) : datasetLabel(dataset);
}

/** The Datasets saved from this record's output (`savedFrom`, savedDatasets.js); for a Process, from `branch`. */
function savedDatasetNames(record, canvasState, branch = 'result') {
  return (Array.isArray(canvasState?.nodes) ? canvasState.nodes : []).filter((node) => {
    const savedFrom = node?.type === 'dataset' ? readSavedFrom(node.savedFrom) : null;
    return savedFrom?.recordId === record.id && (record.kind === 'run' || savedFrom.port === branch);
  }).map(datasetLabel);
}

function outputLabel(rowCount) {
  return `${rowCount == null ? 'Unknown row count' : count(rowCount, 'row')} (not exported as a Dataset node)`;
}

/** Human-readable facts for a Generate/Process History entry, including old saved records. */
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
    const exported = savedDatasetNames(record, canvasState);
    return {
      title: prompt ? `Prompt: ${prompt}` : 'Generate result',
      input: `Input: ${input ? inputLabel(input, canvasState) : (record.summary?.datasetNames || []).join(', ') || 'Unknown dataset'}`,
      output: `Output: ${exported.length ? exported.join(', ') : outputLabel(resultRows)}`,
      meta: [errorRows ? count(errorRows, 'error') : '', model ? `Model: ${model}` : ''].filter(Boolean).join(' · '),
    };
  }
  const bindings = Array.isArray(record.inputs?.bindings) ? record.inputs.bindings : [];
  const result = parsed(record.results?.dfResults);
  const outputs = result?.outputs && typeof result.outputs === 'object'
    ? result.outputs : (Array.isArray(result?.rows) ? { result } : {});
  const branches = Object.entries(outputs).map(([name, table]) => {
    const exported = savedDatasetNames(record, canvasState, name);
    if (exported.length) return exported.join(', ');
    const branchLabel = Object.keys(outputs).length > 1 ? `${name.replaceAll('_', ' ')}: ` : '';
    return `${branchLabel}${outputLabel(rows(table))}`;
  });
  return {
    title: '',
    input: `Input: ${bindings.length
      ? bindings.map((binding) => inputLabel(binding, canvasState)).join(', ')
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
