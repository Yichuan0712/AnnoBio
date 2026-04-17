/**
 * Review suggestion mini-run + Score pairing: build prompt from **accepted** working sections (`testSections`).
 * Resolve targets → comparison rows → **one `/api/run` prompt per distinct worksheet input** (multiple inputs =
 * multiple prompts in one POST); collect **all** output lines per input, then the same greedy **Input→GT + Output→GT**
 * pairing and rules as Score (`computeGreedyRunToGtPairing`).
 *
 * **Does not read or merge `run_results` from the original Run** — only comparison rows, GT, run worksheet, and schema
 * from the project. Used by Finetune metrics and Run+Score row-check.
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
function pairIsFullScoreMatch(
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
function parseMiniRunScoreBundle(scoreMappingJson) {
  const raw = parseScoreMappingRaw(scoreMappingJson);
  const { inputRoot, outputRoot } = parseScoreMappingBundle(raw);
  return {
    inputRoot: inputRoot && typeof inputRoot === 'object' ? inputRoot : emptyScoreRuleGroup(),
    outputRoot: outputRoot && typeof outputRoot === 'object' ? outputRoot : emptyScoreRuleGroup(),
  };
}

/**
 * Group `/api/run` merged results by mini-run prompt slot (same order as `runRows` / `prompts`).
 * The Run API normally sets `input_row_index` to the **prompt index** i ∈ [0, numSlots). If rows use **worksheet**
 * `input_row_index` instead, fall back to matching `runRows[slot].input_row_index`.
 * Multiple lines per prompt share the same `input_row_index` and are all kept, sorted by `row_index`.
 */
function partitionFreshByPromptSlot(fresh, runRows) {
  const numSlots = runRows && runRows.length ? runRows.length : 0;
  const bySlot = Array.from({ length: Math.max(0, numSlots) }, () => []);
  const wsToSlot = new Map();
  for (let j = 0; j < numSlots; j++) {
    const rep = runRows[j];
    const wi =
      rep && typeof rep.input_row_index === 'number' && !Number.isNaN(rep.input_row_index) && rep.input_row_index >= 0
        ? rep.input_row_index
        : null;
    if (wi != null && !wsToSlot.has(wi)) wsToSlot.set(wi, j);
  }
  for (const row of fresh || []) {
    if (!row) continue;
    const raw = typeof row.input_row_index === 'number' && !Number.isNaN(row.input_row_index) ? row.input_row_index : null;
    if (raw == null) continue;
    let slot = null;
    if (raw >= 0 && raw < numSlots) {
      slot = raw;
    } else if (wsToSlot.has(raw)) {
      slot = wsToSlot.get(raw);
    }
    if (slot == null || slot < 0 || slot >= numSlots) continue;
    bySlot[slot].push(row);
  }
  for (const arr of bySlot) {
    arr.sort((a, b) => (a.row_index ?? 0) - (b.row_index ?? 0));
  }
  return bySlot;
}

/**
 * Sorted unique comparison `row_index` values for prompt slot `slotJ` (1 prompt → N Score lines).
 */
function comparisonRowIndicesForPromptSlot(expandedRows, expandedRowToRunIdx, slotJ) {
  const set = new Set();
  for (let i = 0; i < expandedRows.length; i++) {
    if (expandedRowToRunIdx[i] !== slotJ) continue;
    const er = expandedRows[i];
    const ri = er && typeof er.row_index === 'number' && !Number.isNaN(er.row_index) ? er.row_index : null;
    if (ri != null) set.add(ri);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Build the run-result list used for row-check / Finetune metrics: **only** this mini-run’s outputs.
 * For each worksheet input: map API lines to expanded comparison `row_index` in order (first line → first target, …).
 * If the model returns **more** lines than expanded targets, **every extra line is kept** with its API `row_index`
 * or a generated unique index so greedy GT pairing sees all outputs. Fewer API lines than targets → empty output for missing targets.
 */
function buildFreshRunResultsForMiniRun(runRows, expandedRows, expandedRowToRunIdx, freshBySlot) {
  const miniRunResults = [];
  const globalUsedRowIdx = new Set();
  let maxRowIdx = -1;
  const nSlots = runRows.length;
  for (let j = 0; j < nSlots; j++) {
    const chunk = freshBySlot[j] || [];
    const targets = comparisonRowIndicesForPromptSlot(expandedRows, expandedRowToRunIdx, j);
    const rep = runRows[j];
    const inLab =
      rep && typeof rep.input_row_index === 'number' && !Number.isNaN(rep.input_row_index)
        ? `worksheet Input #${rep.input_row_index + 1}`
        : `prompt slot ${j + 1}`;

    if (targets.length === 0) {
      return { error: `${inLab}: no expanded comparison rows for this input (internal mini-run planning error).` };
    }

    /* Worksheet input row (same as Score comparison row), not the API prompt-slot index. */
    const inpWorksheet =
      rep && typeof rep.input_row_index === 'number' && !Number.isNaN(rep.input_row_index) && rep.input_row_index >= 0
        ? rep.input_row_index
        : 0;

    for (let k = 0; k < targets.length; k++) {
      const runRowIdx = targets[k];
      globalUsedRowIdx.add(runRowIdx);
      maxRowIdx = Math.max(maxRowIdx, runRowIdx);
      const fr = chunk[k];
      const outObj =
        fr && fr.output && typeof fr.output === 'object' && !fr.error ? { ...fr.output } : {};
      miniRunResults.push({
        row_index: runRowIdx,
        input_row_index: inpWorksheet,
        output: outObj,
        error: undefined,
      });
    }

    for (let k = targets.length; k < chunk.length; k++) {
      const fr = chunk[k];
      const outObj =
        fr && fr.output && typeof fr.output === 'object' && !fr.error ? { ...fr.output } : {};
      let runRowIdx =
        fr && typeof fr.row_index === 'number' && !Number.isNaN(fr.row_index) ? fr.row_index : null;
      if (runRowIdx == null || globalUsedRowIdx.has(runRowIdx)) {
        maxRowIdx += 1;
        while (globalUsedRowIdx.has(maxRowIdx)) maxRowIdx += 1;
        runRowIdx = maxRowIdx;
      }
      globalUsedRowIdx.add(runRowIdx);
      maxRowIdx = Math.max(maxRowIdx, runRowIdx);
      miniRunResults.push({
        row_index: runRowIdx,
        input_row_index: inpWorksheet,
        output: outObj,
        error: undefined,
      });
    }
  }
  return { miniRunResults };
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

function sectionsToPromptTemplate(testSections) {
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
 * Stable identity for input-closed row-check / Finetune (aligns with backend `_input_identity_key`).
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
function planMiniRunPromptSlots(expandedRows) {
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

  /* Last resort: any runnable row so row-check / Finetune can run (e.g. single-input workflow, inference lost input_row_index). */
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

/** Greedy pairing result: run `row_index` → GT index (array is sized by Score pairing, not by expanded row count). */
function lookupPairedGtIndex(runToGt, runI) {
  if (!Array.isArray(runToGt) || typeof runI !== 'number' || runI < 0 || runI >= runToGt.length) return -1;
  const j = runToGt[runI];
  return typeof j === 'number' && j >= 0 ? j : -1;
}

/**
 * When every comparison row is gt_only (no paired model line), still allow row-check / Finetune: run inference from
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
 * @param {{ expandInputClosure?: boolean }} [options] If `expandInputClosure === false`, only **seed** rows are returned (narrow target set). Default `true` (Finetune metrics / row-check).
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
 * After `/api/run` poll: build run rows **only** from mini-run outputs, then greedy pairing vs GT and rule checks (same as Score).
 * @returns {Promise<{ ok: true, runToGt: number[], miniRunResults: unknown[], freshPerExpanded: unknown[], freshBySlot: unknown[][] } | { ok: false, detail: string, aborted?: boolean }>}
 */
async function miniRunWithGreedyPairing({
  fresh,
  runRows,
  expandedRows,
  expandedRowToRunIdx,
  runWsSafe,
  gtSafe,
  outputFields,
  inputRoot,
  outputRoot,
  apiBase,
  signal,
}) {
  const freshBySlot = partitionFreshByPromptSlot(fresh, runRows);
  for (let j = 0; j < runRows.length; j++) {
    const chunk = freshBySlot[j] || [];
    const targets = comparisonRowIndicesForPromptSlot(expandedRows, expandedRowToRunIdx, j);
    const compRow = runRows[j];
    const label =
      compRow && typeof compRow.row_index === 'number'
        ? `row_index ${compRow.row_index}` + (typeof compRow.input_row_index === 'number' ? ` (Input #${compRow.input_row_index + 1})` : '')
        : String(j);
    if (targets.length === 0) {
      return { ok: false, detail: `${label}: no expanded comparison rows for this worksheet input.` };
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

  const built = buildFreshRunResultsForMiniRun(runRows, expandedRows, expandedRowToRunIdx, freshBySlot);
  if (built.error) {
    return { ok: false, detail: built.error };
  }
  const miniRunResults = built.miniRunResults;

  let embeddingMap = new Map();
  try {
    if (signal?.aborted) return { ok: false, detail: 'aborted', aborted: true };
    const validForEmb = miniRunResults.filter((r) => isValidRunOutputForScoreRow(r, outputFields || []));
    embeddingMap = await prefetchEmbeddingCosineMap(apiBase, {
      root: scoreBundleRootsForEmbeddingWalk(inputRoot, outputRoot),
      results: validForEmb.length ? validForEmb : miniRunResults,
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

  const validDedupedResults = miniRunResults.filter((r) => isValidRunOutputForScoreRow(r, outputFields || []));

  const resultsByRowIndex = new Map();
  miniRunResults.forEach((res) => {
    if (res && typeof res.row_index === 'number') resultsByRowIndex.set(res.row_index, res);
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
    const targets = comparisonRowIndicesForPromptSlot(expandedRows, expandedRowToRunIdx, j);
    const ri = er && typeof er.row_index === 'number' && !Number.isNaN(er.row_index) ? er.row_index : null;
    const pos = ri != null ? targets.indexOf(ri) : -1;
    if (pos < 0 || pos >= slot.length) return null;
    return slot[pos] || null;
  });

  return {
    ok: true,
    runToGt,
    miniRunResults,
    freshPerExpanded,
    freshBySlot,
    embeddingMap,
    resultsByRowIndex,
  };
}

/**
 * Shared: expand targets, POST /api/run, poll, greedy pairing vs GT.
 * @param {{ expandInputClosure?: boolean, inspectIdPrefix?: string }} opts
 */
async function suggestionRowCheckMiniRunPipeline(opts) {
  const {
    apiBase = 'http://localhost:8000',
    credentialId,
    testSections,
    targetComparisonRowIndices,
    comparisonRows,
    outputFields,
    outputSchema,
    scoreMappingJson,
    runWs,
    gtContent,
    signal,
    expandInputClosure = true,
    inspectIdPrefix = 'minirun',
  } = opts;

  if (!credentialId || !outputSchema || !Array.isArray(outputSchema.fields) || outputSchema.fields.length === 0) {
    return { ok: false, detail: 'Missing credential or output schema.' };
  }

  let inputRoot;
  let outputRoot;
  try {
    const bundle = parseMiniRunScoreBundle(scoreMappingJson);
    inputRoot = bundle.inputRoot;
    outputRoot = bundle.outputRoot;
  } catch (_) {
    return { ok: false, detail: 'Invalid score mapping.' };
  }

  const runWsSafe = runWs && typeof runWs === 'object' ? { headers: runWs.headers || [], rows: runWs.rows || [] } : { headers: [], rows: [] };
  const gtSafe = gtContent && typeof gtContent === 'object' ? { headers: gtContent.headers || [], rows: gtContent.rows || [] } : { headers: [], rows: [] };

  const templateText = sectionsToPromptTemplate(testSections);

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

  const { runRows, expandedRowToRunIdx } = planMiniRunPromptSlots(expandedRows);
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

  const paired = await miniRunWithGreedyPairing({
    fresh,
    runRows,
    expandedRows,
    expandedRowToRunIdx,
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
    outputFields,
    outputSchema,
    scoreMappingJson,
    runWs,
    gtContent,
    signal,
  } = opts;

  const pipe = await suggestionRowCheckMiniRunPipeline({
    apiBase,
    credentialId,
    testSections,
    targetComparisonRowIndices,
    comparisonRows,
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

  const { runWsSafe, gtSafe, inputRoot, outputRoot, outputFields: ofs, paired } = pipe;
  const { runToGt, embeddingMap, resultsByRowIndex, miniRunResults } = paired;

  const rowIndices = [
    ...new Set(
      (miniRunResults || [])
        .filter((r) => r && typeof r.row_index === 'number' && !Number.isNaN(r.row_index))
        .map((r) => r.row_index),
    ),
  ].sort((a, b) => a - b);

  let passed = 0;
  const n = rowIndices.length;
  for (const compIdx of rowIndices) {
    const j = lookupPairedGtIndex(runToGt, compIdx);
    if (j < 0) continue;
    if (
      pairIsFullScoreMatch(
        inputRoot,
        outputRoot,
        compIdx,
        j,
        resultsByRowIndex,
        runWsSafe,
        ofs,
        gtSafe,
        embeddingMap,
      )
    ) {
      passed += 1;
    }
  }

  const allPass = n > 0 && passed === n;
  return { ok: true, passRate: n ? passed / n : 0, passed, total: n, allPass };
}
