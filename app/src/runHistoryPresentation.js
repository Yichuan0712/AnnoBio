const rows = (content) => Array.isArray(content?.rows) ? content.rows.length : null;
const count = (value, noun) => `${value} ${noun}${value === 1 ? '' : 's'}`;

function parsed(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function datasetLabel(dataset) {
  const name = String(dataset?.name || '').trim() || 'Unnamed dataset';
  const rowCount = rows(dataset?.content);
  return rowCount == null ? name : `${name} (${count(rowCount, 'row')})`;
}

/** Human-readable facts for a Run/Process History entry, including old saved records. */
export function describeHistoryRecord(record) {
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
    return {
      title: prompt ? `Prompt: ${prompt}` : 'Run result',
      input: `Input: ${input ? datasetLabel(input) : (record.summary?.datasetNames || []).join(', ') || 'Unknown dataset'}`,
      output: `Output: ${resultRows == null ? 'not saved' : count(resultRows, 'row')}${resultRows === 0 && rows(input?.content) === 0 ? ' (empty input)' : ''}`,
      meta: [errorRows ? count(errorRows, 'error') : '', model ? `Model: ${model}` : ''].filter(Boolean).join(' · '),
    };
  }
  const bindings = Array.isArray(record.inputs?.bindings) ? record.inputs.bindings : [];
  const result = parsed(record.results?.dfResults);
  const outputs = result?.outputs && typeof result.outputs === 'object'
    ? result.outputs : (Array.isArray(result?.rows) ? { result } : {});
  const branches = Object.entries(outputs).map(([name, table]) => {
    const label = name === 'result' ? 'Result' : name.replaceAll('_', ' ');
    const rowCount = rows(table);
    return `${label}: ${rowCount == null ? 'unknown rows' : count(rowCount, 'row')}`;
  });
  const onlyResult = Object.keys(outputs).length === 1 && outputs.result;
  return {
    title: 'Process result',
    input: `Input: ${bindings.length ? bindings.map(datasetLabel).join(', ') : (record.summary?.datasetNames || []).join(', ') || 'Unknown dataset'}`,
    output: onlyResult
      ? `Output: ${rows(onlyResult) == null ? 'unknown rows' : count(rows(onlyResult), 'row')}`
      : (branches.length ? `Output: ${branches.join(' · ')}` : 'Output: no result saved'),
    meta: '',
  };
}

export function historyStatusLabel(status) {
  return {
    completed: 'Completed', running: 'Running', stopped: 'Stopped', failed: 'Failed',
  }[status] || 'Saved';
}
