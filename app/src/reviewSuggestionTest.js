/**
 * Review suggestion mini-run + Score pairing: build prompt from **accepted** working sections (`testSections`).
 * Resolve targets → comparison rows → **one mini-run per distinct worksheet input**; re-score with the same greedy
 * **Input→GT + Output→GT** pairing as Score (`computeGreedyRunToGtPairing`).
 * Used by Finetune metrics (`runSuggestionRowTestsMetrics`).
 */

import { markEmptyOutputAsError } from './runResumeUtils.js';
import { parseScoreMappingBundle, emptyScoreRuleGroup, scoreBundleRootsForEmbeddingWalk } from './scoreMappingBundle.js';
import { flattenScoreRules, computeGreedyRunToGtPairing } from './scoreRunGtPairing.js';
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
  isValidRunOutputForScoreRow,
} from './scoreDetailModal.js';

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

/** Full AND/OR rule tree (same convention as Score / workflowCanvas `isPairMatchLocal`). */
function evaluateScoreRuleTree(node, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent, embeddingMap) {
  if (!node) return false;
  if (node.type === 'rule') {
    return ruleMatchesRow(node, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent, embeddingMap);
  }
  if (node.type === 'group' && Array.isArray(node.children)) {
    if (node.children.length === 0) return false;
    const ops = node.ops || Array(Math.max(0, node.children.length - 1)).fill('AND');
    let r = evaluateScoreRuleTree(
      node.children[0],
      runRowIndex,
      gtRowIndex,
      resultsByIndex,
      runWs,
      outputFields,
      gtContent,
      embeddingMap,
    );
    for (let i = 1; i < node.children.length; i++) {
      const next = evaluateScoreRuleTree(
        node.children[i],
        runRowIndex,
        gtRowIndex,
        resultsByIndex,
        runWs,
        outputFields,
        gtContent,
        embeddingMap,
      );
      r = ops[i - 1] === 'OR' ? r || next : r && next;
    }
    return r;
  }
  return false;
}

function treeMatchesPairFull(rootTree, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent, embeddingMap) {
  const leaves = flattenScoreRules(rootTree || emptyScoreRuleGroup());
  if (leaves.length === 0) return true;
  return evaluateScoreRuleTree(rootTree, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent, embeddingMap);
}

/** True iff this run/GT pair satisfies both input and output rule trees (Score row `matched`). */
function verifyPairIsFullScoreMatch(
  inputRoot,
  outputRoot,
  runI,
  gtJ,
  resultsByIndex,
  runWs,
  outputFields,
  gtContent,
  embeddingMap,
) {
  if (runI < 0 || gtJ < 0) return false;
  if (!treeMatchesPairFull(inputRoot, runI, gtJ, resultsByIndex, runWs, outputFields, gtContent, embeddingMap)) return false;
  const outLeaves = flattenScoreRules(outputRoot || emptyScoreRuleGroup());
  if (outLeaves.length === 0) return true;
  return treeMatchesPairFull(outputRoot, runI, gtJ, resultsByIndex, runWs, outputFields, gtContent, embeddingMap);
}

function parseScoreMappingRaw(scoreMappingJson) {
  if (typeof scoreMappingJson === 'string') {
    try {
      return JSON.parse(scoreMappingJson || '{}');
    } catch (_) {
      return {};
    }
  }
  return scoreMappingJson && typeof scoreMappingJson === 'object' ? scoreMappingJson : {};
}

/** v2 bundle: both rule trees, same as Score / Review comparison rows. */
function parseVerifyScoreBundle(scoreMappingJson) {
  const raw = parseScoreMappingRaw(scoreMappingJson);
  const { inputRoot, outputRoot } = parseScoreMappingBundle(raw);
  return {
    inputRoot: inputRoot && typeof inputRoot === 'object' ? inputRoot : emptyScoreRuleGroup(),
    outputRoot: outputRoot && typeof outputRoot === 'object' ? outputRoot : emptyScoreRuleGroup(),
  };
}

/** Group `/api/run` merged results by prompt slot (0..numSlots-1), stable by global `row_index`. */
function partitionFreshByPromptSlot(fresh, numSlots) {
  const bySlot = Array.from({ length: Math.max(0, numSlots) }, () => []);
  for (const row of fresh || []) {
    if (!row) continue;
    const j = row.input_row_index;
    if (typeof j !== 'number' || Number.isNaN(j) || j < 0 || j >= numSlots) continue;
    bySlot[j].push(row);
  }
  for (const arr of bySlot) {
    arr.sort((a, b) => (a.row_index ?? 0) - (b.row_index ?? 0));
  }
  return bySlot;
}

/**
 * All saved run result rows for the same worksheet input as `runRows[slotJ]` (order = `row_index`).
 * Fallback when `input_row_index` is missing: rows tied to this slot via expanded comparison rows only.
 */
function bandRunResultsForSlot(runResults, runRows, slotJ, expandedRows, expandedRowToRunIdx) {
  const rep = runRows[slotJ];
  const wsRep =
    rep && typeof rep.input_row_index === 'number' && !Number.isNaN(rep.input_row_index) && rep.input_row_index >= 0
      ? rep.input_row_index
      : null;
  let band = [];
  if (wsRep != null) {
    band = (runResults || []).filter(
      (r) =>
        r &&
        typeof r.input_row_index === 'number' &&
        !Number.isNaN(r.input_row_index) &&
        r.input_row_index === wsRep,
    );
  } else {
    const want = new Set();
    expandedRows.forEach((er, i) => {
      if (expandedRowToRunIdx[i] === slotJ && typeof er.row_index === 'number' && !Number.isNaN(er.row_index)) {
        want.add(er.row_index);
      }
    });
    band = (runResults || []).filter((r) => r && want.has(r.row_index));
  }
  band.sort((a, b) => (a.row_index ?? 0) - (b.row_index ?? 0));
  return band;
}

/**
 * Map mini-run lines onto saved `row_index` values; clone full `runResults` with patched `output`.
 */
function buildPatchedRunResultsForVerify(
  runResults,
  runRows,
  expandedRows,
  expandedRowToRunIdx,
  freshBySlot,
) {
  const patchOut = new Map();
  const nSlots = runRows.length;
  for (let j = 0; j < nSlots; j++) {
    const chunk = freshBySlot[j] || [];
    const band = bandRunResultsForSlot(runResults, runRows, j, expandedRows, expandedRowToRunIdx);
    if (chunk.length !== band.length) {
      const rep = runRows[j];
      const inLab =
        rep && typeof rep.input_row_index === 'number' && !Number.isNaN(rep.input_row_index)
          ? `worksheet Input #${rep.input_row_index + 1}`
          : `verify slot ${j + 1}`;
      return {
        error: `${inLab}: mini-run returned ${chunk.length} output line(s) but the saved run has ${band.length} line(s) for this input — cannot align rows.`,
      };
    }
    for (let k = 0; k < band.length; k++) {
      const out = chunk[k]?.output;
      patchOut.set(band[k].row_index, out && typeof out === 'object' ? { ...out } : {});
    }
  }
  const patched = (runResults || []).map((r) => {
    if (!r || !patchOut.has(r.row_index)) return r;
    return { ...r, output: patchOut.get(r.row_index), error: undefined };
  });
  return { patched };
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

function sectionsToVerifyTemplate(testSections) {
  if (!Array.isArray(testSections)) return '';
  return testSections
    .map((s) => {
      const name = (s.name || '').trim() || '(unnamed)';
      const content = (s.content || '').trim() || '';
      return `## ${name}\n\n${content}`;
    })
    .join('\n\n');
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
 * Stable identity for input-closed Verify / Finetune checks (aligns with backend `_input_identity_key`).
 * Runnable rows only; used to expand targets to every comparison row sharing the same worksheet input / placeholders.
 */
function comparisonRowInputIdentityKey(r) {
  if (!r || r.gt_only) return null;
  const iri = r.input_row_index;
  if (typeof iri === 'number' && !Number.isNaN(iri) && iri >= 0) {
    return `in:${iri}`;
  }
  const rk = stableRowInputKey(r.row_input);
  if (rk) return `inp:${rk}`;
  const ri = r.row_index;
  if (typeof ri === 'number' && !Number.isNaN(ri)) return `row:${ri}`;
  return null;
}

/**
 * One `/api/run` prompt per distinct worksheet input; `expandedRowToRunIdx[i]` indexes into `fresh` for `expandedRows[i]`.
 */
function planVerifyMiniRuns(expandedRows) {
  const keyToRunIdx = new Map();
  const runRows = [];
  const expandedRowToRunIdx = [];
  for (const row of expandedRows) {
    const k = comparisonRowInputIdentityKey(row) || `row:${row.row_index}`;
    let idx = keyToRunIdx.get(k);
    if (idx === undefined) {
      idx = runRows.length;
      keyToRunIdx.set(k, idx);
      runRows.push(row);
    }
    expandedRowToRunIdx.push(idx);
  }
  return { runRows, expandedRowToRunIdx };
}

/** All runnable comparison rows whose identity matches any seed (same input → all output lines). */
function expandInputClosureFromSeedRows(allRows, seedRows) {
  const identities = new Set();
  for (const r of seedRows) {
    const k = comparisonRowInputIdentityKey(r);
    if (k) identities.add(k);
  }
  if (identities.size === 0) return [];
  const out = [];
  const seen = new Set();
  for (const r of allRows) {
    if (!r || r.gt_only) continue;
    const k = comparisonRowInputIdentityKey(r);
    if (!k || !identities.has(k)) continue;
    const ri = r.row_index;
    if (typeof ri !== 'number' || Number.isNaN(ri)) continue;
    if (seen.has(ri)) continue;
    seen.add(ri);
    out.push(r);
  }
  out.sort((a, b) => (a.row_index || 0) - (b.row_index || 0));
  return out;
}

/**
 * When row_index t hits a synthetic gt_only row, resolve runnable rows: same GT pair (source_gt_row_index),
 * worksheet input_row_index on the synthetic row, same row_input, then fallbacks for unpaired GT.
 * Note: t is comparison row_index — do not use it as worksheet input_row_index (common bug).
 */
function runnableRowsForGtOnlyTarget(allRows, gtOnlyRow, t) {
  const out = [];
  const pushUnique = (arr) => {
    for (const r of arr) {
      if (r && !r.gt_only && !out.some((x) => x.row_index === r.row_index)) out.push(r);
    }
  };

  const gtJ = gtOnlyRow.source_gt_row_index;
  if (typeof gtJ === 'number' && !Number.isNaN(gtJ) && gtJ >= 0) {
    const bySameGt = allRows.filter(
      (r) => r && !r.gt_only && typeof r.source_gt_row_index === 'number' && r.source_gt_row_index === gtJ
    );
    pushUnique(bySameGt);
  }

  const synthInp = gtOnlyRow.input_row_index;
  if (typeof synthInp === 'number' && !Number.isNaN(synthInp) && synthInp >= 0) {
    pushUnique(runnableRowsWithInputIndex(allRows, synthInp));
  }

  const wantKey = stableRowInputKey(gtOnlyRow.row_input);
  if (wantKey) {
    const byPrompt = allRows.filter(
      (r) => r && !r.gt_only && stableRowInputKey(r.row_input) === wantKey
    );
    pushUnique(byPrompt);
  }

  /* Unpaired GT: no runnable shares source_gt_row_index; try score-failing runs (same sheet often has ≥1 unmatched run). */
  if (out.length === 0) {
    pushUnique(allRows.filter((r) => r && !r.gt_only && r.matched === false));
  }

  /* Last resort: any runnable row so Verify/Finetune can run (e.g. single-input workflow, inference lost input_row_index). */
  if (out.length === 0) {
    pushUnique(allRows.filter((r) => r && !r.gt_only));
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

/** 0-based GT row on the saved comparison row (`source_gt_row_index`, set when Score rows are built). */
function comparisonRowReferenceGtIndex(compRow) {
  if (!compRow || typeof compRow !== 'object') return -1;
  const j = compRow.source_gt_row_index;
  if (typeof j === 'number' && !Number.isNaN(j) && j >= 0) return Math.floor(j);
  return -1;
}

/** Greedy pairing result: run `row_index` → GT index (array is sized by Score pairing, not by expanded row count). */
function lookupPairedGtIndex(runToGt, runI) {
  if (!Array.isArray(runToGt) || typeof runI !== 'number' || runI < 0 || runI >= runToGt.length) return -1;
  const j = runToGt[runI];
  return typeof j === 'number' && j >= 0 ? j : -1;
}

/**
 * GT表行（0-based，已排序）：**仅**由卡片目标 Score 行上的 `source_gt_row_index` 汇总，与 Review 调试表头
 * 「Ground truth表 #（卡片引用）」**同一集合**，一行不能少、不能靠配对子集替代。
 */
function gtRowIndicesFromCardTargets(comparisonRows, targetComparisonRowIndices) {
  const rows = Array.isArray(comparisonRows) ? comparisonRows : [];
  const seenT = new Set();
  const idx0 = new Set();
  for (const x of targetComparisonRowIndices || []) {
    const n = Number(x);
    if (Number.isNaN(n) || n < 0 || seenT.has(n)) continue;
    seenT.add(n);
    const row = rows.find((r) => Number(r?.row_index) === n) || null;
    const j = comparisonRowReferenceGtIndex(row);
    if (j >= 0) idx0.add(j);
  }
  return [...idx0].sort((a, b) => a - b);
}

/**
 * When every comparison row is gt_only (no paired model line), still allow Verify/Finetune: run inference from
 * row_input and score vs GT; baseline “had no extractable model output”.
 */
function syntheticRunnableFromGtOnlyRow(gtOnlyRow) {
  if (!gtOnlyRow || !gtOnlyRow.gt_only) return null;
  const ri = gtOnlyRow.row_index;
  if (typeof ri !== 'number' || Number.isNaN(ri)) return null;
  return {
    ...gtOnlyRow,
    gt_only: false,
    synthetic_empty_baseline: true,
  };
}

/**
 * Resolve each target t to seed runnable rows (same as before), then optionally **input-close**: include every runnable
 * comparison row that shares the same worksheet input (`input_row_index`) or the same `row_input` key (1 input → N outputs). If no row matches t as row_index, t is treated as input_row_index (worksheet 0-based).
 *
 * @param {{ expandInputClosure?: boolean }} [options] If `expandInputClosure === false`, only **seed** rows are returned (e.g. Review “Verify this card” must not re-run every line for the same input). Default `true` (Finetune metrics / legacy).
 */
export function expandTargetsToRunnableComparisonRows(comparisonRows, orderedTargets, options = {}) {
  const expandInputClosure = options.expandInputClosure !== false;
  const rows = Array.isArray(comparisonRows) ? comparisonRows : [];
  const byRowIndex = new Map();
  for (const r of rows) {
    if (r && typeof r.row_index === 'number' && !Number.isNaN(r.row_index)) {
      byRowIndex.set(r.row_index, r);
    }
  }

  const seedRows = [];
  const seenSeed = new Set();

  function addSeed(r) {
    if (!r || r.gt_only) return;
    const ri = r.row_index;
    if (typeof ri !== 'number' || Number.isNaN(ri)) return;
    if (seenSeed.has(ri)) return;
    seenSeed.add(ri);
    seedRows.push(r);
  }

  for (const t of orderedTargets) {
    const direct = byRowIndex.get(t);

    if (direct && !direct.gt_only) {
      addSeed(direct);
      continue;
    }

    /* row_index t may be a synthetic gt_only row — resolve before treating t as plain input_row_index. */
    if (direct && direct.gt_only) {
      const resolved = runnableRowsForGtOnlyTarget(rows, direct, t);
      if (resolved.length > 0) {
        for (const r of resolved) addSeed(r);
        continue;
      }
      const syn = syntheticRunnableFromGtOnlyRow(direct);
      if (syn) {
        addSeed(syn);
        continue;
      }
      const st = scoreTableNumberLabel(rows, t);
      const stPart = st != null ? ` (Score table #${st})` : '';
      return {
        error:
          `Cannot resolve target ${t}: comparison row_index ${t}${stPart} is ground-truth only (no model output). ` +
          `Need a runnable row with model output; none shares this row’s ground truth pairing, worksheet input_row_index, or row_input. ` +
          `Often caused by unpaired ground-truth rows or one input → multiple outputs with mismatched indices.`,
      };
    }

    const byInput = runnableRowsWithInputIndex(rows, t);
    if (byInput.length > 0) {
      for (const r of byInput) addSeed(r);
      continue;
    }

    return {
      error:
        `Cannot resolve target ${t}: no runnable row with row_index ${t} or input_row_index ${t}.`,
    };
  }

  let closureRows;
  if (expandInputClosure) {
    closureRows = expandInputClosureFromSeedRows(rows, seedRows);
    const seenRi = new Set(
      closureRows.map((r) => r.row_index).filter((x) => typeof x === 'number' && !Number.isNaN(x)),
    );
    for (const s of seedRows) {
      const ri = s && s.row_index;
      if (typeof ri !== 'number' || Number.isNaN(ri) || seenRi.has(ri)) continue;
      closureRows.push(s);
      seenRi.add(ri);
    }
  } else {
    closureRows = seedRows.slice();
  }
  closureRows.sort((a, b) => (a.row_index || 0) - (b.row_index || 0));
  return { rows: closureRows };
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
 * After `/api/run` poll: validate multi-line results per slot, patch into saved `runResults`, re-pair like Score.
 * @returns {Promise<{ ok: true, runToGt: number[], patchedRunResults: unknown[], freshPerExpanded: unknown[], freshBySlot: unknown[][] } | { ok: false, detail: string, aborted?: boolean }>}
 */
async function verifyMiniRunWithGreedyPairing({
  fresh,
  runRows,
  expandedRows,
  expandedRowToRunIdx,
  runResults,
  runWsSafe,
  gtSafe,
  outputFields,
  inputRoot,
  outputRoot,
  apiBase,
  signal,
}) {
  const numSlots = runRows.length;
  const freshBySlot = partitionFreshByPromptSlot(fresh, numSlots);
  for (let j = 0; j < numSlots; j++) {
    const chunk = freshBySlot[j] || [];
    const compRow = runRows[j];
    const label =
      compRow && typeof compRow.row_index === 'number'
        ? `row_index ${compRow.row_index}` + (typeof compRow.input_row_index === 'number' ? ` (Input #${compRow.input_row_index + 1})` : '')
        : String(j);
    if (chunk.length === 0) {
      return { ok: false, detail: `Model returned no output lines for ${label}.` };
    }
    for (let k = 0; k < chunk.length; k++) {
      const r = chunk[k];
      if (!r || r.error || !r.output) {
        return {
          ok: false,
          detail: `Model error on ${label} (line ${k + 1}/${chunk.length}): ${r?.error || 'empty output'}`,
        };
      }
    }
  }

  const patchRes = buildPatchedRunResultsForVerify(runResults, runRows, expandedRows, expandedRowToRunIdx, freshBySlot);
  if (patchRes.error) {
    return { ok: false, detail: patchRes.error };
  }
  const patchedRunResults = patchRes.patched;

  let embeddingMap = new Map();
  try {
    if (signal?.aborted) return { ok: false, detail: 'aborted', aborted: true };
    const validForEmb = patchedRunResults.filter((r) => isValidRunOutputForScoreRow(r, outputFields || []));
    embeddingMap = await prefetchEmbeddingCosineMap(apiBase, {
      root: scoreBundleRootsForEmbeddingWalk(inputRoot, outputRoot),
      results: validForEmb.length ? validForEmb : patchedRunResults,
      outputFields: outputFields || [],
      runWs: runWsSafe,
      gtContent: gtSafe,
      getRunValue: (runResult, outputKey, _runRowIndex, ws, of) => getRunValue(runResult, outputKey, ws, of),
      getGtValue,
    });
  } catch (_) {
    embeddingMap = new Map();
  }

  if (signal?.aborted) return { ok: false, detail: 'aborted', aborted: true };

  const validDedupedResults = patchedRunResults.filter((r) => isValidRunOutputForScoreRow(r, outputFields || []));

  const resultsByIndexForVerify = new Map();
  patchedRunResults.forEach((res) => {
    if (res && typeof res.row_index === 'number') resultsByIndexForVerify.set(res.row_index, res);
  });

  const ruleMatchesRowForPairing = (rule, runRowIndex, gtRowIndex, resultsByIndex, runWs, ofs, gtContent) =>
    ruleMatchesRow(rule, runRowIndex, gtRowIndex, resultsByIndex, runWs, ofs, gtContent, embeddingMap);

  const getRunValueForPairingBand = (rr, ok, rowIdx, ws, of) => {
    if (ok === '#' || ok === '[#]') return toCompareStr(rowIdx);
    return getRunValue(rr, ok, ws, of);
  };

  const { runToGt } = computeGreedyRunToGtPairing({
    inputRoot,
    outputRoot,
    results: validDedupedResults,
    runWs: runWsSafe,
    gtContent: gtSafe,
    outputFields: outputFields || [],
    ruleMatchesRow: ruleMatchesRowForPairing,
    getRunValue: getRunValueForPairingBand,
  });

  const freshPerExpanded = expandedRows.map((er, i) => {
    const j = expandedRowToRunIdx[i];
    const slot = freshBySlot[j] || [];
    const band = bandRunResultsForSlot(runResults, runRows, j, expandedRows, expandedRowToRunIdx);
    const pos = band.findIndex((b) => b && b.row_index === er.row_index);
    return pos >= 0 && slot[pos] ? slot[pos] : null;
  });

  return {
    ok: true,
    runToGt,
    patchedRunResults,
    freshPerExpanded,
    freshBySlot,
    embeddingMap,
    resultsByIndexForVerify,
  };
}

const VERIFY_MATCH_TYPE_LABELS = { exact: 'String match', numeric: 'Numeric equality' };

function isModelFacingOutputKeyForVerify(key) {
  const k = String(key || '').trim();
  if (!k || k === '#' || k === '[#]') return false;
  if (k.startsWith('[') && k.endsWith(']') && k.length >= 2) return false;
  return true;
}

function formatScoreRuleSummaryLine(rule) {
  if (!rule || rule.type !== 'rule') return '';
  const outKey = String(rule.outputKey || '').trim();
  const cols = (rule.gtColumns || []).map((c) => String(c).trim()).filter(Boolean);
  const gtPart = cols.length ? cols.join(' | ') : '—';
  const mt = migrateLegacyMatchType(rule.matchType);
  let label = VERIFY_MATCH_TYPE_LABELS[mt] || rule.matchType || 'String match';
  if (mt === 'exact') {
    const fl = getMatchFlags(rule);
    if (fl.embeddingSimilarity) {
      label += ' · Semantic';
    } else if (fl.semanticAlign) {
      label += ' · Fuzzy text';
    } else {
      const normParts = [];
      if (fl.contains) normParts.push('Contains');
      if (fl.ignoreCase) normParts.push('Ignore case');
      if (fl.ignoreSymbols) normParts.push('Ignore symbols');
      if (fl.ignoreWhitespace) normParts.push('Ignore whitespace');
      if (normParts.length) label += ` (${normParts.join(', ')})`;
    }
  } else if (mt === 'numeric') {
    const fl = getMatchFlags(rule);
    if (fl.numericMode === 'abs') label += ` (abs ε≤${fl.numericAbsEpsilon})`;
    else if (fl.numericMode === 'rel') label += ` (rel≤${fl.numericRelEpsilon})`;
    else if (fl.numericMode === 'decimals') label += ` (${fl.numericDecimalPlaces} dp)`;
  }
  return `${outKey} ← GT 列「${gtPart}」：${label}`;
}

function collectOutputRuleSummaryLines(outputRoot) {
  const leaves = flattenScoreRules(outputRoot || emptyScoreRuleGroup());
  return leaves
    .filter((r) => r && r.type === 'rule' && isModelFacingOutputKeyForVerify(r.outputKey))
    .map((r) => formatScoreRuleSummaryLine(r));
}

/**
 * Shared: expand targets, POST /api/run, poll, greedy pairing vs GT.
 * @param {{ expandInputClosure?: boolean, inspectIdPrefix?: string }} opts
 */
async function suggestionVerifyMiniRunPipeline(opts) {
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
    expandInputClosure = true,
    inspectIdPrefix = 'verify',
  } = opts;

  if (!credentialId || !outputSchema || !Array.isArray(outputSchema.fields) || outputSchema.fields.length === 0) {
    return { ok: false, detail: 'Missing credential or output schema.' };
  }

  let inputRoot;
  let outputRoot;
  try {
    const bundle = parseVerifyScoreBundle(scoreMappingJson);
    inputRoot = bundle.inputRoot;
    outputRoot = bundle.outputRoot;
  } catch (_) {
    return { ok: false, detail: 'Invalid score mapping.' };
  }

  const runWsSafe = runWs && typeof runWs === 'object' ? { headers: runWs.headers || [], rows: runWs.rows || [] } : { headers: [], rows: [] };
  const gtSafe = gtContent && typeof gtContent === 'object' ? { headers: gtContent.headers || [], rows: gtContent.rows || [] } : { headers: [], rows: [] };

  const templateText = sectionsToVerifyTemplate(testSections);

  const seenT = new Set();
  const orderedTargets = [];
  for (const x of targetComparisonRowIndices || []) {
    const n = Number(x);
    if (Number.isNaN(n) || n < 0) continue;
    if (seenT.has(n)) continue;
    seenT.add(n);
    orderedTargets.push(n);
  }
  if (orderedTargets.length === 0) return { ok: false, detail: 'No target comparison rows for metrics.' };

  const expanded = expandTargetsToRunnableComparisonRows(comparisonRows, orderedTargets, {
    expandInputClosure,
  });
  if (expanded.error) {
    return { ok: false, detail: expanded.error };
  }
  const expandedRows = expanded.rows;
  if (!expandedRows.length) {
    return { ok: false, detail: 'No runnable comparison rows for metrics.' };
  }

  const { runRows, expandedRowToRunIdx } = planVerifyMiniRuns(expandedRows);
  const prompts = runRows.map((row) => substitutePromptPlaceholders(templateText, row.row_input || {}));

  const base = String(apiBase).replace(/\/$/, '');
  let runId;
  try {
    const inspectRunId = `${inspectIdPrefix}_${Date.now()}_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 14)}`;
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

  const fresh = markEmptyOutputAsError(polled.results || []);

  const paired = await verifyMiniRunWithGreedyPairing({
    fresh,
    runRows,
    expandedRows,
    expandedRowToRunIdx,
    runResults,
    runWsSafe,
    gtSafe,
    outputFields,
    inputRoot,
    outputRoot,
    apiBase,
    signal,
  });

  if (!paired.ok) {
    if (paired.aborted) {
      return { ok: false, detail: 'aborted', aborted: true };
    }
    return { ok: false, detail: paired.detail || 'Mini-run metrics pairing failed.' };
  }

  return {
    ok: true,
    expandedRows,
    runRows,
    expandedRowToRunIdx,
    runWsSafe,
    gtSafe,
    inputRoot,
    outputRoot,
    comparisonRows: Array.isArray(comparisonRows) ? comparisonRows : [],
    orderedTargets,
    prompts,
    outputFields: outputFields || [],
    paired,
  };
}

/**
 * Mini-run + greedy pairing: per-row pass rate for Finetune / metrics.
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

  const pipe = await suggestionVerifyMiniRunPipeline({
    apiBase,
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
    expandInputClosure: true,
    inspectIdPrefix: 'metrics',
  });

  if (!pipe.ok) {
    return { ok: false, detail: pipe.detail, aborted: pipe.aborted };
  }

  const { expandedRows, runWsSafe, gtSafe, inputRoot, outputRoot, outputFields: ofs, paired } = pipe;
  const { runToGt, embeddingMap, resultsByIndexForVerify } = paired;

  let passed = 0;
  const n = expandedRows.length;
  for (let i = 0; i < expandedRows.length; i++) {
    const compRow = expandedRows[i];
    const compIdx = compRow.row_index;
    const j = lookupPairedGtIndex(runToGt, typeof compIdx === 'number' ? compIdx : -1);
    if (j < 0) continue;
    if (
      verifyPairIsFullScoreMatch(
        inputRoot,
        outputRoot,
        compIdx,
        j,
        resultsByIndexForVerify,
        runWsSafe,
        ofs,
        gtSafe,
        embeddingMap,
      )
    ) {
      passed += 1;
    }
  }

  const allPass = passed === n;
  return { ok: true, passRate: n ? passed / n : 0, passed, total: n, allPass };
}

/**
 * Full verify for Review Debug UI: same mini-run as metrics, returns Output→GT rules, GT rows, and per-line model output + rule checks.
 * Prompt = `testSections` (caller builds: original + **only** current card applied).
 * @param {{ expandInputClosure?: boolean }} [opts]
 */
export async function runSuggestionVerifyDebug(opts) {
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
    expandInputClosure = true,
  } = opts;

  const pipe = await suggestionVerifyMiniRunPipeline({
    apiBase,
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
    expandInputClosure,
    inspectIdPrefix: 'verify_debug',
  });

  if (!pipe.ok) {
    return { ok: false, detail: pipe.detail, aborted: pipe.aborted };
  }

  const {
    expandedRows,
    runWsSafe,
    gtSafe,
    inputRoot,
    outputRoot,
    comparisonRows: compRowsAll,
    orderedTargets,
    prompts,
    outputFields: ofs,
    paired,
  } = pipe;

  const { runToGt, embeddingMap, resultsByIndexForVerify, freshPerExpanded } = paired;

  const outputRuleSummaries = collectOutputRuleSummaryLines(outputRoot);

  const gtOrder = gtRowIndicesFromCardTargets(compRowsAll, orderedTargets);
  const gtHeaders = gtSafe.headers || [];
  const gtTableRows = gtOrder.map((j) => (gtSafe.rows && gtSafe.rows[j] ? gtSafe.rows[j] : []));

  const expandedResults = [];
  for (let i = 0; i < expandedRows.length; i++) {
    const compRow = expandedRows[i];
    const runI = compRow.row_index;
    const fr = freshPerExpanded[i];
    const res = typeof runI === 'number' ? resultsByIndexForVerify.get(runI) : null;
    const pairedGtJ = lookupPairedGtIndex(runToGt, typeof runI === 'number' ? runI : -1);
    const refGtJ = comparisonRowReferenceGtIndex(compRow);
    const evalGtJ = pairedGtJ >= 0 ? pairedGtJ : refGtJ;

    const st = scoreTableNumberLabel(compRowsAll, runI);
    const scoreLabel = st != null ? `#${st}` : `(row_index ${runI})`;
    const inputLabel =
      typeof compRow.input_row_index === 'number' && !Number.isNaN(compRow.input_row_index) && compRow.input_row_index >= 0
        ? `#${compRow.input_row_index + 1}`
        : '—';
    let gtLabel = '—';
    if (pairedGtJ >= 0) gtLabel = `#${pairedGtJ + 1}（配对）`;
    else if (refGtJ >= 0) gtLabel = `#${refGtJ + 1}（Score 行引用）`;

    const outLeaves = flattenScoreRules(outputRoot || emptyScoreRuleGroup()).filter(
      (r) => r && r.type === 'rule' && isModelFacingOutputKeyForVerify(r.outputKey),
    );
    const outputRules = outLeaves.map((rule) => ({
      outputKey: String(rule.outputKey || ''),
      summary: formatScoreRuleSummaryLine(rule),
      runValue: res ? getRunValue(res, rule.outputKey, runWsSafe, ofs) : '',
      gtValues: evalGtJ >= 0 ? (rule.gtColumns || []).map((col) => getGtValue(gtSafe, evalGtJ, col)) : [],
      pass:
        evalGtJ >= 0 &&
        ruleMatchesRow(rule, runI, evalGtJ, resultsByIndexForVerify, runWsSafe, ofs, gtSafe, embeddingMap),
    }));

    const inputTreePass =
      evalGtJ >= 0 &&
      treeMatchesPairFull(inputRoot, runI, evalGtJ, resultsByIndexForVerify, runWsSafe, ofs, gtSafe, embeddingMap);
    const outputTreePass =
      outLeaves.length === 0 ||
      (evalGtJ >= 0 &&
        treeMatchesPairFull(outputRoot, runI, evalGtJ, resultsByIndexForVerify, runWsSafe, ofs, gtSafe, embeddingMap));
    const fullMatch =
      pairedGtJ >= 0 &&
      verifyPairIsFullScoreMatch(
        inputRoot,
        outputRoot,
        runI,
        pairedGtJ,
        resultsByIndexForVerify,
        runWsSafe,
        ofs,
        gtSafe,
        embeddingMap,
      );

    expandedResults.push({
      scoreLabel,
      inputLabel,
      gtLabel,
      runRowIndex: runI,
      gtRowIndex: evalGtJ,
      freshOutput: fr && fr.output && typeof fr.output === 'object' ? fr.output : null,
      modelError: fr && fr.error ? String(fr.error) : null,
      inputTreePass,
      outputTreePass,
      fullMatch,
      outputRules,
    });
  }

  return {
    ok: true,
    outputRuleSummaries,
    gtTable: { headers: gtHeaders, rowIndicesOneBased: gtOrder.map((j) => j + 1), rows: gtTableRows },
    expandedResults,
    promptsSent: prompts.slice(),
  };
}
