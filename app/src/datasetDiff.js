/**
 * Table diff for two Dataset versions (the dataset-to-dataset "version of" edge).
 * Columns are matched by header name. Rows are matched by row ID when the versions share any
 * (Add version copies them, and the Dataset editor keeps them across edits); older versions that
 * were copied with fresh IDs fall back to matching identical rows, then pairing similar leftovers.
 */

import { displayCell, isAssetCell } from './datasetContent.js';

/** Leftover rows need at least this share of equal common-column cells to count as one edited row. */
const CONTENT_PAIR_MIN_SIMILARITY = 0.5;
/** Bounds the leftover-row search per row so large unmatched blocks stay fast. */
const CONTENT_PAIR_MAX_CANDIDATES = 50;
/** Word-level cell diff is skipped past this token-count product (the LCS table size). */
const CELL_DIFF_MAX_TOKEN_PRODUCT = 250000;

function cellKey(value) {
  if (isAssetCell(value)) return `\u0001${value.kind}:${value.assetIds.join(',')}`;
  return String(value ?? '');
}

export function cellsEqual(a, b) {
  return cellKey(a) === cellKey(b);
}

/** Header name + occurrence number, so duplicate header names still pair up one-to-one. */
function headerKeys(headers) {
  const seen = new Map();
  return (headers || []).map((header) => {
    const name = String(header ?? '');
    const n = seen.get(name) || 0;
    seen.set(name, n + 1);
    return `${name}\u0000${n}`;
  });
}

/** After-version order, with each removed column placed right after its preceding Before column. */
function alignColumns(beforeHeaders, afterHeaders) {
  const beforeKeys = headerKeys(beforeHeaders);
  const afterKeys = headerKeys(afterHeaders);
  const afterIndexByKey = new Map(afterKeys.map((key, i) => [key, i]));
  const beforeIndexByKey = new Map(beforeKeys.map((key, i) => [key, i]));
  const removedAfter = new Map();
  let anchor = -1;
  beforeKeys.forEach((key, i) => {
    const j = afterIndexByKey.get(key);
    if (j !== undefined) {
      anchor = j;
      return;
    }
    if (!removedAfter.has(anchor)) removedAfter.set(anchor, []);
    removedAfter.get(anchor).push(i);
  });
  const columns = [];
  const pushRemoved = (j) => (removedAfter.get(j) || []).forEach((i) => {
    columns.push({ name: String(beforeHeaders[i] ?? ''), status: 'removed', before: i, after: -1 });
  });
  pushRemoved(-1);
  afterKeys.forEach((key, j) => {
    const i = beforeIndexByKey.get(key);
    columns.push({ name: String(afterHeaders[j] ?? ''), status: i === undefined ? 'added' : 'same', before: i ?? -1, after: j });
    pushRemoved(j);
  });
  return columns;
}

function sharedRowIds(before, after) {
  const beforeIds = new Set((before.rowIds || []).filter(Boolean));
  return (after.rowIds || []).some((id) => id && beforeIds.has(id));
}

/** @returns {Map<number, number>} after row index -> before row index */
function matchRowsById(before, after) {
  const beforeIndexById = new Map();
  (before.rowIds || []).forEach((id, i) => {
    if (id && i < before.rows.length && !beforeIndexById.has(id)) beforeIndexById.set(id, i);
  });
  const matches = new Map();
  (after.rowIds || []).forEach((id, j) => {
    const i = id ? beforeIndexById.get(id) : undefined;
    if (i !== undefined && j < after.rows.length) {
      matches.set(j, i);
      beforeIndexById.delete(id);
    }
  });
  return matches;
}

/** @returns {Map<number, number>} after row index -> before row index */
function matchRowsByContent(before, after, commonColumns) {
  const fingerprint = (row, side) => JSON.stringify(commonColumns.map((c) => cellKey(row[c[side]])));
  const queues = new Map();
  before.rows.forEach((row, i) => {
    const fp = fingerprint(row, 'before');
    if (!queues.has(fp)) queues.set(fp, []);
    queues.get(fp).push(i);
  });
  const matches = new Map();
  after.rows.forEach((row, j) => {
    const queue = queues.get(fingerprint(row, 'after'));
    if (queue && queue.length) matches.set(j, queue.shift());
  });
  if (commonColumns.length === 0) return matches;

  // Pair leftover rows that sit between the same identical neighbours and mostly agree.
  const nextAnchorBefore = new Array(after.rows.length);
  let anchor = before.rows.length;
  for (let j = after.rows.length - 1; j >= 0; j -= 1) {
    nextAnchorBefore[j] = anchor;
    if (matches.has(j)) anchor = matches.get(j);
  }
  const usedBefore = new Set(matches.values());
  let previousBefore = -1;
  after.rows.forEach((row, j) => {
    if (matches.has(j)) {
      previousBefore = matches.get(j);
      return;
    }
    const nextBefore = nextAnchorBefore[j];
    let best = -1;
    let bestScore = CONTENT_PAIR_MIN_SIMILARITY;
    let scanned = 0;
    for (let i = previousBefore + 1; i < nextBefore && scanned < CONTENT_PAIR_MAX_CANDIDATES; i += 1) {
      if (usedBefore.has(i)) continue;
      scanned += 1;
      const equal = commonColumns.filter((c) => cellsEqual(before.rows[i][c.before], row[c.after])).length;
      const score = equal / commonColumns.length;
      if (score >= bestScore && (best < 0 || score > bestScore)) {
        best = i;
        bestScore = score;
      }
    }
    if (best >= 0) {
      matches.set(j, best);
      usedBefore.add(best);
      previousBefore = best;
    }
  });
  return matches;
}

/**
 * @param {{ headers: string[], rows: any[][], rowIds?: string[] }} before
 * @param {{ headers: string[], rows: any[][], rowIds?: string[] }} after
 * @returns {{
 *   method: 'rowId' | 'content',
 *   columns: { name: string, status: 'same'|'added'|'removed', before: number, after: number }[],
 *   rows: { status: 'same'|'changed'|'added'|'removed', before: number, after: number, changed: number[] }[],
 *   summary: { addedRows: number, removedRows: number, changedRows: number, unchangedRows: number,
 *     changedCells: number, addedColumns: string[], removedColumns: string[] },
 * }} `changed` lists indexes into `columns`; rows follow After order with removed rows at their Before position.
 */
export function diffDatasets(before, after) {
  const b = { headers: before?.headers || [], rows: before?.rows || [], rowIds: before?.rowIds || [] };
  const a = { headers: after?.headers || [], rows: after?.rows || [], rowIds: after?.rowIds || [] };
  const columns = alignColumns(b.headers, a.headers);
  const commonColumns = columns.filter((c) => c.status === 'same');
  const method = sharedRowIds(b, a) ? 'rowId' : 'content';
  const matches = method === 'rowId' ? matchRowsById(b, a) : matchRowsByContent(b, a, commonColumns);

  const matchedBefore = new Set(matches.values());
  const removed = b.rows.map((_, i) => i).filter((i) => !matchedBefore.has(i));
  // Within a gap between matched rows, removed rows are listed before added ones.
  const nextMatchedBefore = new Array(a.rows.length);
  let nextMatch = Infinity;
  for (let j = a.rows.length - 1; j >= 0; j -= 1) {
    if (matches.has(j)) nextMatch = matches.get(j);
    nextMatchedBefore[j] = nextMatch;
  }
  let removedCursor = 0;
  const rows = [];
  const emitRemovedBefore = (limit) => {
    while (removedCursor < removed.length && removed[removedCursor] < limit) {
      rows.push({ status: 'removed', before: removed[removedCursor], after: -1, changed: [] });
      removedCursor += 1;
    }
  };
  a.rows.forEach((row, j) => {
    const i = matches.get(j);
    if (i === undefined) {
      emitRemovedBefore(nextMatchedBefore[j]);
      rows.push({ status: 'added', before: -1, after: j, changed: [] });
      return;
    }
    emitRemovedBefore(i);
    const changed = [];
    columns.forEach((c, k) => {
      if (c.status === 'same' && !cellsEqual(b.rows[i][c.before], row[c.after])) changed.push(k);
    });
    rows.push({ status: changed.length ? 'changed' : 'same', before: i, after: j, changed });
  });
  emitRemovedBefore(Infinity);

  const count = (status) => rows.filter((r) => r.status === status).length;
  return {
    method,
    columns,
    rows,
    summary: {
      addedRows: count('added'),
      removedRows: count('removed'),
      changedRows: count('changed'),
      unchangedRows: count('same'),
      changedCells: rows.reduce((sum, r) => sum + r.changed.length, 0),
      addedColumns: columns.filter((c) => c.status === 'added').map((c) => c.name),
      removedColumns: columns.filter((c) => c.status === 'removed').map((c) => c.name),
    },
  };
}

/** Han/kana characters are single tokens so Chinese and Japanese text diffs by character. */
const CELL_TOKEN_RE = /\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/**
 * Word-level diff of two cell values.
 * @returns {{ type: 'same'|'add'|'remove', text: string }[] | null} null when either side is an
 *   asset cell or the texts are too long to diff, so the caller shows whole old/new values instead.
 */
export function diffCellText(oldValue, newValue) {
  if (isAssetCell(oldValue) || isAssetCell(newValue)) return null;
  const x = displayCell(oldValue).match(CELL_TOKEN_RE) || [];
  const y = displayCell(newValue).match(CELL_TOKEN_RE) || [];
  if (x.length * y.length > CELL_DIFF_MAX_TOKEN_PRODUCT) return null;
  const m = x.length;
  const n = y.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const parts = [];
  const push = (type, text) => {
    const last = parts[parts.length - 1];
    if (last && last.type === type) last.text += text;
    else parts.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && x[i] === y[j]) {
      push('same', x[i]);
      i += 1;
      j += 1;
    } else if (i < m && (j === n || dp[i + 1][j] >= dp[i][j + 1])) {
      push('remove', x[i]);
      i += 1;
    } else {
      push('add', y[j]);
      j += 1;
    }
  }
  return parts;
}
