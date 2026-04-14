/**
 * Run a mini–batch Run + Score evaluation for one Review prompt-edit suggestion (test if target rows pass).
 */

import { markEmptyOutputAsError } from './runResumeUtils.js';
import {
  prefetchEmbeddingCosineMap,
  embeddingPairMatches,
  getMatchFlags,
  normalizeForMatch,
  numericPairMatches,
  stringsMatchContains,
  stringsMatchSemanticAlign,
  migrateLegacyMatchType,
  canonicalizeMatchFlags,
  legacyMatchTypeWasContains,
} from './scoreDetailModal.js';

/** AbortControllers for in-flight Run+Score row checks (close modal / beforeunload cancels fetch + poll). */
const verifyAbortControllers = new Set();

export function registerVerifySession(ac) {
  if (ac && typeof ac.abort === 'function') verifyAbortControllers.add(ac);
}

export function unregisterVerifySession(ac) {
  verifyAbortControllers.delete(ac);
}

export function abortAllVerifyJobs() {
  for (const c of verifyAbortControllers) {
    try {
      c.abort();
    } catch (_) {}
  }
  verifyAbortControllers.clear();
}

/** True while any row-check run has a registered AbortController (review modal may be closed). */
export function hasActiveVerifySessions() {
  return verifyAbortControllers.size > 0;
}

const DEFAULT_SCORE_MATCH_FLAGS = {
  semanticAlign: false,
  embeddingSimilarity: false,
  contains: false,
  ignoreCase: false,
  ignoreSymbols: false,
  ignoreWhitespace: false,
  numericMode: 'exact',
  numericAbsEpsilon: 0,
  numericRelEpsilon: 0,
  numericDecimalPlaces: 2,
};

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureScoreGroupOps(data, children) {
  const n = (children || []).length;
  const len = Math.max(0, n - 1);
  if (Array.isArray(data.ops) && data.ops.length >= len) {
    return data.ops.slice(0, len).map((o) => (o === 'OR' ? 'OR' : 'AND'));
  }
  const defaultOp = data.op === 'OR' ? 'OR' : 'AND';
  return Array(len).fill(defaultOp);
}

function normalizeScoreGroupChild(c) {
  const children = (c.children || []).map((ch) => (ch && ch.type === 'group' ? normalizeScoreGroupChild(ch) : normalizeScoreChild(ch)));
  const ops = ensureScoreGroupOps(c, children);
  return { type: 'group', ops, children };
}

function normalizeScoreChild(c) {
  if (!c || c.type === 'rule') {
    const rawMt = (c && c.matchType) || 'exact';
    const f = { ...DEFAULT_SCORE_MATCH_FLAGS, ...((c && c.matchFlags && typeof c.matchFlags === 'object') ? c.matchFlags : {}) };
    if (legacyMatchTypeWasContains(rawMt)) f.contains = true;
    return {
      type: 'rule',
      outputKey: (c && c.outputKey) || '',
      gtColumns: Array.isArray(c && c.gtColumns) ? c.gtColumns.filter(Boolean) : [],
      matchType: migrateLegacyMatchType(rawMt),
      matchFlags: canonicalizeMatchFlags(f),
    };
  }
  return normalizeScoreGroupChild(c);
}

function normalizeScoreMappingToRules(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const pairs = [];
  const first = arr[0];
  if (first && first.outputKey != null && first.gtColumn != null) {
    arr.forEach((r) => {
      pairs.push({ outputKey: r.outputKey || '', gtColumn: r.gtColumn || '', matchType: r.matchType || 'exact' });
    });
  } else if (first && first.rules) {
    arr.forEach((g) => {
      (g.rules || []).forEach((r) => {
        pairs.push({ outputKey: r.outputKey || '', gtColumn: r.gtColumn || '', matchType: r.matchType || 'exact' });
      });
    });
  } else {
    return [];
  }
  const byKey = {};
  pairs.forEach((p) => {
    const raw = p.matchType || 'exact';
    if (!byKey[p.outputKey]) {
      byKey[p.outputKey] = {
        outputKey: p.outputKey,
        gtColumns: [],
        matchType: migrateLegacyMatchType(raw),
        anyContains: false,
      };
    }
    if (legacyMatchTypeWasContains(raw)) byKey[p.outputKey].anyContains = true;
    byKey[p.outputKey].matchType = migrateLegacyMatchType(raw);
    if (p.gtColumn && !byKey[p.outputKey].gtColumns.includes(p.gtColumn)) byKey[p.outputKey].gtColumns.push(p.gtColumn);
  });
  return Object.values(byKey)
    .filter((r) => r.outputKey || r.gtColumns.length > 0)
    .map((r) => ({
      outputKey: r.outputKey,
      gtColumns: r.gtColumns,
      matchType: r.matchType,
      matchFlags: { ...DEFAULT_SCORE_MATCH_FLAGS, contains: r.anyContains },
    }));
}

export function parseScoreMappingToTree(data) {
  if (!data) return { type: 'group', ops: [], children: [] };
  if (data.type === 'group' && Array.isArray(data.children)) {
    const children = data.children.map((c) => (c && c.type === 'group' ? normalizeScoreGroupChild(c) : normalizeScoreChild(c)));
    const ops = ensureScoreGroupOps(data, children);
    return { type: 'group', ops, children };
  }
  const rules = normalizeScoreMappingToRules(Array.isArray(data) ? data : []);
  const children = rules.map((r) => ({
    type: 'rule',
    outputKey: r.outputKey || '',
    gtColumns: (r.gtColumns || []).slice(),
    matchType: migrateLegacyMatchType(r.matchType || 'exact'),
    matchFlags: { ...DEFAULT_SCORE_MATCH_FLAGS, ...(r.matchFlags && typeof r.matchFlags === 'object' ? r.matchFlags : {}) },
  }));
  const ops = Array(Math.max(0, children.length - 1)).fill('AND');
  return { type: 'group', ops, children };
}

function toCompareStr(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map((x) => toCompareStr(x)).join(', ').trim();
  return String(v).trim();
}

function getRunValue(runResult, outputKey, runWs, outputFields) {
  const displayIdx = runResult?.row_index ?? 0;
  const inputRowIdx = runResult?.input_row_index ?? runResult?.row_index ?? 0;
  if (outputKey === '#' || outputKey === '[#]') return toCompareStr(displayIdx);
  const keyStr = String(outputKey || '').trim();
  if (!keyStr) return '';
  const isBracket = keyStr.startsWith('[') && keyStr.endsWith(']');
  if (isBracket) {
    const header = keyStr.slice(1, -1).trim();
    const rows = runWs.rows || [];
    const headers = runWs.headers || [];
    const colIdx = headers.findIndex((h) => String(h).trim() === header);
    if (colIdx >= 0 && rows[inputRowIdx]) return toCompareStr(rows[inputRowIdx][colIdx]);
    return '';
  }
  if (runResult?.output && typeof runResult.output === 'object' && keyStr in runResult.output) return toCompareStr(runResult.output[keyStr]);
  if (runResult?.error) return toCompareStr(runResult.error);
  return '';
}

function getGtValue(gtContent, rowIndex, columnName) {
  const headers = gtContent.headers || [];
  const rows = gtContent.rows || [];
  const colIdx = headers.findIndex((h) => String(h).trim() === String(columnName).trim());
  if (colIdx >= 0 && rows[rowIndex]) return toCompareStr(rows[rowIndex][colIdx]);
  return '';
}

function ruleMatchesRow(rule, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent, embeddingMap) {
  if (!rule || rule.type !== 'rule') return false;
  const runResult = resultsByIndex.get(runRowIndex) || null;
  const runValRaw = getRunValue(runResult, rule.outputKey, runWs, outputFields);
  const gtValsRaw = (rule.gtColumns || []).map((col) => getGtValue(gtContent, gtRowIndex, col));
  const matchType = migrateLegacyMatchType(rule.matchType);
  const flags = getMatchFlags(rule);

  if (matchType === 'numeric') {
    const runNorm = normalizeForMatch(runValRaw, flags, true);
    return gtValsRaw.some((g) => {
      const gtNorm = normalizeForMatch(g, flags, true);
      return numericPairMatches(runNorm, gtNorm, flags);
    });
  }

  if (matchType === 'exact' && flags.embeddingSimilarity) {
    return gtValsRaw.some((g) => embeddingPairMatches(runValRaw, g, embeddingMap));
  }
  if (matchType === 'exact' && flags.semanticAlign) {
    return gtValsRaw.some((g) => stringsMatchSemanticAlign(runValRaw, g));
  }
  const runVal = normalizeForMatch(runValRaw, flags, false);
  return gtValsRaw.some((g) => {
    const gtVal = normalizeForMatch(g, flags, false);
    if (matchType === 'exact') {
      if (flags.contains) return stringsMatchContains(runVal, gtVal);
      return runVal === gtVal;
    }
    return runVal === gtVal;
  });
}

function evaluateScoreTree(node, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent, embeddingMap) {
  if (!node) return false;
  if (node.type === 'rule') {
    return ruleMatchesRow(node, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent, embeddingMap);
  }
  if (node.type === 'group' && Array.isArray(node.children)) {
    if (node.children.length === 0) return false;
    const ops = node.ops || Array(Math.max(0, node.children.length - 1)).fill('AND');
    let r = evaluateScoreTree(node.children[0], runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent, embeddingMap);
    for (let i = 1; i < node.children.length; i++) {
      const next = evaluateScoreTree(node.children[i], runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent, embeddingMap);
      r = ops[i - 1] === 'OR' ? r || next : r && next;
    }
    return r;
  }
  return false;
}

export function substitutePromptPlaceholders(templateText, rowInput) {
  let text = String(templateText || '');
  const inp = rowInput && typeof rowInput === 'object' ? rowInput : {};
  for (const k of Object.keys(inp)) {
    const name = String(k).trim();
    if (!name) continue;
    const val = inp[k] == null ? '' : String(inp[k]);
    text = text.replace(new RegExp(`\\{${escapeRegex(name)}\\}`, 'g'), val);
  }
  return text;
}

/** Stable key for matching comparison rows that share the same prompt placeholders (1 input → N outputs). */
function stableRowInputKey(rowInput) {
  const inp = rowInput && typeof rowInput === 'object' ? rowInput : {};
  const keys = Object.keys(inp).sort();
  return keys.map((k) => `${k}\0${String(inp[k])}`).join('\n');
}

function runnableRowsWithInputIndex(rows, inputIdx) {
  if (typeof inputIdx !== 'number' || Number.isNaN(inputIdx) || inputIdx < 0) return [];
  return rows.filter(
    (r) =>
      r &&
      !r.gt_only &&
      typeof r.input_row_index === 'number' &&
      !Number.isNaN(r.input_row_index) &&
      Number(r.input_row_index) === inputIdx
  );
}

/**
 * When row_index t hits a synthetic gt_only row, resolve runnable rows: same GT pair (source_gt_row_index),
 * worksheet input_row_index t, same input_row_index on the synthetic row, or same row_input.
 * gt_only may share input_row_index with runnable rows (Phase 1 grouping); if both input_row_index and row_input are null, expand by row_index only.
 */
function runnableRowsForGtOnlyTarget(allRows, gtOnlyRow, t) {
  const out = [];
  const pushUnique = (arr) => {
    for (const r of arr) {
      if (r && !out.some((x) => x.row_index === r.row_index)) out.push(r);
    }
  };

  const gtJ = gtOnlyRow.source_gt_row_index;
  if (typeof gtJ === 'number' && !Number.isNaN(gtJ) && gtJ >= 0) {
    const bySameGt = allRows.filter(
      (r) => r && !r.gt_only && typeof r.source_gt_row_index === 'number' && r.source_gt_row_index === gtJ
    );
    pushUnique(bySameGt);
  }

  pushUnique(runnableRowsWithInputIndex(allRows, t));

  const synthInp = gtOnlyRow.input_row_index;
  if (typeof synthInp === 'number' && !Number.isNaN(synthInp) && synthInp !== t) {
    pushUnique(runnableRowsWithInputIndex(allRows, synthInp));
  }

  const wantKey = stableRowInputKey(gtOnlyRow.row_input);
  if (wantKey) {
    const byPrompt = allRows.filter(
      (r) => r && !r.gt_only && stableRowInputKey(r.row_input) === wantKey
    );
    pushUnique(byPrompt);
  }

  out.sort((a, b) => (a.row_index || 0) - (b.row_index || 0));
  return out;
}

/** Optional 1-based Score detail # for a comparison row (saved as `score_table_row`). */
function scoreTableNumberLabel(rows, comparisonRowIndex) {
  const r = rows.find((x) => Number(x?.row_index) === Number(comparisonRowIndex));
  const n = r && r.score_table_row != null ? Number(r.score_table_row) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * Each target t is usually a comparison row_index (Run result index). If no runnable row matches,
 * treat t as input_row_index (0-based worksheet row — same as UI Input # minus 1) and expand to all runnable comparison rows for that input.
 */
export function expandTargetsToRunnableComparisonRows(comparisonRows, orderedTargets) {
  const rows = Array.isArray(comparisonRows) ? comparisonRows : [];
  const byRowIndex = new Map();
  for (const r of rows) {
    if (r && typeof r.row_index === 'number' && !Number.isNaN(r.row_index)) {
      byRowIndex.set(r.row_index, r);
    }
  }

  const expanded = [];
  const seenRowIndex = new Set();

  for (const t of orderedTargets) {
    const direct = byRowIndex.get(t);

    if (direct && !direct.gt_only) {
      if (!seenRowIndex.has(direct.row_index)) {
        expanded.push(direct);
        seenRowIndex.add(direct.row_index);
      }
      continue;
    }

    /* row_index t may be a synthetic gt_only row — resolve before treating t as plain input_row_index. */
    if (direct && direct.gt_only) {
      const resolved = runnableRowsForGtOnlyTarget(rows, direct, t);
      if (resolved.length > 0) {
        for (const r of resolved) {
          if (!seenRowIndex.has(r.row_index)) {
            expanded.push(r);
            seenRowIndex.add(r.row_index);
          }
        }
        continue;
      }
      const st = scoreTableNumberLabel(rows, t);
      const stPart = st != null ? ` (Score table #${st})` : '';
      return {
        error:
          `Cannot verify target ${t}: comparison row_index ${t}${stPart} is ground-truth only (no model output). ` +
          `Verify needs a runnable row with model output; none shares this row’s GT pairing, worksheet input_row_index, or row_input. ` +
          `Often caused by unpaired ground-truth rows or one input → multiple outputs with mismatched indices.`,
      };
    }

    const byInput = runnableRowsWithInputIndex(rows, t);
    if (byInput.length > 0) {
      for (const r of byInput) {
        if (!seenRowIndex.has(r.row_index)) {
          expanded.push(r);
          seenRowIndex.add(r.row_index);
        }
      }
      continue;
    }

    return {
      error:
        `Cannot verify target ${t}: no runnable row with row_index ${t} or input_row_index ${t}.`,
    };
  }

  return { rows: expanded };
}

function sleepMs(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function requestRunCancel(apiBase, runId) {
  if (!runId) return;
  const base = String(apiBase || 'http://localhost:8000').replace(/\/$/, '');
  try {
    await fetch(`${base}/api/run/cancel/${runId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch (_) {}
}

/**
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: boolean, results: unknown[], error: string|null, aborted?: boolean }>}
 */
async function pollRunUntilDone(apiBase, runId, signal) {
  const base = String(apiBase || 'http://localhost:8000').replace(/\/$/, '');
  const deadline = Date.now() + 900000;
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await requestRunCancel(apiBase, runId);
        return { ok: false, results: [], error: 'aborted', aborted: true };
      }
      const res = await fetch(`${base}/api/run/result/${runId}`, { signal });
      const data = await res.json().catch(() => ({}));
      if (res.status === 202) {
        await sleepMs(350, signal);
        continue;
      }
      if (res.status === 200 && (data.status === 'done' || data.status === 'cancelled')) {
        return {
          ok: data.status === 'done' && !data.error,
          results: Array.isArray(data.results) ? data.results : [],
          error: data.error || null,
        };
      }
      await sleepMs(400, signal);
    }
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') {
      await requestRunCancel(apiBase, runId);
      return { ok: false, results: [], error: 'aborted', aborted: true };
    }
    return { ok: false, results: [], error: String(e?.message || e) };
  }
  return { ok: false, results: [], error: 'Run poll timeout' };
}

/**
 * @param {object} opts
 * @returns {Promise<{ ok: boolean, detail?: string }>}
 */
export async function runSuggestionRowTests(opts) {
  const {
    apiBase = 'http://localhost:8000',
    credentialId,
    testSections,
    targetComparisonRowIndices,
    comparisonRows,
    runResults,
    outputFields,
    outputSchema,
    scoreMappingJson,
    runWs,
    gtContent,
    signal,
  } = opts;

  if (!credentialId || !outputSchema || !Array.isArray(outputSchema.fields) || outputSchema.fields.length === 0) {
    return { ok: false, detail: 'Missing credential or output schema.' };
  }

  let scoreRoot;
  try {
    const raw = typeof scoreMappingJson === 'string' ? JSON.parse(scoreMappingJson || '[]') : scoreMappingJson;
    scoreRoot = parseScoreMappingToTree(raw);
  } catch (_) {
    return { ok: false, detail: 'Invalid score mapping.' };
  }

  const runWsSafe = runWs && typeof runWs === 'object' ? { headers: runWs.headers || [], rows: runWs.rows || [] } : { headers: [], rows: [] };
  const gtSafe = gtContent && typeof gtContent === 'object' ? { headers: gtContent.headers || [], rows: gtContent.rows || [] } : { headers: [], rows: [] };

  const templateText = Array.isArray(testSections)
    ? testSections
        .map((s) => {
          const name = (s.name || '').trim() || '(unnamed)';
          const content = (s.content || '').trim() || '';
          return `## ${name}\n\n${content}`;
        })
        .join('\n\n')
    : '';

  const seenT = new Set();
  const orderedTargets = [];
  for (const x of targetComparisonRowIndices || []) {
    const n = Number(x);
    if (Number.isNaN(n) || n < 0) continue;
    if (seenT.has(n)) continue;
    seenT.add(n);
    orderedTargets.push(n);
  }
  if (orderedTargets.length === 0) return { ok: false, detail: 'No target rows for verification.' };

  const expanded = expandTargetsToRunnableComparisonRows(comparisonRows, orderedTargets);
  if (expanded.error) return { ok: false, detail: expanded.error };
  const expandedRows = expanded.rows;
  if (!expandedRows.length) return { ok: false, detail: 'No runnable comparison rows to verify.' };

  const prompts = expandedRows.map((row) => substitutePromptPlaceholders(templateText, row.row_input || {}));

  const base = String(apiBase).replace(/\/$/, '');
  let runId;
  try {
    const inspectRunId = `verify_${Date.now()}_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 14)}`;
    const res = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        credential_id: credentialId,
        prompts,
        output_schema: outputSchema,
        run_node_id: null,
        inspect_run_id: inspectRunId,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status !== 202) {
      const msg = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data) || res.statusText;
      return { ok: false, detail: msg || 'Run request failed' };
    }
    runId = data.run_id;
  } catch (e) {
    if (e?.name === 'AbortError' || signal?.aborted) {
      return { ok: false, detail: 'aborted', aborted: true };
    }
    return { ok: false, detail: String(e.message || e) };
  }

  const polled = await pollRunUntilDone(apiBase, runId, signal);
  if (polled.aborted) {
    return { ok: false, detail: 'aborted', aborted: true };
  }
  if (!polled.ok) {
    return { ok: false, detail: polled.error || 'Run did not complete.' };
  }

  let fresh = markEmptyOutputAsError(polled.results || []);
  for (let i = 0; i < expandedRows.length; i++) {
    const r = fresh[i];
    const compRow = expandedRows[i];
    const label =
      compRow && typeof compRow.row_index === 'number'
        ? `row_index ${compRow.row_index}` + (typeof compRow.input_row_index === 'number' ? ` (Input #${compRow.input_row_index + 1})` : '')
        : String(i);
    if (!r || r.error || !r.output) {
      return { ok: false, detail: `Model error on ${label}: ${r?.error || 'empty output'}` };
    }
  }

  const resultsByIndex = new Map();
  (runResults || []).forEach((r) => {
    if (r && typeof r.row_index === 'number') resultsByIndex.set(r.row_index, r);
  });

  const rowIndexToFreshOut = new Map();
  expandedRows.forEach((compRow, i) => {
    const out = fresh[i]?.output;
    if (out && typeof out === 'object' && compRow && typeof compRow.row_index === 'number') {
      rowIndexToFreshOut.set(compRow.row_index, out);
    }
  });

  let embeddingMap = new Map();
  try {
    const patchedForEmb = (runResults || []).map((r) => {
      if (!r) return r;
      const out = rowIndexToFreshOut.get(r.row_index);
      if (out == null) return r;
      return { ...r, output: typeof out === 'object' ? { ...out } : {}, error: undefined };
    });
    embeddingMap = await prefetchEmbeddingCosineMap(apiBase, {
      root: scoreRoot,
      results: patchedForEmb,
      outputFields: outputFields || [],
      runWs: runWsSafe,
      gtContent: gtSafe,
      getRunValue: (runResult, outputKey, _runRowIndex, ws, of) => getRunValue(runResult, outputKey, ws, of),
      getGtValue,
    });
  } catch (_) {
    embeddingMap = new Map();
  }

  for (let i = 0; i < expandedRows.length; i++) {
    const compRow = expandedRows[i];
    const compIdx = compRow.row_index;
    const gtJ = compRow.source_gt_row_index;
    if (gtJ == null || gtJ === undefined || Number.isNaN(Number(gtJ)) || Number(gtJ) < 0) {
      return { ok: false, detail: `No paired ground truth for row_index ${compIdx}.` };
    }
    const synOut = fresh[i].output && typeof fresh[i].output === 'object' ? { ...fresh[i].output } : {};
    const baseRes = resultsByIndex.get(compIdx) || { row_index: compIdx, output: {} };
    resultsByIndex.set(compIdx, {
      ...baseRes,
      row_index: compIdx,
      output: synOut,
      error: undefined,
    });
    const pass = evaluateScoreTree(scoreRoot, compIdx, gtJ, resultsByIndex, runWsSafe, outputFields || [], gtSafe, embeddingMap);
    if (!pass) {
      const inLabel =
        typeof compRow.input_row_index === 'number' && !Number.isNaN(compRow.input_row_index)
          ? `row_index ${compIdx}, worksheet Input #${compRow.input_row_index + 1}`
          : `row_index ${compIdx}`;
      return { ok: false, detail: `Score rules still fail for ${inLabel}.` };
    }
  }

  return { ok: true };
}

/**
 * Same pipeline as {@link runSuggestionRowTests} but returns per-row pass rate (e.g. Finetune / metrics).
 * @returns {Promise<{ ok: boolean, passRate?: number, passed?: number, total?: number, allPass?: boolean, detail?: string }>}
 */
export async function runSuggestionRowTestsMetrics(opts) {
  const {
    apiBase = 'http://localhost:8000',
    credentialId,
    testSections,
    targetComparisonRowIndices,
    comparisonRows,
    runResults,
    outputFields,
    outputSchema,
    scoreMappingJson,
    runWs,
    gtContent,
    signal,
  } = opts;

  if (!credentialId || !outputSchema || !Array.isArray(outputSchema.fields) || outputSchema.fields.length === 0) {
    return { ok: false, detail: 'Missing credential or output schema.' };
  }

  let scoreRoot;
  try {
    const raw = typeof scoreMappingJson === 'string' ? JSON.parse(scoreMappingJson || '[]') : scoreMappingJson;
    scoreRoot = parseScoreMappingToTree(raw);
  } catch (_) {
    return { ok: false, detail: 'Invalid score mapping.' };
  }

  const runWsSafe = runWs && typeof runWs === 'object' ? { headers: runWs.headers || [], rows: runWs.rows || [] } : { headers: [], rows: [] };
  const gtSafe = gtContent && typeof gtContent === 'object' ? { headers: gtContent.headers || [], rows: gtContent.rows || [] } : { headers: [], rows: [] };

  const templateText = Array.isArray(testSections)
    ? testSections
        .map((s) => {
          const name = (s.name || '').trim() || '(unnamed)';
          const content = (s.content || '').trim() || '';
          return `## ${name}\n\n${content}`;
        })
        .join('\n\n')
    : '';

  const seenT = new Set();
  const orderedTargets = [];
  for (const x of targetComparisonRowIndices || []) {
    const n = Number(x);
    if (Number.isNaN(n) || n < 0) continue;
    if (seenT.has(n)) continue;
    seenT.add(n);
    orderedTargets.push(n);
  }
  if (orderedTargets.length === 0) return { ok: false, detail: 'No target rows for verification.' };

  const expanded = expandTargetsToRunnableComparisonRows(comparisonRows, orderedTargets);
  if (expanded.error) return { ok: false, detail: expanded.error };
  const expandedRows = expanded.rows;
  if (!expandedRows.length) return { ok: false, detail: 'No runnable comparison rows to verify.' };

  const prompts = expandedRows.map((row) => substitutePromptPlaceholders(templateText, row.row_input || {}));

  const base = String(apiBase).replace(/\/$/, '');
  let runId;
  try {
    const inspectRunId = `verify_${Date.now()}_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 14)}`;
    const res = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        credential_id: credentialId,
        prompts,
        output_schema: outputSchema,
        run_node_id: null,
        inspect_run_id: inspectRunId,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status !== 202) {
      const msg = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data) || res.statusText;
      return { ok: false, detail: msg || 'Run request failed' };
    }
    runId = data.run_id;
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') {
      return { ok: false, detail: 'aborted', aborted: true };
    }
    return { ok: false, detail: String(e.message || e) };
  }

  const polled = await pollRunUntilDone(apiBase, runId, signal);
  if (polled.aborted) {
    return { ok: false, detail: 'aborted', aborted: true };
  }
  if (!polled.ok) {
    return { ok: false, detail: polled.error || 'Run did not complete.' };
  }

  if (signal?.aborted) {
    await requestRunCancel(apiBase, runId);
    return { ok: false, detail: 'aborted', aborted: true };
  }

  let fresh = markEmptyOutputAsError(polled.results || []);
  for (let i = 0; i < expandedRows.length; i++) {
    const r = fresh[i];
    const compRow = expandedRows[i];
    const label =
      compRow && typeof compRow.row_index === 'number'
        ? `row_index ${compRow.row_index}` + (typeof compRow.input_row_index === 'number' ? ` (Input #${compRow.input_row_index + 1})` : '')
        : String(i);
    if (!r || r.error || !r.output) {
      return { ok: false, detail: `Model error on ${label}: ${r?.error || 'empty output'}` };
    }
  }

  const resultsByIndex = new Map();
  (runResults || []).forEach((r) => {
    if (r && typeof r.row_index === 'number') resultsByIndex.set(r.row_index, r);
  });

  const rowIndexToFreshOut = new Map();
  expandedRows.forEach((compRow, i) => {
    const out = fresh[i]?.output;
    if (out && typeof out === 'object' && compRow && typeof compRow.row_index === 'number') {
      rowIndexToFreshOut.set(compRow.row_index, out);
    }
  });

  let embeddingMap = new Map();
  try {
    if (signal?.aborted) {
      return { ok: false, detail: 'aborted', aborted: true };
    }
    const patchedForEmb = (runResults || []).map((r) => {
      if (!r) return r;
      const out = rowIndexToFreshOut.get(r.row_index);
      if (out == null) return r;
      return { ...r, output: typeof out === 'object' ? { ...out } : {}, error: undefined };
    });
    embeddingMap = await prefetchEmbeddingCosineMap(apiBase, {
      root: scoreRoot,
      results: patchedForEmb,
      outputFields: outputFields || [],
      runWs: runWsSafe,
      gtContent: gtSafe,
      getRunValue: (runResult, outputKey, _runRowIndex, ws, of) => getRunValue(runResult, outputKey, ws, of),
      getGtValue,
    });
  } catch (_) {
    embeddingMap = new Map();
  }

  if (signal?.aborted) {
    return { ok: false, detail: 'aborted', aborted: true };
  }

  let passed = 0;
  const n = expandedRows.length;
  for (let i = 0; i < expandedRows.length; i++) {
    const compRow = expandedRows[i];
    const compIdx = compRow.row_index;
    const gtJ = compRow.source_gt_row_index;
    if (gtJ == null || gtJ === undefined || Number.isNaN(Number(gtJ)) || Number(gtJ) < 0) {
      return { ok: false, detail: `No paired ground truth for row_index ${compIdx}.` };
    }
    const synOut = fresh[i].output && typeof fresh[i].output === 'object' ? { ...fresh[i].output } : {};
    const baseRes = resultsByIndex.get(compIdx) || { row_index: compIdx, output: {} };
    resultsByIndex.set(compIdx, {
      ...baseRes,
      row_index: compIdx,
      output: synOut,
      error: undefined,
    });
    const pass = evaluateScoreTree(scoreRoot, compIdx, gtJ, resultsByIndex, runWsSafe, outputFields || [], gtSafe, embeddingMap);
    if (pass) passed += 1;
  }

  return { ok: true, passRate: n ? passed / n : 0, passed, total: n, allPass: passed === n };
}
