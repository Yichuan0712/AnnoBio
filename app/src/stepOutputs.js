/**
 * The table a step input reads (docs/design/DATA_FLOW_DESIGN.md §3.7): a Dataset's content, a Run's
 * results as Save results builds them, or one output branch of a Process. Pure; works on canvas
 * state as getCanvasState() saves it, where a Run or Process carries its current History result.
 */
import { cloneCell } from './datasetContent.js';
import { effectiveProcessOutputs } from './processOutputPorts.js';
import { buildRunResultsTable } from './runResultsExport.js';
import { markEmptyOutputAsError } from './runResumeUtils.js';

const RESULT = 'result';
const nodeIdOf = (node) => String(node?.nodeId || node?.id || '').trim();
const findNode = (state, id) => (state?.nodes || []).find((node) => nodeIdOf(node) === String(id || '').trim());

function parsed(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

/** The output fields of the Prompt a Run uses: the columns its results table gets. */
function promptFields(state, runId) {
  const edge = (state?.connections || []).find((item) => item?.type === 'prompt-to-run' && String(item.toId) === runId);
  const format = findNode(state, edge?.fromId)?.outputFormat;
  return Array.isArray(format) ? format : format?.fields || [];
}

function runOutput(state, run, port) {
  if (run.runPending) return { waiting: 'running' };
  if (run.runCompleted !== '1' && run.runCompleted !== true) return { waiting: run.runResumable ? 'stopped' : 'no-result' };
  if (port !== RESULT) return { waiting: 'missing-port' };
  const results = parsed(run.runResults, []);
  if (!Array.isArray(results)) return { waiting: 'no-result' };
  const table = buildRunResultsTable({
    results, runContent: parsed(run.runInputContent, null), schemaFields: promptFields(state, nodeIdOf(run)),
  });
  const recordId = run.historyRecordId || nodeIdOf(run);
  return {
    table: { ...table, rowIds: table.rows.map((_, index) => `${recordId}:${port}:${index}`) },
    // Rows that failed are passed on with the error in their output columns; this counts them the way
    // buildRunResultsTable decides a row failed.
    errorRowCount: markEmptyOutputAsError(results).filter((item) => item?.error).length,
  };
}

function processOutput(processNode, port) {
  if (processNode.processPending) return { waiting: 'running' };
  if (processNode.processResumable) return { waiting: 'stopped' };
  const result = parsed(processNode.dfResults, null);
  const outputs = result?.outputs && typeof result.outputs === 'object'
    ? result.outputs : (Array.isArray(result?.headers) && Array.isArray(result?.rows) ? { result } : null);
  if (!outputs || !Object.keys(outputs).length) {
    // Without a result, a branch the code is known not to return will not come by running it.
    const known = effectiveProcessOutputs({ detected: processNode.processOutputPorts });
    return { waiting: known.source === 'code' && !known.dynamic && !known.ports.includes(port) ? 'missing-port' : 'no-result' };
  }
  const table = outputs[port];
  if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) return { waiting: 'missing-port' };
  const recordId = processNode.historyRecordId || nodeIdOf(processNode);
  return {
    table: {
      headers: table.headers.slice(),
      rows: table.rows.map((row) => (Array.isArray(row) ? row.map(cloneCell) : [])),
      columnTypes: Array.isArray(table.columnTypes) ? table.columnTypes.slice() : [],
      rowIds: table.rows.map((_, index) => table.rowIds?.[index] || `${recordId}:${port}:${index}`),
    },
  };
}

/**
 * What `source` gives a step that reads it. A Run or Process gives a table only when its current
 * result is complete; `waiting` says why not. The canvas does not keep a record's status, so a
 * failed upstream, which leaves no result, is reported as 'no-result'.
 * @param {object} state canvas state
 * @param {{ nodeId: string, port?: string } | null} source
 * @returns {{ table: { headers: string[], rows: any[][], columnTypes?: string[], rowIds?: any[] }, errorRowCount?: number }
 *   | { waiting: 'no-result' | 'running' | 'stopped' | 'missing-port' }}
 */
export function stepOutputTable(state, source) {
  const node = source?.nodeId ? findNode(state, source.nodeId) : null;
  if (!node) return { waiting: 'no-result' };
  const port = String(source.port || RESULT);
  if (node.type === 'run') return runOutput(state, node, port);
  if (node.type === 'process') return processOutput(node, port);
  // A Dataset that follows a missing upstream result (datasetHistorySource.js) has none either.
  if (node.resultMissing) return { waiting: 'no-result' };
  const content = node.datasetContent || node.subsetContent;
  return content ? { table: content } : { waiting: 'no-result' };
}
