/**
 * Reads the tables Create Dataset accepts (.csv, .tsv, .xlsx, .xls) into {headers, rows}. The Agent's
 * chat attachments use the same rules, so a table it imports matches one the user would import
 * (docs/design/AGENT_ATTACHMENTS_PLAN.md).
 */
import * as XLSX from 'xlsx';

/** JSON records and JSONL share the same lossless string-cell conversion as dataset imports. */
export function parseJsonRecords(text, { lines = false } = {}) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  let records;
  const objectRow = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  try {
    if (lines) {
      records = [];
      for (const [index, line] of source.split(/\r\n|\n|\r/).entries()) {
        if (!line.trim()) continue;
        let value;
        try { value = JSON.parse(line); } catch (_) { return { error: `Invalid JSON at line ${index + 1}.` }; }
        if (!objectRow(value)) return { error: `Line ${index + 1} must contain an object.` };
        records.push(value);
      }
    } else {
      records = JSON.parse(source);
      if (objectRow(records)) {
        const arrays = Object.values(records).filter(Array.isArray);
        if (arrays.length !== 1) return { error: 'JSON must be an array of objects, or an object with exactly one array field.' };
        records = arrays[0];
      }
      if (!Array.isArray(records)) return { error: 'JSON must contain an array of objects.' };
      const invalid = records.findIndex((row) => !objectRow(row));
      if (invalid >= 0) return { error: `Record ${invalid + 1} must be an object.` };
    }
  } catch (_) { return { error: 'Invalid JSON. Use an array of objects.' }; }
  const headers = [...new Set(records.flatMap(Object.keys))];
  if (!headers.length) return { error: 'No columns found in JSON records.' };
  const cell = (value) => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return { headers, rows: records.map((row) => headers.map((key) => Object.hasOwn(row, key) ? cell(row[key]) : '')) };
}

/**
 * CSV records as RFC 4180 reads them: a quoted field may hold commas, line breaks and "" for a quote.
 * Unquoted fields are trimmed, and blank lines are skipped.
 */
function parseCsvRecords(text) {
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  // A line holding only "" is a record with one empty field, not a blank line.
  let wasQuotedRow = false;
  const endField = () => {
    row.push(wasQuoted ? field : field.trim());
    field = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endField();
    if (row.length > 1 || row[0] !== '' || wasQuotedRow) records.push(row);
    row = [];
    wasQuotedRow = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (ch === '"' && !wasQuoted && !field.trim()) {
      // Opens a quoted field; spaces before the quote are not part of it.
      quoted = true;
      wasQuoted = true;
      wasQuotedRow = true;
      field = '';
    } else if (wasQuoted && (ch === ' ' || ch === '\t')) {
      // Spaces after the closing quote, before the next comma.
    } else if (ch === ',') endField();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
    } else field += ch;
  }
  if (field || row.length || wasQuoted) endRecord();
  return records;
}

function parseTsvRecords(text) {
  return text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l.length > 0)
    .map((line) => line.split('\t').map((s) => s.trim()));
}

/**
 * CSV or TSV text: the first non-empty line names the columns.
 * @returns {{headers: string[], rows: string[][]} | {error: string}}
 */
export function parseDelimitedText(text, { tsv = false } = {}) {
  const source = String(text ?? '').replace(/^﻿/, '');
  const records = tsv ? parseTsvRecords(source) : parseCsvRecords(source);
  const headers = (records[0] || []).filter((c) => c.length > 0);
  if (headers.length === 0) return { error: 'No columns found in first line.' };
  return { headers, rows: records.slice(1) };
}

export function readWorkbook(bytes) {
  return XLSX.read(bytes, { type: 'array' });
}

/**
 * One sheet of a workbook from readWorkbook: the first row names the columns.
 * @returns {{headers: string[], rows: string[][]} | {error: string} | null} null: no such sheet
 */
export function parseWorkbookSheet(workbook, sheetName) {
  const sheet = workbook?.Sheets?.[sheetName];
  if (!sheet) return null;
  const arr = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!arr || arr.length === 0) return { error: 'Sheet is empty.' };
  const headers = (arr[0] || []).map((c) => String(c ?? '').trim());
  if (headers.length === 0 || headers.every((h) => !h)) return { error: 'No columns in first row.' };
  return { headers, rows: arr.slice(1).map((row) => headers.map((_, i) => (row && row[i] != null ? String(row[i]) : ''))) };
}
