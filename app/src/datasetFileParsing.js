/**
 * Reads the tables Create Dataset accepts (.csv, .tsv, .xlsx, .xls) into {headers, rows}. The Agent's
 * chat attachments use the same rules, so a table it imports matches one the user would import
 * (docs/design/AGENT_ATTACHMENTS_PLAN.md).
 */
import * as XLSX from 'xlsx';

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
