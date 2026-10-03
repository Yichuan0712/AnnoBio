const rows = (content) => Array.isArray(content?.rows) ? content.rows.length : null;
const count = (value, noun) => `${value} ${noun}${value === 1 ? '' : 's'}`;

function parsed(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function datasetLabel(dataset) {
  return String(dataset?.name || '').trim() || 'Unnamed dataset';
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
      input: `Input: ${input ? datasetLabel(input) : (record.summary?.datasetNames || []).join(', ') || 'Unknown dataset'}`,
      output: `Output: ${exported.length ? exported.join(', ') : outputLabel(resultRows)}`,
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
    input: `Input: ${bindings.length ? bindings.map(datasetLabel).join(', ') : (record.summary?.datasetNames || []).join(', ') || 'Unknown dataset'}`,
    output: branches.length ? `Output: ${branches.join(' · ')}` : 'Output: no result saved',
    meta: '',
  };
}

export function historyStatusLabel(status) {
  return {
    completed: 'Completed', running: 'Running', stopped: 'Stopped', failed: 'Failed',
  }[status] || 'Saved';
}
