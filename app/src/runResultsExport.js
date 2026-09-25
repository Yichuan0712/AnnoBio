/**
 * A Run's results as a Dataset table: what "Save to workspace" creates on the canvas, and what the
 * Agent's save_run_results operation creates. Pure, so both paths produce the same table.
 */
import { cloneCell } from './datasetContent.js';
import { formatResultOutputColumnLabel } from './displayTextNormalize.js';
import { embedInputRow, markEmptyOutputAsError } from './runResumeUtils.js';

function sanitizeFieldName(key) {
  const s = String(key ?? '').trim().replace(/[^\w]/g, '_');
  return s || 'field';
}

export function deriveOutputFields(results, schemaFields) {
  if (!Array.isArray(results) || results.length === 0) return [];
  const first = results.find((r) => r.output && typeof r.output === 'object');
  if (!first) return [];
  const schema = Array.isArray(schemaFields) ? schemaFields : [];
  const schemaBySanitized = new Map();
  schema.forEach((f) => {
    const k = (f.key || '').trim();
    if (k) schemaBySanitized.set(sanitizeFieldName(k), k);
  });
  return Object.keys(first.output).map((outputKey) => ({
    key: outputKey,
    display: schemaBySanitized.get(outputKey) || outputKey,
  }));
}

/**
 * @param {{results: object[], runContent: {headers: string[], columnTypes?: string[], rows: any[][]}|null,
 *   schemaFields: {key: string}[]}} input runContent is the run's input table (runInputContent)
 * @returns {{headers: string[], rows: any[][], columnTypes: string[]}}
 */
export function buildRunResultsTable({ results: rawResults, runContent, schemaFields }) {
  let results = runContent ? embedInputRow(rawResults, runContent) : rawResults;
  results = markEmptyOutputAsError(results);
  const schema = Array.isArray(schemaFields) ? schemaFields : [];

  let outputFields = deriveOutputFields(results, schema);
  if (outputFields.length === 0 && results.some((item) => item && item.error)) {
    outputFields = [{ key: 'error', display: 'Error' }];
  }
  if (outputFields.length === 0 && results.length > 0) {
    const first = results.find((item) => item?.output && typeof item.output === 'object' && Object.keys(item.output).length > 0);
    if (first) outputFields = Object.keys(first.output).map((key) => ({ key, display: key }));
  }
  if (outputFields.length === 0 && schema.length > 0) {
    outputFields = schema
      .map((field) => ({
        key: String(field?.key || '').trim(),
        display: String(field?.display || field?.key || '').trim() || 'field',
      }))
      .filter((field) => field.key);
  }

  const inputHeaders = Array.isArray(runContent?.headers) ? runContent.headers.slice() : [];
  const headers = [
    'Input: #',
    ...inputHeaders.map((header) => `Input: ${String(header ?? '').trim() || ' '}`),
    formatResultOutputColumnLabel('#'),
    ...outputFields.map((field) => formatResultOutputColumnLabel((field?.display || field?.key || '').trim() || 'output')),
  ];
  const rows = results.map((result) => {
    const outputPart = result?.error
      ? outputFields.map(() => String(result.error))
      : outputFields.map((field) => {
        const value = result?.output?.[field.key];
        if (value == null) return '—';
        if (Array.isArray(value)) return value.join(', ');
        return String(value);
      });
    const inputRow = Array.isArray(result?.input_row) ? result.input_row : [];
    const inputPart = inputHeaders.map((_, index) => (inputRow[index] == null ? '—' : cloneCell(inputRow[index])));
    const inputNum = String((result?.input_row_index ?? 0) + 1);
    const outputNum = String((result?.row_index ?? 0) + 1);
    return [inputNum, ...inputPart, outputNum, ...outputPart];
  });
  const sourceTypes = Array.isArray(runContent?.columnTypes) ? runContent.columnTypes : [];
  const columnTypes = [
    'text',
    ...inputHeaders.map((_, index) => ((sourceTypes[index] === 'image' || sourceTypes[index] === 'pdf') ? sourceTypes[index] : 'text')),
    'text',
    ...outputFields.map(() => 'text'),
  ];
  return { headers, rows, columnTypes };
}
