/**
 * Workflow canvas (node-based editor surface).
 * Listens for workflow:add-prompt-node to add prompt nodes.
 * Edges use stable node ids and a type field for future extensibility.
 */

import { openPromptDetailModal, extractInputFieldsFromSections } from './promptDetailModal.js';
import { openRunDetailModal, deriveOutputFields } from './runDetailModal.js';
import { mergeResumeResults, embedInputRow, countCompletedInputRows, markEmptyOutputAsError } from './runResumeUtils.js';
import { normalizeUnicodeDashesForDisplay } from './displayTextNormalize.js';
import { openReviewDetailModal } from './reviewDetailModal.js';
import { reviewStreamSavedNeedsRowVerifyPhase } from './reviewWorkingSections.js';
import {
  allocNextReviewSuggestionId,
  ensureReviewResultIds,
  ensureSuggestionObjectId,
  normalizeSuggestionIdsToDisplayOrder,
  parseNumericSuggestionId,
  syncReviewSuggestionSeqNext,
} from './reviewSuggestionIds.js';
import {
  openScoreDetailModal,
  openReviewSelectionPreviewModal,
  getScoreExportData,
  canonicalizeMatchFlags,
  getMatchFlags,
  legacyMatchTypeWasContains,
  migrateLegacyMatchType,
  normalizeForMatch,
  numericPairMatches,
  stringsMatchContains,
  stringsMatchSemanticAlign,
  prefetchEmbeddingCosineMap,
  embeddingPairMatches,
  isValidRunOutputForScoreRow,
} from './scoreDetailModal.js';
import { openSamplerDetailModal } from './samplerDetailModal.js';
import { openDatasetDetailModal } from './datasetDetailModal.js';
import { showAlert, showConfirm } from './alertModal.js';

/** Same backend as Run/Review (embeddings API). */
const SCORE_BACKEND_BASE = 'http://localhost:8000';

/** Run node may not have dataset.runCredentialId until user opens Run modal; fall back to Settings default. */
async function resolveRunCredentialId(runNode) {
  let id = (runNode?.dataset?.runCredentialId || '').trim();
  if (id) return id;
  try {
    const res = await fetch(`${SCORE_BACKEND_BASE}/api/settings`);
    const s = res.ok ? await res.json() : null;
    id = s && s.default_run_credential_id ? String(s.default_run_credential_id).trim() : '';
  } catch (_) {}
  return id;
}

const MIN_CONTENT_PADDING = 200;
/**
 * Review bar: LLM stream uses 0..PIPELINE_DONE (~quick); Run+Score row checks use the rest (usually most wall time).
 * Must match reviewDetailModal REVIEW_PROGRESS_PIPELINE_DONE / CHECK_SPAN.
 */
const REVIEW_PROGRESS_PIPELINE_DONE = 30;
const REVIEW_STREAM_PLAN_PCT = 4;
const REVIEW_STREAM_DIAG_END_PCT = 24;
const REVIEW_STREAM_SUGGESTIONS_PCT = 26;
const REVIEW_STREAM_DATA_PCT = 28;
/** Minimum canvas content size (width, height) so there is plenty of room to work and zoom. */
const MIN_CANVAS_WIDTH = 4000;
const MIN_CANVAS_HEIGHT = 2600;

/** Edge type for prompt �?prompt (e.g. "new version" link). Add more types here as needed. */
const EDGE_TYPE_PROMPT_TO_PROMPT = 'prompt-to-prompt';
/** Edge type for source dataset → sampler. */
const EDGE_TYPE_DATASET_TO_SAMPLER = 'dataset-to-sampler';
/** Edge type for sampler → dataset (sampled output). */
const EDGE_TYPE_SAMPLER_TO_DATASET = 'sampler-to-dataset';
/** Edge type for dataset → dataset (e.g. "version of" link). */
const EDGE_TYPE_DATASET_TO_DATASET = 'dataset-to-dataset';
/** Edge type for prompt → run (run/test this prompt). */
const EDGE_TYPE_PROMPT_TO_RUN = 'prompt-to-run';
/** Edge type for run → score (compare result with ground truth). */
const EDGE_TYPE_RUN_TO_SCORE = 'run-to-score';
/** Edge type for score → prompt review (LLM analyzes results and suggests prompt changes). */
const EDGE_TYPE_SCORE_TO_PROMPT_REVIEW = 'score-to-prompt-review';
const EDGE_TYPE_PROMPT_REVIEW_TO_PROMPT = 'prompt-review-to-prompt';

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

/** Normalize score mapping to rules: [ { outputKey, gtColumns, matchType, matchFlags } ]. Migrate from old groups/flat format. */
function normalizeScoreMappingToRules(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const first = arr[0];
  if (first && typeof first === 'object' && Array.isArray(first.gtColumns)) {
    return arr.map((r) => {
      const raw = r.matchType || 'exact';
      const baseF = r.matchFlags && typeof r.matchFlags === 'object' ? r.matchFlags : {};
      return {
        outputKey: r.outputKey || '',
        gtColumns: Array.isArray(r.gtColumns) ? r.gtColumns.filter(Boolean) : [],
        matchType: migrateLegacyMatchType(raw),
        matchFlags: {
          ...DEFAULT_SCORE_MATCH_FLAGS,
          ...baseF,
          contains: !!(baseF.contains || legacyMatchTypeWasContains(raw)),
        },
      };
    }).filter((r) => r.outputKey || r.gtColumns.length > 0);
  }
  const pairs = [];
  if (first && first.outputKey !== undefined && !first.rules) {
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

function ensureScoreGroupOps(data, children) {
  const n = (children || []).length;
  const len = Math.max(0, n - 1);
  if (Array.isArray(data.ops) && data.ops.length >= len) {
    return data.ops.slice(0, len).map((o) => o === 'OR' ? 'OR' : 'AND');
  }
  const defaultOp = data.op === 'OR' ? 'OR' : 'AND';
  return Array(len).fill(defaultOp);
}

/** Parse scoreMapping to tree root (group). Legacy array -> root with AND group of rules. */
function parseScoreMappingToTree(data) {
  if (!data) return { type: 'group', ops: [], children: [] };
  if (data.type === 'group' && Array.isArray(data.children)) {
    const children = data.children.map((c) => (c && c.type === 'group')
      ? normalizeScoreGroupChild(c)
      : normalizeScoreChild(c));
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

function normalizeScoreGroupChild(c) {
  const children = (c.children || []).map((ch) => (ch && ch.type === 'group') ? normalizeScoreGroupChild(ch) : normalizeScoreChild(ch));
  const ops = ensureScoreGroupOps(c, children);
  return { type: 'group', ops, children };
}

function normalizeScoreChild(c) {
  if (!c || c.type === 'rule') {
    const rawMt = (c && c.matchType) || 'exact';
    const f = { ...DEFAULT_SCORE_MATCH_FLAGS, ...((c && c.matchFlags && typeof c.matchFlags === 'object') ? c.matchFlags : {}) };
    if (legacyMatchTypeWasContains(rawMt)) f.contains = true;
    const leaf = {
      type: 'rule',
      outputKey: (c && c.outputKey) || '',
      gtColumns: Array.isArray(c && c.gtColumns) ? c.gtColumns.filter(Boolean) : [],
      matchType: migrateLegacyMatchType(rawMt),
      matchFlags: canonicalizeMatchFlags(f),
    };
    if (c && c.rowGroupKey === true) leaf.rowGroupKey = true;
    return leaf;
  }
  return normalizeScoreGroupChild(c);
}

/** Flatten tree to array of rules (depth-first) for expected display. */
function flattenScoreTreeToRules(node) {
  if (!node) return [];
  if (node.type === 'rule') return [node];
  if (node.type === 'group' && Array.isArray(node.children)) {
    return node.children.flatMap(flattenScoreTreeToRules);
  }
  return [];
}

/** Evaluate tree node for run row i vs GT row j. */
function evaluateScoreNode(node, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent, getRunValue, getGtValue) {
  if (!node) return false;
  if (node.type === 'rule') {
    const runResult = resultsByIndex.get(runRowIndex) || null;
    const runVal = getRunValue(runResult, node.outputKey, runRowIndex, runWs, outputFields);
    const gtVals = (node.gtColumns || []).map((col) => getGtValue(gtContent, gtRowIndex, col));
    return gtVals.some((g) => g === runVal);
  }
  if (node.type === 'group' && Array.isArray(node.children)) {
    if (node.children.length === 0) return false;
    const ops = node.ops || Array(Math.max(0, node.children.length - 1)).fill('AND');
    let r = evaluateScoreNode(node.children[0], runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent, getRunValue, getGtValue);
    for (let i = 1; i < node.children.length; i++) {
      const next = evaluateScoreNode(node.children[i], runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent, getRunValue, getGtValue);
      r = (ops[i - 1] === 'OR') ? (r || next) : (r && next);
    }
    return r;
  }
  return false;
}

/** Build comparison rows for Review API: same logic as score detail (getRunValue, getGtValue, computeMatchPerRow). */
async function buildReviewComparisonRows(scoreNode, runNode, datasetContentByNodeId, promptSections = []) {
  const toCompareStr = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) return v.map((x) => toCompareStr(x)).join(', ').trim();
    return String(v).trim();
  };
  const getRunValue = (runResult, outputKey, runWs, outputFields) => {
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
  };
  const getGtValue = (gtContent, rowIndex, columnName) => {
    const headers = gtContent.headers || [];
    const rows = gtContent.rows || [];
    const colIdx = headers.findIndex((h) => String(h).trim() === String(columnName).trim());
    if (colIdx >= 0 && rows[rowIndex]) return toCompareStr(rows[rowIndex][colIdx]);
    return '';
  };
  let reviewEmbeddingCosineMap = new Map();
  const ruleMatchesRow = (rule, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent) => {
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
      return gtValsRaw.some((g) => embeddingPairMatches(runValRaw, g, reviewEmbeddingCosineMap));
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
  };
  const countMatchingRules = (root, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent) => {
    const rules = flattenScoreTreeToRules(root);
    return rules.filter((rule) => ruleMatchesRow(rule, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent)).length;
  };
  let scoreRoot = { type: 'group', op: 'AND', children: [] };
  try {
    const raw = scoreNode.dataset.scoreMapping || '[]';
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    scoreRoot = parseScoreMappingToTree(data);
  } catch (_) {}
  let results = [];
  let outputFields = [];
  try {
    results = JSON.parse(runNode.dataset.runResults || '[]');
    outputFields = JSON.parse(runNode.dataset.runOutputFields || '[]');
  } catch (_) {}
  const gtId = (scoreNode.dataset.scoreGroundTruthId || '').trim();
  const runWsId = (runNode.dataset.runWorkingSetId || '').trim();
  const runWs = runWsId ? datasetContentByNodeId.get(runWsId) : null;
  const gtContent = gtId ? datasetContentByNodeId.get(gtId) : null;
  const runWsSafe = runWs ? { headers: runWs.headers || [], rows: runWs.rows || [] } : { headers: [], rows: [] };
  const gtSafe = gtContent ? { headers: gtContent.headers || [], rows: gtContent.rows || [] } : { headers: [], rows: [] };
  let runInputToColumn = {};
  try {
    const rawMap = runNode.dataset.runInputToColumn || '{}';
    const parsedMap = JSON.parse(rawMap);
    if (parsedMap && typeof parsedMap === 'object') runInputToColumn = parsedMap;
  } catch (_) {}
  const promptPlaceholderNames = extractInputFieldsFromSections(Array.isArray(promptSections) ? promptSections : []);
  const hdrsForPrompt = runWsSafe.headers || [];

  /** Keys = `{placeholder}` names in prompt section order; values = substituted cell text (Run node mapping). */
  function rowInputAsPromptPlaceholders(inpIdx) {
    const wsRow = runWsSafe.rows && runWsSafe.rows[inpIdx] ? runWsSafe.rows[inpIdx] : [];
    const out = {};
    for (const name of promptPlaceholderNames) {
      const col = String(runInputToColumn[name] || '').trim();
      if (!col) {
        out[name] = '';
        continue;
      }
      const colIdx = hdrsForPrompt.findIndex((h) => String(h).trim() === col);
      const val = colIdx >= 0 ? (wsRow[colIdx] ?? '') : '';
      out[name] = val === null || val === undefined ? '' : String(val);
    }
    return out;
  }

  let excludedFromScoring = {};
  try {
    excludedFromScoring = JSON.parse(scoreNode.dataset.scoreRowExcludedFromScoring || '{}');
  } catch (_) {}

  const rulesFlat = flattenScoreTreeToRules(scoreRoot);
  const gtColsUsed = [];
  const outputKeysUsed = [];
  for (const rule of rulesFlat) {
    for (const c of (rule.gtColumns || [])) {
      if (c && !gtColsUsed.includes(c)) gtColsUsed.push(c);
    }
    const k = (rule.outputKey || '').trim();
    if (k && !outputKeysUsed.includes(k)) outputKeysUsed.push(k);
  }
  const dedupeGt = (gtC) => {
    if (!gtColsUsed.length) return gtC;
    const rows = gtC.rows || [];
    const seen = new Set();
    const dedupRows = [];
    for (let i = 0; i < rows.length; i++) {
      const key = JSON.stringify(gtColsUsed.map((col) => getGtValue(gtC, i, col)));
      if (seen.has(key)) continue;
      seen.add(key);
      dedupRows.push(rows[i]);
    }
    return { ...gtC, rows: dedupRows };
  };
  const dedupeRunResults = (resList) => {
    if (!outputKeysUsed.length) return resList || [];
    const seen = new Set();
    const out = [];
    for (const res of resList || []) {
      const key = JSON.stringify([res.row_index, ...outputKeysUsed.map((k) => getRunValue(res, k, runWsSafe, outputFields))]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(res);
    }
    return out;
  };

  const gtDeduped = dedupeGt(gtSafe);
  const gtRows = gtDeduped.rows || [];
  const resultsForScore = (results || []).filter((r) => r);
  const dedupedResults = dedupeRunResults(resultsForScore);
  const validDedupedResults = dedupedResults.filter((r) => isValidRunOutputForScoreRow(r, outputFields));

  function emptyRowInputPlaceholders() {
    const out = {};
    for (const name of promptPlaceholderNames) out[name] = '';
    return out;
  }
  const inputIndicesWithValidRun = new Set(
    validDedupedResults.map((r) =>
      typeof r.input_row_index === 'number' && !Number.isNaN(r.input_row_index) ? r.input_row_index : r.row_index,
    ),
  );

  const resultsByIndex = new Map();
  (validDedupedResults || []).forEach((res) => { resultsByIndex.set(res.row_index, res); });

  const nonErrorResults = validDedupedResults || [];
  const runRowIndices = [...new Set(nonErrorResults.map((r) => r.row_index))];
  reviewEmbeddingCosineMap = new Map();
  if (rulesFlat.some((r) => getMatchFlags(r).embeddingSimilarity)) {
    try {
      reviewEmbeddingCosineMap = await prefetchEmbeddingCosineMap(SCORE_BACKEND_BASE, {
        root: scoreRoot,
        results: validDedupedResults,
        outputFields,
        runWs: runWsSafe,
        gtContent: gtDeduped,
        getRunValue: (rr, ok, _rowIdx, ws, of) => getRunValue(rr, ok, ws, of),
        getGtValue,
      });
    } catch (_) {
      reviewEmbeddingCosineMap = new Map();
    }
  }
  const inputRowCount = runWsSafe?.rows?.length ?? 0;
  const gtCount = gtRows.length;
  const maxRunRowIndex = runRowIndices.length ? Math.max(...runRowIndices) : -1;
  const runCount = Math.max(inputRowCount, maxRunRowIndex + 1);
  const runToGt = new Array(Math.max(runCount, gtCount)).fill(-1);
  const gtUsed = new Array(gtCount).fill(false);
  const pairs = [];
  for (const i of runRowIndices) {
    for (let j = 0; j < gtCount; j++) {
      const scoreN = countMatchingRules(scoreRoot, i, j, resultsByIndex, runWsSafe, outputFields, gtDeduped);
      if (scoreN > 0) pairs.push({ i, j, score: scoreN });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  for (const { i, j } of pairs) {
    if (runToGt[i] >= 0 || gtUsed[j]) continue;
    runToGt[i] = j;
    gtUsed[j] = true;
  }

  const gtToRun = new Array(gtCount).fill(-1);
  for (let ii = 0; ii < runToGt.length; ii++) {
    const jj = runToGt[ii];
    if (jj >= 0) gtToRun[jj] = ii;
  }

  function evaluateNodeLocal(node, runRowIndex, gtRowIndex) {
    if (!node) return false;
    if (node.type === 'rule') {
      return ruleMatchesRow(node, runRowIndex, gtRowIndex, resultsByIndex, runWsSafe, outputFields, gtDeduped);
    }
    if (node.type === 'group' && Array.isArray(node.children)) {
      if (node.children.length === 0) return false;
      const ops = node.ops || Array(Math.max(0, node.children.length - 1)).fill('AND');
      let rr = evaluateNodeLocal(node.children[0], runRowIndex, gtRowIndex);
      for (let c = 1; c < node.children.length; c++) {
        const next = evaluateNodeLocal(node.children[c], runRowIndex, gtRowIndex);
        rr = (ops[c - 1] === 'OR') ? (rr || next) : (rr && next);
      }
      return rr;
    }
    return false;
  }

  /** Same descriptor order as scoreDetailModal.renderResults (unfiltered); 1-based # column when the table is not filtered. */
  const scoreDetailDescriptors = [];
  for (let j = 0; j < gtCount; j++) {
    if (gtToRun[j] >= 0) scoreDetailDescriptors.push({ type: 'gt', j });
  }
  for (let j = 0; j < gtCount; j++) {
    if (gtToRun[j] < 0) scoreDetailDescriptors.push({ type: 'gt', j });
  }
  for (const i of runRowIndices) {
    const paired = i < runToGt.length && runToGt[i] >= 0;
    if (paired) continue;
    let matchesAnyGt = false;
    for (let jj = 0; jj < gtCount; jj++) {
      if (evaluateNodeLocal(scoreRoot, i, jj)) {
        matchesAnyGt = true;
        break;
      }
    }
    if (!matchesAnyGt) scoreDetailDescriptors.push({ type: 'runOnly', i });
  }
  const rowGroupRule = rulesFlat.find((r) => r && r.rowGroupKey === true) || null;
  function gtOneToManyGroupKeyReview(j) {
    if (!rowGroupRule) return '';
    const cols = (rowGroupRule.gtColumns || []).filter(Boolean);
    if (cols.length === 0) return `\0${j}`;
    return cols.map((c) => String(getGtValue(gtDeduped, j, c) ?? '')).join('\u0001');
  }
  if (rowGroupRule) {
    const gtDesc = scoreDetailDescriptors.filter((d) => d.type === 'gt');
    const runOnlyDesc = scoreDetailDescriptors.filter((d) => d.type === 'runOnly');
    gtDesc.sort((a, b) => {
      const ka = gtOneToManyGroupKeyReview(a.j);
      const kb = gtOneToManyGroupKeyReview(b.j);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a.j - b.j;
    });
    scoreDetailDescriptors.length = 0;
    scoreDetailDescriptors.push(...gtDesc, ...runOnlyDesc);
  }
  const scoreTableRowByKey = new Map();
  scoreDetailDescriptors.forEach((d, idx) => {
    const n = idx + 1;
    if (d.type === 'gt') scoreTableRowByKey.set(`gt:${d.j}`, n);
    else scoreTableRowByKey.set(`runOnly:${d.i}`, n);
  });

  const MATCH_TYPE_LABELS = { exact: 'String match', numeric: 'Numeric equality' };
  /** Output keys the model actually sees in JSON output (exclude #[], [worksheet col], etc.). */
  function isModelFacingOutputKey(key) {
    const k = String(key || '').trim();
    if (!k || k === '#' || k === '[#]') return false;
    if (k.startsWith('[') && k.endsWith(']') && k.length >= 2) return false;
    return true;
  }
  /** Expected string + comparison_types for ground-truth row index j (same as Score detail). */
  function expectedAndComparisonTypesForGt(gtIdxForRules) {
    const expectedParts = [];
    const comparisonTypes = [];
    if (gtIdxForRules < 0) {
      return { expected: '—', comparison_types: null, ground_truth_output: {} };
    }
    const groundTruthOutput = {};
    for (const rule of rulesFlat) {
      const outKey = String(rule.outputKey || '').trim();
      if (!isModelFacingOutputKey(outKey)) continue;
      const gtVals = (rule.gtColumns || []).map((col) => getGtValue(gtDeduped, gtIdxForRules, col));
      groundTruthOutput[outKey] = gtVals.length === 1
        ? (gtVals[0] == null ? '' : String(gtVals[0]))
        : gtVals.map((x) => (x == null ? '' : String(x))).join(' | ');
      expectedParts.push(`${outKey}: ${gtVals.join(' | ') || '—'}`);
      const mt = migrateLegacyMatchType(rule.matchType);
      let label = MATCH_TYPE_LABELS[mt] || rule.matchType || 'String match';
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
      comparisonTypes.push(`${outKey}: ${label}`);
    }
    return {
      expected: expectedParts.length ? expectedParts.join('; ') : '—',
      comparison_types: comparisonTypes.length ? comparisonTypes : null,
      ground_truth_output: groundTruthOutput,
    };
  }

  const rows = [];
  let outRowIdx = 0;
  for (const r of validDedupedResults) {
    const runR = r.row_index;
    const inpIdx = r.input_row_index ?? runR;
    const jPaired = runR >= 0 && runR < runToGt.length ? runToGt[runR] : -1;
    const modalKey = jPaired >= 0 ? String(jPaired) : `run:${runR}`;
    if (excludedFromScoring[modalKey]) continue;

    const runOutput = r?.output && typeof r.output === 'object' ? r.output : {};
    const gtIdxForRules = jPaired >= 0 ? jPaired : -1;
    const { expected, comparison_types, ground_truth_output } = expectedAndComparisonTypesForGt(gtIdxForRules);
    const isFullMatch = gtIdxForRules >= 0 && evaluateNodeLocal(scoreRoot, runR, gtIdxForRules);
    const row_input = inputIndicesWithValidRun.has(inpIdx) ? rowInputAsPromptPlaceholders(inpIdx) : emptyRowInputPlaceholders();
    const runRowIdx =
      typeof r.row_index === 'number' && !Number.isNaN(r.row_index) ? r.row_index : outRowIdx;
    const score_table_row = jPaired >= 0
      ? (scoreTableRowByKey.get(`gt:${jPaired}`) ?? null)
      : (scoreTableRowByKey.get(`runOnly:${runR}`) ?? null);
    rows.push({
      row_index: runRowIdx,
      input_row_index: inpIdx,
      matched: isFullMatch,
      run_output: runOutput,
      expected,
      comparison_types,
      ground_truth_output,
      row_input,
      gt_only: false,
      source_gt_row_index: jPaired >= 0 ? jPaired : null,
      score_table_row,
    });
    outRowIdx++;
  }

  /**
   * 0-based worksheet input index for an unpaired GT row, or null if unknown.
   * Tiered inference so real same-input rows still group (Phase 1 `in:{iri}`), without the old
   * “first run substring hit” that merged unrelated rows (e.g. #1 + #6).
   */
  function findInputRowIndexForUnpairedGt(gtJ) {
    const gtCells = [];
    for (const col of gtColsUsed) {
      const v = String(getGtValue(gtDeduped, gtJ, col) || '').trim();
      if (v) gtCells.push(v);
    }
    if (gtCells.length === 0) return null;

    const wsRows = runWsSafe.rows || [];
    const cellsForRow = (ii) => (wsRows[ii] || []).map((c) => String(c ?? '').trim());

    const exactHitsForRow = (ii) => {
      const cells = cellsForRow(ii);
      return gtCells.reduce((n, gv) => n + (cells.some((c) => c === gv) ? 1 : 0), 0);
    };

    /** Unique row index with highest score, or null if tie or all zero. */
    const uniqueArgmaxRows = (scoreFn) => {
      let best = -1;
      const scores = [];
      for (let ii = 0; ii < wsRows.length; ii++) {
        const s = scoreFn(ii);
        scores.push(s);
        if (s > best) best = s;
      }
      if (best <= 0) return null;
      const winners = [];
      for (let ii = 0; ii < wsRows.length; ii++) {
        if (scores[ii] === best) winners.push(ii);
      }
      return winners.length === 1 ? winners[0] : null;
    };

    const exactWinner = uniqueArgmaxRows(exactHitsForRow);
    if (exactWinner != null) return exactWinner;

    const MIN_SUB = 4;
    const relaxedHit = (gv, cell) => {
      if (gv === cell) return true;
      if (gv.length < MIN_SUB && cell.length < MIN_SUB) return false;
      if (gv.length >= MIN_SUB && cell.includes(gv)) return true;
      if (cell.length >= MIN_SUB && gv.includes(cell)) return true;
      return false;
    };
    const relaxedHitsForRow = (ii) => {
      const cells = cellsForRow(ii);
      return gtCells.reduce((n, gv) => n + (cells.some((c) => relaxedHit(gv, c)) ? 1 : 0), 0);
    };
    const relaxedWinner = uniqueArgmaxRows(relaxedHitsForRow);
    if (relaxedWinner != null) return relaxedWinner;

    const valueSetForInput = (inp) => {
      const set = new Set();
      const wsRow = wsRows[inp] || [];
      for (const c of wsRow) {
        const t = String(c ?? '').trim();
        if (t) set.add(t);
      }
      for (const r of validDedupedResults) {
        const rInp = typeof r.input_row_index === 'number' && !Number.isNaN(r.input_row_index) ? r.input_row_index : r.row_index;
        if (rInp !== inp) continue;
        for (const k of outputKeysUsed) {
          const rv = getRunValue(r, k, runWsSafe, outputFields);
          const t = String(rv ?? '').trim();
          if (t) set.add(t);
        }
      }
      return set;
    };

    const distinctInps = [
      ...new Set(
        validDedupedResults.map((r) =>
          typeof r.input_row_index === 'number' && !Number.isNaN(r.input_row_index) ? r.input_row_index : r.row_index,
        ),
      ),
    ];
    const allExactInBundle = (inp) => {
      const set = valueSetForInput(inp);
      return gtCells.every((gv) => set.has(gv));
    };
    const bundleMatches = distinctInps.filter((inp) => allExactInBundle(inp));
    if (bundleMatches.length === 1) return bundleMatches[0];

    return null;
  }

  /* GT rows with no paired run: synthetic comparison rows. Prefer same `input_row_index` as runnable rows when we can infer it. */
  let synthRow = maxRunRowIndex + 1;
  for (let j = 0; j < gtCount; j++) {
    if (gtToRun[j] >= 0) continue;
    if (excludedFromScoring[String(j)]) continue;
    const modalKey = String(j);
    const { expected, comparison_types, ground_truth_output } = expectedAndComparisonTypesForGt(j);
    const score_table_row = scoreTableRowByKey.get(`gt:${j}`) ?? null;
    const inpResolved = findInputRowIndexForUnpairedGt(j);
    const useInp = typeof inpResolved === 'number' && !Number.isNaN(inpResolved) ? inpResolved : null;
    const row_input =
      useInp != null
        ? (inputIndicesWithValidRun.has(useInp) ? rowInputAsPromptPlaceholders(useInp) : emptyRowInputPlaceholders())
        : null;
    rows.push({
      row_index: synthRow,
      input_row_index: useInp,
      matched: false,
      run_output: {},
      expected,
      comparison_types,
      ground_truth_output,
      row_input,
      gt_only: true,
      source_gt_row_index: j,
      score_table_row,
    });
    synthRow += 1;
  }

  return rows;
}

/** Invisible stroke width for edge hit area (px). */
const EDGE_HIT_STROKE_WIDTH = 16;

/** Horizontal gap when placing a new node to the right of its parent (source → sampler, sampler → dataset, duplicate prompt). */
const NEW_NODE_OFFSET = 40;

function generateNodeId() {
  return 'n_' + Date.now() + '_' + (Math.random() * 1e9 | 0);
}

export function buildWorkflowCanvas(root) {
  const canvas = document.createElement('div');
  canvas.className = 'workflow-canvas';

  const scrollWrapper = document.createElement('div');
  scrollWrapper.className = 'workflow-canvas__scroll';

  const zoomOuter = document.createElement('div');
  zoomOuter.className = 'workflow-canvas__zoom-outer';

  const scaleWrapper = document.createElement('div');
  scaleWrapper.className = 'workflow-canvas__scale';

  const contentInner = document.createElement('div');
  contentInner.className = 'workflow-canvas__inner';

  const edgesLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  edgesLayer.setAttribute('class', 'workflow-canvas__edges');
  edgesLayer.setAttribute('width', '100%');
  edgesLayer.setAttribute('height', '100%');
  edgesLayer.setAttribute('preserveAspectRatio', 'none');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'workflow-arrow');
  marker.setAttribute('markerUnits', 'userSpaceOnUse');
  marker.setAttribute('markerWidth', '12');
  marker.setAttribute('markerHeight', '10');
  marker.setAttribute('refX', '11');
  marker.setAttribute('refY', '5');
  marker.setAttribute('orient', 'auto');
  const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrowPath.setAttribute('d', 'M0,0 L12,5 L0,10 Z');
  arrowPath.setAttribute('fill', 'currentColor');
  marker.appendChild(arrowPath);
  defs.appendChild(marker);

  const markerHover = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  markerHover.setAttribute('id', 'workflow-arrow-hover');
  markerHover.setAttribute('markerUnits', 'userSpaceOnUse');
  markerHover.setAttribute('markerWidth', '14');
  markerHover.setAttribute('markerHeight', '11');
  markerHover.setAttribute('refX', '13');
  markerHover.setAttribute('refY', '5.5');
  markerHover.setAttribute('orient', 'auto');
  const arrowPathHover = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrowPathHover.setAttribute('d', 'M0,0 L14,5.5 L0,11 Z');
  arrowPathHover.setAttribute('fill', 'currentColor');
  markerHover.appendChild(arrowPathHover);
  defs.appendChild(markerHover);

  edgesLayer.appendChild(defs);

  const nodesLayer = document.createElement('div');
  nodesLayer.className = 'workflow-canvas__nodes';

  contentInner.appendChild(edgesLayer);
  contentInner.appendChild(nodesLayer);
  scaleWrapper.appendChild(contentInner);
  zoomOuter.appendChild(scaleWrapper);
  scrollWrapper.appendChild(zoomOuter);
  canvas.appendChild(scrollWrapper);

  let panStartScrollLeft = 0;
  let panStartScrollTop = 0;
  let panStartClientX = 0;
  let panStartClientY = 0;

  function onPanMove(e) {
    scrollWrapper.scrollLeft = panStartScrollLeft + (panStartClientX - e.clientX);
    scrollWrapper.scrollTop = panStartScrollTop + (panStartClientY - e.clientY);
  }
  function onPanEnd() {
    scrollWrapper.classList.remove('workflow-canvas__scroll--panning');
    document.removeEventListener('pointermove', onPanMove);
    document.removeEventListener('pointerup', onPanEnd);
    document.removeEventListener('pointercancel', onPanEnd);
  }
  scrollWrapper.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.workflow-node') || e.target.closest('.workflow-canvas__zoom-toolbar')) return;
    e.preventDefault();
    panStartScrollLeft = scrollWrapper.scrollLeft;
    panStartScrollTop = scrollWrapper.scrollTop;
    panStartClientX = e.clientX;
    panStartClientY = e.clientY;
    scrollWrapper.classList.add('workflow-canvas__scroll--panning');
    document.addEventListener('pointermove', onPanMove);
    document.addEventListener('pointerup', onPanEnd, { once: true });
    document.addEventListener('pointercancel', onPanEnd, { once: true });
  });

  let zoomLevel = 1;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 2;
  const ZOOM_STEP = 0.05;

  function applyZoom() {
    scaleWrapper.style.transformOrigin = '0 0';
    scaleWrapper.style.transform = `scale(${zoomLevel})`;
  }

  let nodeCount = 0;
  const STAGGER = 36;
  /** @type {{ fromId: string, toId: string, type: string }[]} */
  let connections = [];

  /** @type {Map<string, { headers: string[], rows: string[][] }>} nodeId -> dataset content (imported or sampled) */
  const datasetContentByNodeId = new Map();

  /** Pending Run jobs: nodeId -> runId. Poll backend and update Run node when done. */
  const pendingRuns = new Map();
  /** Pending Review jobs: reviewNodeId -> reviewId. Poll backend and update Review node when done (like Run). */
  const pendingReviews = new Map();
  /** Review nodes currently streaming (UI progress); used for delete-confirm "cancel job" messaging. */
  const pendingReviewNodeIds = new Set();
  function registerPendingReview(nodeId, reviewId) {
    if (nodeId && reviewId) pendingReviews.set(nodeId, reviewId);
  }
  function unregisterPendingReview(nodeId) {
    if (nodeId) pendingReviews.delete(nodeId);
  }
  const RUN_API_BASE = 'http://localhost:8000';
  function registerPendingRun(nodeId, runId) {
    if (nodeId && runId) pendingRuns.set(nodeId, runId);
  }
  function unregisterPendingRun(nodeId) {
    if (nodeId) pendingRuns.delete(nodeId);
  }
  function setRunNodeProgress(node, completed, total) {
    const bar = node?.querySelector('.workflow-node__run-progress');
    if (!bar) return;
    const pct = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    bar.style.width = pct + '%';
    bar.setAttribute('aria-valuenow', String(pct));
  }
  function setReviewNodeProgress(node, percent) {
    const bar = node?.querySelector('.workflow-node__review-progress');
    if (!bar) return;
    const pct = Math.min(100, Math.max(0, Math.round(percent)));
    bar.style.width = pct + '%';
    bar.setAttribute('aria-valuenow', String(pct));
    if (node) node.dataset.reviewProgress = String(pct);
  }
  /** Score在画布上为本地即时算分：仅当选好 Ground truth、至少一条有效 rule，且上游 Run 已有结果时显示100%。 */
  function setScoreNodeProgress(node, percent) {
    const bar = node?.querySelector('.workflow-node__score-progress');
    if (!bar) return;
    const pct = Math.min(100, Math.max(0, Math.round(percent)));
    bar.style.width = pct + '%';
    bar.setAttribute('aria-valuenow', String(pct));
    if (node) node.dataset.scoreProgress = String(pct);
  }
  function scoreNodeHasCompleteRules(scoreNode) {
    if (!scoreNode) return false;
    try {
      const raw = scoreNode.dataset.scoreMapping || '[]';
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const tree = parseScoreMappingToTree(data);
      const rules = flattenScoreTreeToRules(tree);
      return rules.some((r) => (r.outputKey || '').trim() && Array.isArray(r.gtColumns) && r.gtColumns.some((c) => String(c || '').trim()));
    } catch (_) {
      return false;
    }
  }
  function scoreNodeIsReadyForScoring(scoreNode) {
    const gtId = (scoreNode?.dataset?.scoreGroundTruthId || '').trim();
    return !!gtId && scoreNodeHasCompleteRules(scoreNode);
  }
  function syncScoreNodeProgressFromUpstreamRun(scoreNode) {
    if (!scoreNode || !scoreNode.classList.contains('workflow-node--score')) return;
    const runEdge = connections.find((c) => c.toId === scoreNode.dataset.nodeId && c.type === EDGE_TYPE_RUN_TO_SCORE);
    if (!runEdge) {
      setScoreNodeProgress(scoreNode, 0);
      return;
    }
    const runNode = getNodeById(runEdge.fromId);
    if (!runNode) {
      setScoreNodeProgress(scoreNode, 0);
      return;
    }
    let runResults = [];
    try {
      runResults = JSON.parse(runNode.dataset.runResults || '[]');
    } catch (_) {}
    const hasResults = Array.isArray(runResults) && runResults.length > 0;
    const ready = scoreNodeIsReadyForScoring(scoreNode);
    setScoreNodeProgress(scoreNode, hasResults && ready ? 100 : 0);
  }
  function syncScoreNodesProgressForRunId(runNodeId, results) {
    if (!runNodeId) return;
    const hasResults = Array.isArray(results) && results.length > 0;
    for (const c of connections) {
      if (c.fromId !== runNodeId || c.type !== EDGE_TYPE_RUN_TO_SCORE) continue;
      const scoreNode = getNodeById(c.toId);
      if (!scoreNode || !scoreNode.classList.contains('workflow-node--score')) continue;
      const ready = scoreNodeIsReadyForScoring(scoreNode);
      setScoreNodeProgress(scoreNode, hasResults && ready ? 100 : 0);
    }
  }

  /** When true, run poll is stopped (app closing); do not start new API calls. */
  let runPollStopped = false;

  /** Poll only runs that are already in pendingRuns (started in this session or restored when user opened Run modal). No by-node loop here; restore is done in runDetailModal when modal opens. */
  const runPollIntervalId = setInterval(async () => {
    if (runPollStopped) return;
    for (const [nodeId, runId] of pendingRuns) {
      if (runPollStopped) return;
      try {
        const res = await fetch(`${RUN_API_BASE}/api/run/result/${runId}`);
        const data = await res.json().catch(() => ({}));
        const node = getNodeById(nodeId);
        if (!node) {
          pendingRuns.delete(nodeId);
          continue;
        }
        if (res.status === 202) {
          let partialResults = data.results || [];
          let outputFields = data.output_fields;
          const startIndex = node.dataset.runResumeStartIndex != null ? parseInt(node.dataset.runResumeStartIndex, 10) : 0;
          const totalRows = node.dataset.runResumeTotalRows != null ? parseInt(node.dataset.runResumeTotalRows, 10) : (data.total || 0);
          let content = null;
          try {
            const raw = node.dataset.runInputContent;
            if (raw) content = JSON.parse(raw);
          } catch (_) {}
          if (startIndex > 0 && node.dataset.runResumeExistingResults) {
            try {
              const existing = JSON.parse(node.dataset.runResumeExistingResults);
              partialResults = mergeResumeResults(existing, partialResults, startIndex, content);
            } catch (_) {
              partialResults = mergeResumeResults([], partialResults, startIndex, content);
            }
          } else {
            partialResults = embedInputRow(partialResults, content);
          }
          partialResults = markEmptyOutputAsError(partialResults);
          if (!Array.isArray(outputFields) || outputFields.length === 0) {
            const promptEdge = connections.find((c) => c.toId === node.dataset.nodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN);
            const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
            let schemaFields = [];
            if (promptNode) {
              try {
                const raw = promptNode.dataset.promptOutputFormat || '[]';
                schemaFields = JSON.parse(raw);
                if (!Array.isArray(schemaFields)) schemaFields = [];
              } catch (_) {}
            }
            outputFields = deriveOutputFields(partialResults || [], schemaFields);
          }
          if (Array.isArray(partialResults) && Array.isArray(outputFields)) {
            const inputRowsCompleted = (startIndex || 0) + (data.completed ?? 0);
            const total = totalRows || data.total || inputRowsCompleted;
            setRunNodeProgress(node, inputRowsCompleted, total);
            if (node.style.borderColor) {
              const bar = node.querySelector('.workflow-node__run-progress');
              if (bar && !bar.style.background) bar.style.background = node.style.borderColor;
            }
            node.dataset.runResults = JSON.stringify(partialResults);
            document.dispatchEvent(new CustomEvent('workflow:run-results-updated', { detail: { nodeId, results: partialResults, outputFields, isComplete: false } }));
            document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
          }
          continue;
        }
        if (res.status !== 200) continue;
        if (data.status === 'done' || data.status === 'cancelled') {
          let results = data.results || [];
          let outputFields = data.output_fields || [];
          const startIndex = node.dataset.runResumeStartIndex != null ? parseInt(node.dataset.runResumeStartIndex, 10) : 0;
          const totalRows = node.dataset.runResumeTotalRows != null ? parseInt(node.dataset.runResumeTotalRows, 10) : (data.total || 0);
          let content = null;
          try {
            const raw = node.dataset.runInputContent;
            if (raw) content = JSON.parse(raw);
          } catch (_) {}
          if (startIndex > 0 && node.dataset.runResumeExistingResults) {
            try {
              const existing = JSON.parse(node.dataset.runResumeExistingResults);
              results = mergeResumeResults(existing, results, startIndex, content);
            } catch (_) {
              results = mergeResumeResults([], results, startIndex, content);
            }
            delete node.dataset.runResumeStartIndex;
            delete node.dataset.runResumeExistingResults;
            delete node.dataset.runResumeTotalRows;
          } else {
            results = embedInputRow(results, content);
          }
          results = markEmptyOutputAsError(results);
          if (!Array.isArray(outputFields) || outputFields.length === 0) {
            const promptEdge = connections.find((c) => c.toId === node.dataset.nodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN);
            const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
            let schemaFields = [];
            if (promptNode) {
              try {
                const raw = promptNode.dataset.promptOutputFormat || '[]';
                schemaFields = JSON.parse(raw);
                if (!Array.isArray(schemaFields)) schemaFields = [];
              } catch (_) {}
            }
            outputFields = deriveOutputFields(results, schemaFields);
          }
          const total = totalRows || data.total || countCompletedInputRows(results);
          const inputRowsCompleted = (data.status === 'done' || data.status === 'cancelled') ? total : (totalRows ?? data.completed ?? data.total ?? countCompletedInputRows(results));
          setRunNodeProgress(node, inputRowsCompleted, total);
          if (data.status === 'done') node.dataset.runCompleted = '1';
          if (data.status === 'done' && data.error && results.length === 0) {
            node.dataset.runResults = JSON.stringify([{ row_index: 0, output: null, error: data.error }]);
            document.dispatchEvent(new CustomEvent('workflow:run-results-updated', { detail: { nodeId, results: [{ row_index: 0, output: null, error: data.error }], outputFields: [], isComplete: true } }));
          } else {
            node.dataset.runResults = JSON.stringify(results);
            document.dispatchEvent(new CustomEvent('workflow:run-results-updated', { detail: { nodeId, results, outputFields, isComplete: true, cancelled: data.status === 'cancelled' } }));
          }
          pendingRuns.delete(nodeId);
          document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
        }
      } catch (_) {}
    }
    for (const [reviewNodeId, reviewId] of pendingReviews) {
      try {
        const res = await fetch(`${RUN_API_BASE}/api/review/result/${reviewId}`);
        const data = await res.json().catch(() => ({}));
        const node = getNodeById(reviewNodeId);
        if (!node) {
          pendingReviews.delete(reviewNodeId);
          continue;
        }
        const events = data.events || [];
        if (res.status === 202) {
          processReviewEvents(reviewNodeId, events);
          continue;
        }
        if (res.status !== 200) continue;
        processReviewEvents(reviewNodeId, events);
        if (data.error) {
          alert(data.error || 'Review failed.');
        }
        if (data.status === 'done' || data.status === 'cancelled') {
          pendingReviews.delete(reviewNodeId);
          pendingReviewNodeIds.delete(reviewNodeId);
          document.dispatchEvent(new CustomEvent('workflow:review-stream-ended', { detail: { reviewNodeId } }));
          document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
        }
      } catch (_) {}
    }
  }, 2000);

  function processReviewEvents(reviewNodeId, events) {
    const node = getNodeById(reviewNodeId);
    if (!node) return;
    let streamSaved = {};
    try {
      streamSaved = JSON.parse(node.dataset.reviewResult || '{}');
    } catch (_) {}
    const sectionsCopy = Array.isArray(streamSaved.promptSections) && streamSaved.promptSections.length > 0
      ? streamSaved.promptSections
      : [];
    streamSaved = {
      ...streamSaved,
      summary: streamSaved.summary || '',
      suggestions: streamSaved.suggestions || [],
      data_refinement: streamSaved.data_refinement || [],
      row_diagnostics: Array.isArray(streamSaved.row_diagnostics) ? streamSaved.row_diagnostics : [],
      promptSections: sectionsCopy,
      promptFullText: sectionsCopy.map((s) => `## ${(s.name || '').trim() || '(unnamed)'}\n\n${(s.content || '').trim()}`).join('\n\n'),
      workingSections: sectionsCopy.map((s) => ({ name: s.name || '', content: (s.content || '').slice() })),
      reviewProgress: streamSaved.reviewProgress || 0,
      run_results: streamSaved.run_results || [],
      comparison_rows: streamSaved.comparison_rows || [],
      /** True once all Phase‑1 diagnosis_row events are done (before clustering / suggestions). Drives Issue analysis footer. */
      diagnosisComplete: streamSaved.diagnosisComplete === true,
    };
    let diagnosisTotal = 0;
    let diagnosisDone = 0;
    for (const ev of events) {
      if (ev.type === 'error') {
        pendingReviews.delete(reviewNodeId);
        pendingReviewNodeIds.delete(reviewNodeId);
        document.dispatchEvent(new CustomEvent('workflow:review-stream-ended', { detail: { reviewNodeId } }));
        alert(ev.detail || 'Review failed.');
        return;
      }
      if (ev.type === 'plan') {
        const dt = ev.diagnosis_total != null ? Math.max(0, parseInt(ev.diagnosis_total, 10)) : 0;
        diagnosisTotal = dt;
        diagnosisDone = 0;
        streamSaved = {
          ...streamSaved,
          summary: ev.summary || '',
          suggestions: [],
          data_refinement: [],
          row_diagnostics: [],
          streamComplete: false,
          diagnosisComplete: dt === 0,
          reviewProgress: REVIEW_STREAM_PLAN_PCT,
        };
        setReviewNodeProgress(getNodeById(reviewNodeId), REVIEW_STREAM_PLAN_PCT);
      } else if (ev.type === 'diagnosis_row') {
        diagnosisDone = ev.done != null ? parseInt(ev.done, 10) : diagnosisDone + 1;
        const total = ev.total != null ? parseInt(ev.total, 10) : diagnosisTotal;
        const diagSpan = REVIEW_STREAM_DIAG_END_PCT - REVIEW_STREAM_PLAN_PCT;
        const pct =
          total > 0
            ? REVIEW_STREAM_PLAN_PCT + Math.floor((diagSpan * diagnosisDone) / total)
            : Math.min(REVIEW_STREAM_DIAG_END_PCT, REVIEW_STREAM_PLAN_PCT + diagnosisDone * 4);
        setReviewNodeProgress(getNodeById(reviewNodeId), pct);
        streamSaved.reviewProgress = pct;
        if (ev.opinion && typeof ev.opinion === 'object') {
          const rid = ev.row_index != null ? parseInt(ev.row_index, 10) : NaN;
          if (!Number.isNaN(rid)) {
            const list = Array.isArray(streamSaved.row_diagnostics) ? streamSaved.row_diagnostics.slice() : [];
            const rowIndicesRaw = Array.isArray(ev.row_indices) ? ev.row_indices : [];
            const row_indices = rowIndicesRaw.map((x) => parseInt(x, 10)).filter((x) => !Number.isNaN(x));
            const entry = {
              row_index: rid,
              row_indices: row_indices.length ? row_indices : [rid],
              card_title: String(ev.opinion.card_title || ''),
              issue_summary: String(ev.opinion.issue_summary || ''),
              rough_modification_opinion: String(ev.opinion.rough_modification_opinion || ''),
              problem_category_hint: String(ev.opinion.problem_category_hint || ''),
            };
            const idx = list.findIndex((x) => x && Number(x.row_index) === rid);
            if (idx >= 0) list[idx] = entry;
            else list.push(entry);
            list.sort((a, b) => (Number(a.row_index) || 0) - (Number(b.row_index) || 0));
            streamSaved.row_diagnostics = list;
          }
        }
        const totalForPhase1 = total > 0 ? total : diagnosisTotal;
        if (totalForPhase1 > 0 && diagnosisDone >= totalForPhase1) {
          streamSaved.diagnosisComplete = true;
        }
      } else if (ev.type === 'suggestions' && Array.isArray(ev.suggestions) && ev.suggestions.length) {
        const batch = ev.suggestions.map((s) =>
          s && typeof s === 'object'
            ? ensureSuggestionObjectId({ ...s, source: s.source || 'pipeline' }, streamSaved)
            : s
        );
        streamSaved.suggestions = (streamSaved.suggestions || []).concat(batch);
        setReviewNodeProgress(getNodeById(reviewNodeId), REVIEW_STREAM_SUGGESTIONS_PCT);
        streamSaved.reviewProgress = REVIEW_STREAM_SUGGESTIONS_PCT;
      } else if (ev.type === 'data_refinement' && Array.isArray(ev.data_refinement)) {
        streamSaved.data_refinement = ev.data_refinement.map((item) =>
          item && typeof item === 'object'
            ? ensureSuggestionObjectId({ ...item, source: item.source || 'pipeline' }, streamSaved)
            : item
        );
        setReviewNodeProgress(getNodeById(reviewNodeId), REVIEW_STREAM_DATA_PCT);
        streamSaved.reviewProgress = REVIEW_STREAM_DATA_PCT;
      } else if (ev.type === 'done') {
        const needsRowVerifyPhase = reviewStreamSavedNeedsRowVerifyPhase(streamSaved);
        const finalizePct = needsRowVerifyPhase ? REVIEW_PROGRESS_PIPELINE_DONE : 100;
        setReviewNodeProgress(getNodeById(reviewNodeId), finalizePct);
        streamSaved = {
          ...streamSaved,
          streamComplete: true,
          diagnosisComplete: true,
          reviewProgress: finalizePct,
        };
        normalizeSuggestionIdsToDisplayOrder(streamSaved);
      }
      ensureReviewResultIds(streamSaved);
      document.dispatchEvent(new CustomEvent('workflow:save-review-result', { detail: { reviewNodeId, data: streamSaved } }));
    }
  }

  /** On app close: stop polling and tell backend to cancel every pending run/review. Sync XHR so the request is sent before process exits (sendBeacon does not wait). */
  function shutdownRunPoll() {
    runPollStopped = true;
    clearInterval(runPollIntervalId);
    const runIds = Array.from(pendingRuns.values());
    for (const runId of runIds) {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${RUN_API_BASE}/api/run/cancel/${runId}`, false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send('{}');
      } catch (_) {}
    }
    const reviewIds = Array.from(pendingReviews.values());
    for (const reviewId of reviewIds) {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${RUN_API_BASE}/api/review/cancel/${reviewId}`, false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send('{}');
      } catch (_) {}
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', shutdownRunPoll);
    window.addEventListener('pagehide', shutdownRunPoll);
  }

  function getNodeList() {
    return Array.from(nodesLayer.querySelectorAll('.workflow-node--prompt'));
  }

  function getNodeById(nodeId) {
    if (!nodeId) return null;
    return nodesLayer.querySelector(`[data-node-id="${nodeId}"]`) || null;
  }

  function getOutgoingEdgesFromNode(nodeId) {
    if (!nodeId) return [];
    return connections.filter((c) => c.fromId === nodeId);
  }

  function isDatasetPickedByRunOrScore(datasetNodeId) {
    if (!datasetNodeId) return false;
    const usedByRun = Array.from(nodesLayer.querySelectorAll('.workflow-node--run')).some(
      (n) => (n.dataset.runWorkingSetId || '').trim() === datasetNodeId,
    );
    const usedByScore = Array.from(nodesLayer.querySelectorAll('.workflow-node--score')).some(
      (n) => (n.dataset.scoreGroundTruthId || '').trim() === datasetNodeId,
    );
    return usedByRun || usedByScore;
  }

  /**
   * @param {string} nodeId
   * @param {'prompt'|'sampler'|'dataset'|'run'|'score'|'promptReview'|''} kind
   * @returns {{ blocked: boolean, reason?: 'downstream'|'dataset_ref' }}
   */
  function getWorkflowNodeDeleteBlockReason(nodeId, kind) {
    if (getOutgoingEdgesFromNode(nodeId).length > 0) {
      return { blocked: true, reason: 'downstream' };
    }
    if (kind === 'dataset' && isDatasetPickedByRunOrScore(nodeId)) {
      return { blocked: true, reason: 'dataset_ref' };
    }
    return { blocked: false };
  }

  /**
   * @param {string} nodeId
   * @param {'prompt'|'sampler'|'dataset'|'run'|'score'|'promptReview'|''} kind
   * @param {() => void} doDelete
   */
  async function handleWorkflowNodeDeleteClick(nodeId, kind, doDelete) {
    const block = getWorkflowNodeDeleteBlockReason(nodeId, kind);
    if (block.blocked) {
      if (block.reason === 'downstream') {
        showAlert(
          'This node is connected to downstream node(s). Remove or disconnect those nodes first.',
          { title: 'Cannot delete node' },
        );
      } else {
        showAlert(
          'This dataset is selected by one or more Run or Score nodes. Clear the selection in those nodes before deleting.',
          { title: 'Cannot delete dataset' },
        );
      }
      return;
    }
    const runBusy = kind === 'run' && pendingRuns.has(nodeId);
    const reviewBusy =
      kind === 'promptReview' && (pendingReviews.has(nodeId) || pendingReviewNodeIds.has(nodeId));
    let msg = 'Delete this node? This cannot be undone.';
    if (runBusy || reviewBusy) {
      msg =
        'Delete this node? A job is still running on it; deleting will cancel that run or review on the server.';
    }
    const ok = await showConfirm(msg, { title: 'Delete node', confirmText: 'Delete' });
    if (!ok) return;
    doDelete();
  }

  /**
   * Generate next dataset name: SourceName SamplerName N (N increments per sampler; spaces between parts).
   * @param {string} samplerNodeId
   * @returns {string}
   */
  function findNextWorkingDatasetName(samplerNodeId) {
    const samplerNode = getNodeById(samplerNodeId);
    const sourceNode = samplerNode?.dataset?.sourceNodeId ? getNodeById(samplerNode.dataset.sourceNodeId) : null;
    const sourceName = (sourceNode?.dataset?.datasetName ?? sourceNode?.dataset?.subsetName ?? '').trim() || 'Dataset';
    const samplerName = (samplerNode?.dataset?.samplerName ?? '').trim() || 'Sample';
    const base = `${sourceName} ${samplerName}`;
    const datasetNodes = nodesLayer.querySelectorAll('.workflow-node--dataset');
    let maxN = 0;
    const prefix = base + ' ';
    for (const n of datasetNodes) {
      if (n.dataset.samplerNodeId !== samplerNodeId) continue;
      const name = (n.dataset.datasetName || n.dataset.subsetName || '').trim();
      if (!name.startsWith(prefix)) continue;
      const numStr = name.slice(prefix.length).trim();
      const num = parseInt(numStr, 10);
      if (Number.isFinite(num) && num >= 1 && String(num) === numStr) maxN = Math.max(maxN, num);
    }
    return `${base} ${maxN + 1}`;
  }

  /**
   * True if the sampler has any subset (dataset) nodes that were sampled from it.
   * @param {string} samplerNodeId
   * @returns {boolean}
   */
  function hasSampledDatasets(samplerNodeId) {
    if (!samplerNodeId) return false;
    const datasetNodes = nodesLayer.querySelectorAll('.workflow-node--dataset');
    for (const n of datasetNodes) {
      if ((n.dataset.samplerNodeId || '') === samplerNodeId) return true;
    }
    return false;
  }

  function getNodeIndex(node) {
    return getNodeList().indexOf(node);
  }

  /**
   * Check if a prompt name is already used on the canvas (case-insensitive).
   * Empty string is considered "used" so multiple empty names are not allowed.
   * @param {string} nameToCheck - name to check (will be trimmed and lowercased)
   * @param {string|null} [excludeNodeId=null] - node id to exclude (e.g. when editing that node)
   * @returns {boolean}
   */
  function isPromptNameAlreadyUsed(nameToCheck, excludeNodeId = null) {
    const normalized = (nameToCheck || '').trim().toLowerCase();
    const nodes = getNodeList();
    for (const n of nodes) {
      if (excludeNodeId && n.dataset.nodeId === excludeNodeId) continue;
      const existing = (n.dataset.promptName || '').trim().toLowerCase();
      if (existing === normalized) return true;
    }
    return false;
  }

  /**
   * Check if a working/subset dataset name is already used on the canvas (case-insensitive).
   * @param {string} nameToCheck
   * @param {string|null} [excludeNodeId=null] - node id to exclude (e.g. when editing that node)
   * @returns {boolean}
   */
  function isDatasetNameAlreadyUsed(nameToCheck, excludeNodeId = null) {
    const normalized = (nameToCheck || '').trim().toLowerCase();
    const datasetNodes = nodesLayer.querySelectorAll('.workflow-node--dataset');
    for (const n of datasetNodes) {
      if (excludeNodeId && n.dataset.nodeId === excludeNodeId) continue;
      const existing = (n.dataset.datasetName || n.dataset.subsetName || '').trim().toLowerCase();
      if (existing === normalized) return true;
    }
    return false;
  }

  /** For run-exported datasets: return baseName or "baseName Copy 1", "baseName Copy 2", … so name is unique. */
  function findUniqueDatasetExportName(baseName) {
    const base = (baseName || '').trim() || 'Dataset';
    if (!isDatasetNameAlreadyUsed(base)) return base;
    let n = 1;
    let candidate;
    do {
      candidate = `${base} Copy ${n}`;
      n++;
    } while (isDatasetNameAlreadyUsed(candidate));
    return candidate;
  }

  /**
   * Check if a sampler name is already used for the same source dataset (case-insensitive).
   * @param {string} nameToCheck
   * @param {string} sourceNodeId - source dataset node id
   * @param {string|null} [excludeNodeId=null] - sampler node id to exclude (e.g. when editing)
   * @returns {boolean}
   */
  function isSamplerNameAlreadyUsedForSource(nameToCheck, sourceNodeId, excludeNodeId = null) {
    const normalized = (nameToCheck || '').trim().toLowerCase();
    if (!normalized) return true;
    const samplerNodes = nodesLayer.querySelectorAll('.workflow-node--sampler');
    for (const n of samplerNodes) {
      if (n.dataset.sourceNodeId !== sourceNodeId) continue;
      if (excludeNodeId && n.dataset.nodeId === excludeNodeId) continue;
      const existing = (n.dataset.samplerName || '').trim().toLowerCase();
      if (existing === normalized) return true;
    }
    return false;
  }

  /**
   * Default name for a new sampler under the same source dataset: "Sample 1", "Sample 2", ...
   * @param {string} sourceNodeId - source dataset node id
   * @returns {string}
   */
  function getNextDefaultSamplerName(sourceNodeId) {
    if (!sourceNodeId) return 'Sample 1';
    let count = 0;
    nodesLayer.querySelectorAll('.workflow-node--sampler').forEach((n) => {
      if (n.dataset.sourceNodeId === sourceNodeId) count++;
    });
    return `Sample ${count + 1}`;
  }

  /**
   * Check if a run name is already used by another run under the same prompt (case-insensitive).
   * @param {string} nameToCheck
   * @param {string|null} [excludeRunNodeId=null] - run node id to exclude (the one being edited)
   * @returns {boolean}
   */
  function isRunNameAlreadyUsedForPrompt(nameToCheck, excludeRunNodeId = null) {
    const normalized = (nameToCheck || '').trim().toLowerCase();
    if (!normalized) return true;
    const promptEdge = connections.find((c) => c.toId === excludeRunNodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN);
    if (!promptEdge) return false;
    const promptNodeId = promptEdge.fromId;
    const runEdges = connections.filter((c) => c.fromId === promptNodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN);
    for (const e of runEdges) {
      if (e.toId === excludeRunNodeId) continue;
      const runNode = getNodeById(e.toId);
      const existing = (runNode?.dataset?.runName ?? runNode?.querySelector?.('.workflow-node__title')?.textContent ?? '').trim() || 'Run';
      if (existing.toLowerCase() === normalized) return true;
    }
    return false;
  }

  /**
   * Parse row spec in order; duplicates and order are preserved (e.g. "1-2 1 2" → [0,1,0,1] → row1, row2, row1, row2).
   * @param {string} text - e.g. "1 3 5-10 15"
   * @param {number} totalRows - max row count (1-based), indices > totalRows are skipped
   * @returns {number[]} 0-based indices in spec order
   */
  function parseRowSpec(text, totalRows) {
    const indices = [];
    const parts = (text || '').split(/[\s,]+/).filter(Boolean);
    for (const part of parts) {
      const dash = part.indexOf('-');
      if (dash === -1) {
        const num = parseInt(part, 10);
        if (Number.isFinite(num) && num >= 1 && num <= totalRows) indices.push(num - 1);
      } else {
        const a = parseInt(part.slice(0, dash), 10);
        const b = parseInt(part.slice(dash + 1), 10);
        if (Number.isFinite(a) && Number.isFinite(b) && a >= 1 && b >= 1) {
          const low = Math.min(a, b);
          const high = Math.min(Math.max(a, b), totalRows);
          for (let r = Math.max(1, low); r <= high; r++) indices.push(r - 1);
        }
      }
    }
    return indices;
  }

  /**
   * Sample rows from source data per sampler settings.
   * @param {string[][]} sourceRows
   * @param {number} sampleSize - row count or percentage (1-100)
   * @param {string} sampleSizeType - 'rows' | 'ratio'
   * @param {string} samplingType - 'with-replacement' | 'without-replacement'
   * @returns {string[][]}
   */
  function sampleRows(sourceRows, sampleSize, sampleSizeType, samplingType) {
    const n = sourceRows.length;
    if (n === 0) return [];
    let count = sampleSizeType === 'rows' ? Math.max(0, Math.floor(sampleSize)) : Math.max(0, Math.floor((n * sampleSize) / 100));
    count = Math.min(count, n);
    if (count === 0) return [];

    if (samplingType === 'without-replacement') {
      if (count >= n) return sourceRows.map((r) => r.slice());
      const indices = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      const selected = indices.slice(0, count).sort((a, b) => a - b);
      return selected.map((i) => sourceRows[i].slice());
    }

    const picked = [];
    for (let k = 0; k < count; k++) {
      picked.push(Math.floor(Math.random() * n));
    }
    picked.sort((a, b) => a - b);
    return picked.map((i) => sourceRows[i].slice());
  }

  /**
   * Strip trailing " (Copy N)" or " vN" from a name so we can reuse the root for next number.
   * @param {string} name
   * @returns {string}
   */
  function stripCopyOrVersionSuffix(name) {
    const s = (name || '').trim();
    const copyMatch = s.match(/^(.*)\s+\(Copy\s+\d+\)$/);
    if (copyMatch) return stripCopyOrVersionSuffix(copyMatch[1].trim());
    const versionMatch = s.match(/^(.*)\s+v(\d+)$/);
    if (versionMatch) return stripCopyOrVersionSuffix(versionMatch[1].trim());
    return s || 'Prompt';
  }

  /**
   * Strip only trailing " (Copy N)" from a name; keep version suffix like " v2".
   * Used when duplicating so "MySet v2" -> copy is "MySet v2 (Copy 1)".
   * @param {string} name
   * @returns {string}
   */
  function stripCopySuffixOnly(name) {
    const s = (name || '').trim();
    const copyMatch = s.match(/^(.*)\s+\(Copy\s+\d+\)$/);
    if (copyMatch) return stripCopySuffixOnly(copyMatch[1].trim());
    return s;
  }

  /**
   * Strip only trailing " vN" (space + v + digits) from a name.
   * Used for Add version: "MySet v2" -> "MySet", "MySet (Copy 1) v2" -> "MySet (Copy 1)".
   * @param {string} name
   * @returns {string}
   */
  function stripVersionSuffixOnly(name) {
    const s = (name || '').trim();
    const versionMatch = s.match(/^(.*)\s+v(\d+)$/);
    if (versionMatch) return versionMatch[1].trim();
    return s;
  }

  /**
   * Find a unique prompt name by appending suffix. Used for duplicate / new version.
   * Duplicate: strip only " (Copy N)" so "Name v2" -> "Name v2 (Copy 1)".
   * New version: strip only trailing " vN" so "Name v2" -> "Name v3", "Name (Copy 1)" -> "Name (Copy 1) v2".
   * Scans all prompt nodes (including current) so version number always increments.
   * @param {string} baseName - base name (e.g. from source node)
   * @param {boolean} isNewVersion - true for "Name v2", false for "Name (Copy 1)"
   * @returns {string}
   */
  function findUniquePromptName(baseName, isNewVersion) {
    if (isNewVersion) {
      const raw = (baseName || '').trim() || 'Prompt';
      const versionBase = stripVersionSuffixOnly(raw).trim() || 'Prompt';
      const nodes = getNodeList();
      let nextV = 2;
      const versionPrefix = versionBase + ' v';
      for (const n of nodes) {
        const name = (n.dataset.promptName || '').trim();
        const nBase = stripVersionSuffixOnly(name).trim();
        if (nBase !== versionBase) continue;
        if (name === versionBase) {
          nextV = Math.max(nextV, 2);
          continue;
        }
        if (!name.startsWith(versionPrefix)) continue;
        const numStr = name.slice(versionPrefix.length).trim();
        if (!/^\d+$/.test(numStr)) continue;
        const num = parseInt(numStr, 10);
        if (Number.isFinite(num) && num >= 1) nextV = Math.max(nextV, num + 1);
      }
      return `${versionBase} v${nextV}`;
    }
    const base = (stripCopySuffixOnly(baseName || '').trim() || 'Prompt');
    let n = 1;
    let candidate;
    do {
      candidate = `${base} (Copy ${n})`;
      n++;
    } while (isPromptNameAlreadyUsed(candidate));
    return candidate;
  }

  /**
   * Find a unique dataset name (same pattern as prompt: duplicate = "Name (Copy 1)", version = "Name v2").
   * Duplicate keeps version suffix so "MySet v2" -> "MySet v2 (Copy 1)"; only " (Copy N)" is stripped for the base.
   * @param {string} baseName - current subset name
   * @param {boolean} isNewVersion - true for "Name v2", false for "Name (Copy 1)" (or "Name v2 (Copy 1)")
   * @returns {string}
   */
  function findUniqueWorkingDatasetName(baseName, isNewVersion) {
    const raw = (baseName || '').trim() || 'Dataset';
    const base = isNewVersion ? (stripCopyOrVersionSuffix(raw).trim() || 'Dataset') : (stripCopySuffixOnly(raw) || 'Dataset');
    let n = isNewVersion ? 2 : 1;
    let candidate;
    do {
      candidate = isNewVersion ? `${base} v${n}` : `${base} (Copy ${n})`;
      n++;
    } while (isDatasetNameAlreadyUsed(candidate));
    return candidate;
  }

  /**
   * Draw a single edge into SVG group g. Override per edge type for different visuals/anchors.
   * @param {SVGGElement} g
   * @param {{ fromId: string, toId: string, type: string }} edge
   * @param {number} edgeIndex - index in connections (for data-edge-index / future click)
   */
  const RUN_NODE_FALLBACK_HEIGHT = 40;

  function renderEdge(g, edge, edgeIndex) {
    const fromNode = getNodeById(edge.fromId);
    const toNode = getNodeById(edge.toId);
    if (!fromNode || !toNode) return;

    const x1 = parseFloat(fromNode.style.left) || 0;
    const y1 = parseFloat(fromNode.style.top) || 0;
    const w1 = fromNode.offsetWidth || 0;
    const h1 = fromNode.offsetHeight || 0;
    const x2 = parseFloat(toNode.style.left) || 0;
    const y2 = parseFloat(toNode.style.top) || 0;
    const isRunNode = toNode.classList.contains('workflow-node--run');
    const isScoreNode = toNode.classList.contains('workflow-node--score');
    const isPromptReviewNode = toNode.classList.contains('workflow-node--prompt-review');
    const isRunOrScore = isRunNode || isScoreNode || isPromptReviewNode;
    const h2 = isRunOrScore ? (toNode.offsetHeight || RUN_NODE_FALLBACK_HEIGHT) : (toNode.offsetHeight || 0);

    if (edge.type === EDGE_TYPE_PROMPT_TO_PROMPT) {
      const startX = x1 + w1;
      const startY = y1 + h1 / 2;
      const endX = x2;
      const endY = y2 + h2 / 2;
      // Hit area: invisible wide stroke (drawn first, behind visible line)
      const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      hitLine.setAttribute('x1', String(startX));
      hitLine.setAttribute('y1', String(startY));
      hitLine.setAttribute('x2', String(endX));
      hitLine.setAttribute('y2', String(endY));
      hitLine.setAttribute('stroke', 'transparent');
      hitLine.setAttribute('stroke-width', String(EDGE_HIT_STROKE_WIDTH));
      hitLine.setAttribute('data-edge-type', edge.type);
      hitLine.setAttribute('data-edge-index', String(edgeIndex));
      hitLine.setAttribute('pointer-events', 'stroke');
      hitLine.setAttribute('class', 'workflow-edge-hit');
      g.appendChild(hitLine);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(startX));
      line.setAttribute('y1', String(startY));
      line.setAttribute('x2', String(endX));
      line.setAttribute('y2', String(endY));
      line.setAttribute('stroke', 'var(--text-muted)');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('marker-end', 'url(#workflow-arrow)');
      line.setAttribute('data-edge-type', edge.type);
      line.setAttribute('data-edge-index', String(edgeIndex));
      line.setAttribute('pointer-events', 'none');
      g.appendChild(line);
    } else {
      // prompt-to-run / run-to-score: end at left-center of toNode; use fixed height for Run/Score so layout delay doesn't misplace the line
      const startX = x1 + w1;
      const startY = y1 + h1 / 2;
      const endX = x2;
      const toHeight = isRunOrScore ? RUN_NODE_FALLBACK_HEIGHT : h2;
      const endY = y2 + (toHeight > 0 ? toHeight / 2 : RUN_NODE_FALLBACK_HEIGHT / 2);
      const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      hitLine.setAttribute('x1', String(startX));
      hitLine.setAttribute('y1', String(startY));
      hitLine.setAttribute('x2', String(endX));
      hitLine.setAttribute('y2', String(endY));
      hitLine.setAttribute('stroke', 'transparent');
      hitLine.setAttribute('stroke-width', String(EDGE_HIT_STROKE_WIDTH));
      hitLine.setAttribute('data-edge-type', edge.type || '');
      hitLine.setAttribute('data-edge-index', String(edgeIndex));
      hitLine.setAttribute('pointer-events', 'stroke');
      hitLine.setAttribute('class', 'workflow-edge-hit');
      g.appendChild(hitLine);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(startX));
      line.setAttribute('y1', String(startY));
      line.setAttribute('x2', String(endX));
      line.setAttribute('y2', String(endY));
      line.setAttribute('stroke', 'var(--text-muted)');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('marker-end', 'url(#workflow-arrow)');
      line.setAttribute('data-edge-type', edge.type || '');
      line.setAttribute('data-edge-index', String(edgeIndex));
      line.setAttribute('pointer-events', 'none');
      g.appendChild(line);
    }
  }

  function updateEdges() {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('pointer-events', 'auto');
    connections.forEach((edge, i) => renderEdge(g, edge, i));
    const existing = edgesLayer.querySelector('g');
    if (existing) existing.remove();
    edgesLayer.appendChild(g);
  }

  function getPromptDataFromNode(node) {
    if (!node) return null;
    let sections = [];
    let outputFormat = { returnShape: 'single', fields: [] };
    try {
      sections = JSON.parse(node.dataset.promptSections || node.dataset.promptFields || '[]');
    } catch (_) {}
    try {
      const raw = JSON.parse(node.dataset.promptOutputFormat || '[]');
      const fields = (Array.isArray(raw) ? raw : []).map((o) => ({ key: o.key || '', type: o.type || 'str', description: o.description ?? '', examples: o.examples || [], allowNone: o.allowNone === true }));
      outputFormat = { returnShape: node.dataset.promptOutputReturnShape || 'single', fields };
    } catch (_) {}
    return {
      name: node.dataset.promptName || '',
      note: node.dataset.promptNote || '',
      sections: Array.isArray(sections) ? sections : [],
      outputFormat,
    };
  }

  function serializePromptToDiffText(data) {
    const lines = [];
    const sections = data.sections || [];
    if (sections.length === 0) {
      lines.push('## Sections');
      lines.push('(none)');
      lines.push('');
    } else {
      sections.forEach((s) => {
        lines.push('## Section: ' + (s.name || '').trim());
        lines.push((s.content || '').trim());
        lines.push('');
      });
    }
    lines.push('## Output schema');
    const of = data.outputFormat || {};
    lines.push('Return shape: ' + (of.returnShape || 'single'));
    const fields = of.fields || [];
    if (fields.length === 0) {
      lines.push('(no fields)');
    } else {
      fields.forEach((f) => {
        const ex = Array.isArray(f.examples) ? f.examples : [];
        const type = f.type || 'str';
        const allowNone = f.allowNone === true ? 'yes' : 'no';
        const exStr = ex.map((e) => {
          if (Array.isArray(e)) {
            return type === 'list_str'
              ? '[' + e.map((el) => '"' + String(el ?? '').replace(/"/g, '\\"') + '"').join(', ') + ']'
              : '[' + e.join(', ') + ']';
          }
          return type === 'str' ? '"' + String(e ?? '').replace(/"/g, '\\"') + '"' : String(e);
        }).join('; ');
        lines.push('Field: ' + (f.key || '').trim() + ' | ' + type + ' | ' + (f.description || '').trim() + ' | Allow None: ' + allowNone + ' | ' + exStr);
      });
    }
    return lines.join('\n');
  }

  /** Line-based LCS diff. Returns { type: 'remove'|'add'|'unchanged', line, oldNum?, newNum? }[]. */
  function lineDiff(oldText, newText) {
    const a = (oldText || '').split('\n');
    const b = (newText || '').split('\n');
    const m = a.length;
    const n = b.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const result = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        result.unshift({ type: 'unchanged', line: a[i - 1], oldNum: i, newNum: j });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        result.unshift({ type: 'add', line: b[j - 1], newNum: j });
        j--;
      } else {
        result.unshift({ type: 'remove', line: a[i - 1], oldNum: i });
        i--;
      }
    }
    return result;
  }

  function openPromptDiffModal(fromData, toData, fromName, toName) {
    let bodyHtml;
    if (!fromData || !toData) {
      bodyHtml = '<p class="prompt-detail-placeholder">One or both nodes are missing. Cannot compare.</p>';
    } else {
      const oldText = serializePromptToDiffText(fromData);
      const newText = serializePromptToDiffText(toData);
      const diffLines = lineDiff(oldText, newText);
      bodyHtml = '<div class="prompt-diff-view"><table class="prompt-diff-table"><colgroup><col class="diff-col-old-num"><col class="diff-col-old-content"><col class="diff-col-new-num"><col class="diff-col-new-content"></colgroup><thead><tr><th colspan="2" class="diff-th-old">Before</th><th colspan="2" class="diff-th-new">After</th></tr></thead><tbody>' +
        diffLines.map((item) => {
          const cls = 'diff-line diff-' + item.type;
          const oldNum = item.type === 'add' ? '' : (item.oldNum || '');
          const newNum = item.type === 'remove' ? '' : (item.newNum || '');
          const lineEsc = escapeHtml(item.line || ' ');
          const oldCell = item.type === 'add' ? '<td class="diff-line-num diff-old-num"></td><td class="diff-line-content diff-old-content"></td>' : '<td class="diff-line-num diff-old-num">' + oldNum + '</td><td class="diff-line-content diff-old-content">' + lineEsc + '</td>';
          const newCell = item.type === 'remove' ? '<td class="diff-line-num diff-new-num"></td><td class="diff-line-content diff-new-content"></td>' : '<td class="diff-line-num diff-new-num">' + newNum + '</td><td class="diff-line-content diff-new-content">' + lineEsc + '</td>';
          return '<tr class="' + cls + '">' + oldCell + newCell + '</tr>';
        }).join('') +
        '</tbody></table></div>';
    }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'edge-detail-title');
    overlay.innerHTML = `
      <div class="modal-panel modal-panel--edge-detail">
        <div class="modal-header">
          <h2 id="edge-detail-title" class="modal-title">${escapeHtml(fromName)} → ${escapeHtml(toName)}</h2>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body modal-body--diff">
          ${bodyHtml}
        </div>
      </div>
    `;
    overlay.querySelector('.modal-close').addEventListener('click', () => {
      overlay.remove();
      document.body.style.overflow = '';
    });
    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
  }

  function openEdgeDetailModal(edge, edgeIndex) {
    const fromNode = getNodeById(edge.fromId);
    const toNode = getNodeById(edge.toId);
    const fromData = fromNode ? getPromptDataFromNode(fromNode) : null;
    const toData = toNode ? getPromptDataFromNode(toNode) : null;
    const fromName = (fromData && fromData.name.trim()) || 'Prompt';
    const toName = (toData && toData.name.trim()) || 'Prompt';
    openPromptDiffModal(fromData, toData, fromName, toName);
  }

  function openReviewToPromptEdgeDetailModal(edge) {
    const reviewNode = getNodeById(edge.fromId);
    const toNode = getNodeById(edge.toId);
    if (!reviewNode || !toNode) return;
    const scoreToReview = connections.find((c) => c.toId === reviewNode.dataset.nodeId && c.type === EDGE_TYPE_SCORE_TO_PROMPT_REVIEW);
    const scoreNode = scoreToReview ? getNodeById(scoreToReview.fromId) : null;
    const runEdge = scoreNode ? connections.find((c) => c.toId === scoreNode.dataset.nodeId && c.type === EDGE_TYPE_RUN_TO_SCORE) : null;
    const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
    const promptEdge = runNode ? connections.find((c) => c.toId === runNode.dataset.nodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN) : null;
    const sourcePromptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
    const fromData = sourcePromptNode ? getPromptDataFromNode(sourcePromptNode) : null;
    const toData = toNode ? getPromptDataFromNode(toNode) : null;
    const fromName = (fromData && fromData.name.trim()) || 'Prompt';
    const toName = (toData && toData.name.trim()) || 'Prompt';
    openPromptDiffModal(fromData, toData, fromName, toName);
  }

  function serializeSubsetToDiffText(content) {
    if (!content) return '(no data)';
    const headers = content.headers || [];
    const rows = content.rows || [];
    const lines = [];
    lines.push('Headers: ' + headers.join(', ') || '(none)');
    rows.forEach((row, i) => {
      const cells = Array.isArray(row) ? row : [];
      lines.push('Row ' + (i + 1) + ': ' + cells.join(', '));
    });
    if (rows.length === 0) lines.push('(no rows)');
    return lines.join('\n');
  }

  function openDatasetEdgeDetailModal(edge) {
    const fromNode = getNodeById(edge.fromId);
    const toNode = getNodeById(edge.toId);
    const fromContent = datasetContentByNodeId.get(edge.fromId) || null;
    const toContent = datasetContentByNodeId.get(edge.toId) || null;
    const fromName = (fromNode?.dataset?.datasetName ?? fromNode?.dataset?.subsetName ?? '').trim() || 'Dataset';
    const toName = (toNode?.dataset?.datasetName ?? toNode?.dataset?.subsetName ?? '').trim() || 'Dataset';

    const oldText = serializeSubsetToDiffText(fromContent);
    const newText = serializeSubsetToDiffText(toContent);
    const diffLines = lineDiff(oldText, newText);
    const bodyHtml = '<div class="prompt-diff-view"><table class="prompt-diff-table"><colgroup><col class="diff-col-old-num"><col class="diff-col-old-content"><col class="diff-col-new-num"><col class="diff-col-new-content"></colgroup><thead><tr><th colspan="2" class="diff-th-old">Before</th><th colspan="2" class="diff-th-new">After</th></tr></thead><tbody>' +
      diffLines.map((item) => {
        const cls = 'diff-line diff-' + item.type;
        const oldNum = item.type === 'add' ? '' : (item.oldNum || '');
        const newNum = item.type === 'remove' ? '' : (item.newNum || '');
        const lineEsc = escapeHtml(item.line || ' ');
        const oldCell = item.type === 'add' ? '<td class="diff-line-num diff-old-num"></td><td class="diff-line-content diff-old-content"></td>' : '<td class="diff-line-num diff-old-num">' + oldNum + '</td><td class="diff-line-content diff-old-content">' + lineEsc + '</td>';
        const newCell = item.type === 'remove' ? '<td class="diff-line-num diff-new-num"></td><td class="diff-line-content diff-new-content"></td>' : '<td class="diff-line-num diff-new-num">' + newNum + '</td><td class="diff-line-content diff-new-content">' + lineEsc + '</td>';
        return '<tr class="' + cls + '">' + oldCell + newCell + '</tr>';
      }).join('') +
      '</tbody></table></div>';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'edge-detail-title');
    overlay.innerHTML = `
      <div class="modal-panel modal-panel--edge-detail">
        <div class="modal-header">
          <h2 id="edge-detail-title" class="modal-title">${escapeHtml(fromName)} → ${escapeHtml(toName)}</h2>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body modal-body--diff">
          ${bodyHtml}
        </div>
      </div>
    `;
    overlay.querySelector('.modal-close').addEventListener('click', () => {
      overlay.remove();
      document.body.style.overflow = '';
    });
    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
  }

  function onEdgesLayerClick(e) {
    const lineEl = e.target && (e.target.tagName === 'line' || e.target.localName === 'line') ? e.target : null;
    if (!lineEl) return;
    const edgeType = lineEl.getAttribute('data-edge-type');
    const indexStr = lineEl.getAttribute('data-edge-index');
    if (indexStr === null) return;
    const edgeIndex = parseInt(indexStr, 10);
    const edge = connections[edgeIndex];
    if (!edge) return;
    if (edgeType === EDGE_TYPE_PROMPT_TO_PROMPT) {
      e.preventDefault();
      e.stopPropagation();
      openEdgeDetailModal(edge, edgeIndex);
    } else if (edgeType === EDGE_TYPE_PROMPT_REVIEW_TO_PROMPT) {
      e.preventDefault();
      e.stopPropagation();
      openReviewToPromptEdgeDetailModal(edge);
    } else if (edgeType === EDGE_TYPE_DATASET_TO_DATASET) {
      e.preventDefault();
      e.stopPropagation();
      openDatasetEdgeDetailModal(edge);
    } else if (edgeType === EDGE_TYPE_SAMPLER_TO_DATASET) {
      e.preventDefault();
      e.stopPropagation();
      const dsNode = getNodeById(edge.toId);
      if (dsNode && dsNode.classList.contains('workflow-node--dataset')) {
        openDatasetDetailModal({
          node: dsNode,
          getContent: () => datasetContentByNodeId.get(dsNode.dataset.nodeId) || { headers: [], rows: [] },
          saveContent: (content) => {
            datasetContentByNodeId.set(dsNode.dataset.nodeId, { headers: content.headers.slice(), rows: content.rows.map((r) => r.slice()) });
            document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
          },
        });
      }
    } else if (edgeType === EDGE_TYPE_DATASET_TO_SAMPLER) {
      e.preventDefault();
      e.stopPropagation();
      const samplerNode = getNodeById(edge.toId);
      if (samplerNode) openSamplerDetailModal({ node: samplerNode, isSamplerNameAlreadyUsedForSource, hasSampledDatasets });
    } else if (edgeType === EDGE_TYPE_RUN_TO_SCORE) {
      e.preventDefault();
      e.stopPropagation();
      const scoreNode = getNodeById(edge.toId);
      if (scoreNode && scoreNode.classList.contains('workflow-node--score')) {
        const workingSets = Array.from(nodesLayer.querySelectorAll('.workflow-node--dataset')).map((n) => {
          const id = n.dataset.nodeId || '';
          const content = datasetContentByNodeId.get(id);
          const colorIndex = n.dataset.datasetColorIndex != null ? parseInt(n.dataset.datasetColorIndex, 10) : 0;
          const color = DATASET_BORDER_COLORS[colorIndex % DATASET_BORDER_COLORS.length];
          return {
            nodeId: id,
            name: (n.dataset.datasetName || n.dataset.subsetName || '').trim() || 'Dataset',
            headers: content?.headers ? content.headers.slice() : [],
            color,
          };
        });
        const runEdge = connections.find((c) => c.toId === scoreNode.dataset.nodeId && c.type === EDGE_TYPE_RUN_TO_SCORE);
        const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
        const promptEdgeForRun = runNode ? connections.find((c) => c.toId === runNode.dataset.nodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN) : null;
        const promptNodeForScore = promptEdgeForRun ? getNodeById(promptEdgeForRun.fromId) : null;
        function getRunResultColumns() {
          if (!runNode) return [];
          const cols = [];
          cols.push({ key: '#', label: '#' });
          let results = [];
          try {
            results = JSON.parse(runNode.dataset.runResults || '[]');
            if (!Array.isArray(results)) results = [];
          } catch (_) {}
          let schemaFields = [];
          if (promptNodeForScore) {
            try {
              const raw = promptNodeForScore.dataset.promptOutputFormat || '[]';
              schemaFields = JSON.parse(raw);
              if (!Array.isArray(schemaFields)) schemaFields = [];
            } catch (_) {}
          }
          const outputFields = deriveOutputFields(results, schemaFields);
          outputFields.forEach((f) => cols.push({ key: f.key || '', label: (f.display || f.key || '').trim() || f.key || '—' }));
          const wsId = (runNode.dataset.runWorkingSetId || '').trim();
          const wsContent = wsId ? datasetContentByNodeId.get(wsId) : null;
          const wsHeaders = (wsContent && wsContent.headers) ? wsContent.headers.slice() : [];
          cols.push({ key: '[#]', label: 'Input: #' });
          wsHeaders.forEach((h) => {
            const headerText = String(h ?? '').trim() || ' ';
            cols.push({ key: `[${headerText}]`, label: `Input: ${headerText}` });
          });
          return cols;
        }
        function getGroundTruthHeaders(wsNodeId) {
          const c = datasetContentByNodeId.get(wsNodeId || '');
          return (c && c.headers) ? c.headers.slice() : [];
        }
        function getRunResults() {
          if (!runNode) return { results: [], outputFields: [] };
          let results = [];
          try {
            results = JSON.parse(runNode.dataset.runResults || '[]');
            if (!Array.isArray(results)) results = [];
          } catch (_) {}
          let schemaFields = [];
          if (promptNodeForScore) {
            try {
              const raw = promptNodeForScore.dataset.promptOutputFormat || '[]';
              schemaFields = JSON.parse(raw);
              if (!Array.isArray(schemaFields)) schemaFields = [];
            } catch (_) {}
          }
          const outputFields = deriveOutputFields(results, schemaFields);
          return { results, outputFields };
        }
        function getRunWorkingSetContent() {
          const wsId = (runNode && runNode.dataset.runWorkingSetId) ? runNode.dataset.runWorkingSetId.trim() : '';
          const c = wsId ? datasetContentByNodeId.get(wsId) : null;
          return c ? { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) } : { headers: [], rows: [] };
        }
        function getGroundTruthContent(wsNodeId) {
          const c = datasetContentByNodeId.get(wsNodeId || '');
          if (!c) return { headers: [], rows: [] };
          return { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) };
        }
        openScoreDetailModal({
          node: scoreNode,
          getWorkingSets: () => workingSets,
          getRunResultColumns,
          getGroundTruthHeaders,
          getRunResults,
          getRunWorkingSetContent,
          getGroundTruthContent,
          getScoreMappingsFromCanvas: () => Array.from(nodesLayer.querySelectorAll('.workflow-node--score')).map((n) => n.dataset.scoreMapping || '[]'),
        });
      }
    } else if (edgeType === EDGE_TYPE_PROMPT_TO_RUN) {
      e.preventDefault();
      e.stopPropagation();
      const runNode = getNodeById(edge.toId);
      if (!runNode || !runNode.classList.contains('workflow-node--run')) return;
      const runNodeId = runNode.dataset.nodeId;
      const promptEdge = connections.find((c) => c.toId === runNodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN);
      let sections = [];
      if (promptEdge) {
        const promptNode = getNodeById(promptEdge.fromId);
        if (promptNode) {
          try {
            sections = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
          } catch (_) {}
        }
      }
      const promptInputFields = extractInputFieldsFromSections(Array.isArray(sections) ? sections : []);
      const workingSets = Array.from(nodesLayer.querySelectorAll('.workflow-node--dataset')).map((n) => {
        const id = n.dataset.nodeId || '';
        const content = datasetContentByNodeId.get(id);
        const colorIndex = n.dataset.datasetColorIndex != null ? parseInt(n.dataset.datasetColorIndex, 10) : 0;
        const color = DATASET_BORDER_COLORS[colorIndex % DATASET_BORDER_COLORS.length];
        return {
          nodeId: id,
          name: (n.dataset.datasetName || n.dataset.subsetName || '').trim() || 'Dataset',
          headers: content?.headers ? content.headers.slice() : [],
          color,
        };
      });
      const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
      function getSubsetContent(nodeId) {
        const c = datasetContentByNodeId.get(nodeId);
        return c ? { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) } : { headers: [], rows: [] };
      }
      function getPromptTemplate() {
        if (!promptNode) return { sections: [], outputSchema: { return_shape: 'single', fields: [] } };
        let sec = [];
        try {
          sec = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
        } catch (_) {}
        let fields = [];
        try {
          fields = JSON.parse(promptNode.dataset.promptOutputFormat || '[]');
        } catch (_) {}
        const returnShape = promptNode.dataset.promptOutputReturnShape || 'single';
        return { sections: sec, outputSchema: { return_shape: returnShape, fields } };
      }
      openRunDetailModal({
        node: runNode,
        getWorkingSets: () => workingSets,
        getPromptInputFields: () => promptInputFields,
        getSubsetContent,
        getPromptTemplate,
        registerPendingRun,
        unregisterPendingRun,
        getPendingRunId: () => pendingRuns.get(runNode.dataset.nodeId) || null,
        getPromptName: () => {
          if (!promptNode) return '';
          return (promptNode.dataset.promptName || '').trim() || (promptNode.querySelector('.workflow-node__title')?.textContent?.trim() || '');
        },
        getUniqueDatasetExportName: findUniqueDatasetExportName,
        isRunNameAlreadyUsedForPrompt,
        getRunMappingsFromCanvas: () => Array.from(nodesLayer.querySelectorAll('.workflow-node--run')).map((n) => {
          try {
            const raw = n.dataset.runInputToColumn;
            if (!raw) return null;
            const o = JSON.parse(raw);
            return typeof o === 'object' && o !== null ? o : null;
          } catch (_) { return null; }
        }).filter(Boolean),
      });
    } else if (edgeType === EDGE_TYPE_SCORE_TO_PROMPT_REVIEW) {
      e.preventDefault();
      e.stopPropagation();
      const node = getNodeById(edge.toId);
      if (!node || !node.classList.contains('workflow-node--prompt-review')) return;
      const scoreEdge = connections.find((c) => c.toId === node.dataset.nodeId && c.type === EDGE_TYPE_SCORE_TO_PROMPT_REVIEW);
      const scoreNode = scoreEdge ? getNodeById(scoreEdge.fromId) : null;
      const runEdge = scoreNode ? connections.find((c) => c.toId === scoreNode.dataset.nodeId && c.type === EDGE_TYPE_RUN_TO_SCORE) : null;
      const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
      const promptEdge = runNode ? connections.find((c) => c.toId === runNode.dataset.nodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN) : null;
      const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
      async function getPayload() {
        if (!promptNode || !runNode || !scoreNode) return null;
        let sections = [];
        try {
          sections = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
        } catch (_) {}
        if (!Array.isArray(sections) || sections.length === 0) return null;
        const promptFullText = sections.map((s) => `## ${(s.name || '').trim() || '(unnamed)'}\n\n${(s.content || '').trim()}`).join('\n\n');
        let runResults = [];
        let outputFields = [];
        try {
          runResults = JSON.parse(runNode.dataset.runResults || '[]');
          outputFields = JSON.parse(runNode.dataset.runOutputFields || '[]');
        } catch (_) {}
        const comparison_rows = await buildReviewComparisonRows(scoreNode, runNode, datasetContentByNodeId, sections);
        let output_schema = null;
        try {
          const raw = promptNode.dataset.promptOutputFormat || '[]';
          const fields = (Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : []).map((o) => ({
            key: o.key || '',
            type: o.type || 'str',
            description: o.description,
            allow_none: o.allowNone === true || o.allow_none === true,
          })).filter((f) => (f.key || '').trim());
          if (fields.length > 0) {
            output_schema = { return_shape: promptNode.dataset.promptOutputReturnShape || 'single', fields };
          }
        } catch (_) {}
        const runWsId = (runNode.dataset.runWorkingSetId || '').trim();
        const gtId = (scoreNode.dataset.scoreGroundTruthId || '').trim();
        let run_input_to_column = {};
        try {
          const raw = runNode.dataset.runInputToColumn || '{}';
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') run_input_to_column = parsed;
        } catch (_) {}
        const run_credential_id = await resolveRunCredentialId(runNode);
        return {
          prompt_sections: sections,
          prompt_full_text: promptFullText,
          run_results: runResults,
          output_fields: outputFields,
          comparison_rows,
          output_schema,
          score_mapping: scoreNode.dataset.scoreMapping || '[]',
          run_credential_id,
          run_input_to_column,
          getRunWorkingSetContent: () => runWsId ? (datasetContentByNodeId.get(runWsId) || { headers: [], rows: [] }) : { headers: [], rows: [] },
          getGroundTruthContent: () => gtId ? (datasetContentByNodeId.get(gtId) || { headers: [], rows: [] }) : { headers: [], rows: [] },
        };
      }
      function getReviewResult() {
        try {
          let raw = (node.dataset.reviewResult || '').trim();
          if (!raw && scoreNode && (scoreNode.dataset.reviewResult || '').trim()) {
            raw = scoreNode.dataset.reviewResult || '';
            node.dataset.reviewResult = raw;
            document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
          }
          if (!raw) return null;
          return JSON.parse(raw);
        } catch (_) { return null; }
      }
      function updateReviewResult(updated) {
        try {
          node.dataset.reviewResult = JSON.stringify(updated);
          document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
        } catch (e) {
          console.error('reviewResult save failed', e);
          showAlert(String(e?.message || e || 'Could not save review data.'), { title: 'Save error' });
        }
      }
      function onExportNewPrompt(sections) {
        document.dispatchEvent(new CustomEvent('workflow:add-prompt-from-review', {
          detail: { sections, afterReviewNodeId: node.dataset.nodeId },
        }));
      }
      openReviewDetailModal({
        node,
        getPayload,
        getReviewResult,
        updateReviewResult,
        onExportNewPrompt,
        getIsReviewStreaming: () => pendingReviewNodeIds.has(node.dataset.nodeId),
      });
    }
  }

  edgesLayer.addEventListener('click', onEdgesLayerClick);

  edgesLayer.addEventListener('mouseenter', (e) => {
    const el = e.target;
    if (el?.classList?.contains('workflow-edge-hit')) {
      const visible = el.nextElementSibling;
      if (visible) visible.setAttribute('marker-end', 'url(#workflow-arrow-hover)');
    }
  }, true);
  edgesLayer.addEventListener('mouseleave', (e) => {
    const el = e.target;
    if (el?.classList?.contains('workflow-edge-hit')) {
      const visible = el.nextElementSibling;
      if (visible) visible.setAttribute('marker-end', 'url(#workflow-arrow)');
    }
  }, true);

  function updateContentSize() {
    const nodes = nodesLayer.querySelectorAll('.workflow-node');
    const viewportW = scrollWrapper.clientWidth || 800;
    const viewportH = scrollWrapper.clientHeight || 600;
    const minW = Math.max(viewportW, MIN_CANVAS_WIDTH);
    const minH = Math.max(viewportH, MIN_CANVAS_HEIGHT);
    let maxRight = 0;
    let maxBottom = 0;
    nodes.forEach((n) => {
      const left = parseFloat(n.style.left) || 0;
      const top = parseFloat(n.style.top) || 0;
      maxRight = Math.max(maxRight, left + (n.offsetWidth || 0));
      maxBottom = Math.max(maxBottom, top + (n.offsetHeight || 0));
    });
    const width = Math.max(minW, maxRight + MIN_CONTENT_PADDING);
    const height = Math.max(minH, maxBottom + MIN_CONTENT_PADDING);
    contentInner.style.width = `${width}px`;
    contentInner.style.height = `${height}px`;
    nodesLayer.style.width = `${width}px`;
    nodesLayer.style.minHeight = `${height}px`;
    scaleWrapper.style.width = `${width}px`;
    scaleWrapper.style.height = `${height}px`;
    zoomOuter.style.width = `${width * zoomLevel}px`;
    zoomOuter.style.height = `${height * zoomLevel}px`;
  }

  const zoomToolbar = document.createElement('div');
  zoomToolbar.className = 'workflow-canvas__zoom-toolbar';
  zoomToolbar.setAttribute('role', 'toolbar');
  zoomToolbar.setAttribute('aria-label', 'Canvas zoom');
  zoomToolbar.innerHTML = `
    <button type="button" class="workflow-canvas__zoom-btn" data-zoom="out" aria-label="Zoom out"><span class="workflow-canvas__zoom-btn-symbol">−</span></button>
    <span class="workflow-canvas__zoom-label" aria-live="polite">100%</span>
    <button type="button" class="workflow-canvas__zoom-btn" data-zoom="in" aria-label="Zoom in"><span class="workflow-canvas__zoom-btn-symbol">+</span></button>
  `;
  const zoomLabelEl = zoomToolbar.querySelector('.workflow-canvas__zoom-label');
  function updateZoomLabel() {
    zoomLabelEl.textContent = Math.round(zoomLevel * 100) + '%';
  }
  zoomToolbar.querySelector('[data-zoom="out"]').addEventListener('click', () => {
    zoomLevel = Math.max(MIN_ZOOM, zoomLevel - ZOOM_STEP);
    applyZoom();
    updateContentSize();
    updateZoomLabel();
  });
  zoomToolbar.querySelector('[data-zoom="in"]').addEventListener('click', () => {
    zoomLevel = Math.min(MAX_ZOOM, zoomLevel + ZOOM_STEP);
    applyZoom();
    updateContentSize();
    updateZoomLabel();
  });
  canvas.appendChild(zoomToolbar);

  scrollWrapper.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    zoomLevel = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomLevel + delta));
    applyZoom();
    updateContentSize();
    updateZoomLabel();
  }, { passive: false });

  requestAnimationFrame(() => {
    applyZoom();
    updateContentSize();
    updateZoomLabel();
  });

  function createPromptNode({ name = '', note = '', sections = [], outputFormat, left, top, nodeId: givenNodeId }) {
    const nodeId = givenNodeId || generateNodeId();
    const title = (name && name.trim()) ? name.trim() : 'Prompt';
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--prompt';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', `Prompt node: ${title}`);
    node.dataset.nodeId = nodeId;
    node.dataset.promptSections = JSON.stringify(sections);
    node.dataset.promptName = name;
    node.dataset.promptNote = note;
    let ofList = outputFormat?.fields ?? (Array.isArray(outputFormat) ? outputFormat : []);
    if (!ofList.length && outputFormat?.columns?.length) {
      ofList = outputFormat.columns.map((key) => ({
        key: key || '',
        type: 'str',
        examples: (outputFormat.examples || []).map((r) => r[key]).filter((v) => v != null && v !== ''),
      }));
    }
    ofList = ofList.map((o) => ({ key: o.key || '', type: o.type || 'str', description: o.description ?? '', examples: o.examples || [], allowNone: o.allowNone === true }));
    node.dataset.promptOutputFormat = JSON.stringify(ofList);
    node.dataset.promptOutputReturnShape = outputFormat?.returnShape ?? 'single';
    const x = typeof left === 'number' ? left : 80 + (nodeCount % 5) * (280 + STAGGER);
    const y = typeof top === 'number' ? top : 80 + Math.floor(nodeCount / 5) * (120 + STAGGER);
    nodeCount += 1;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    const noteTrimmed = (note || '').trim();
    const hasNote = noteTrimmed.length > 0;
    if (!hasNote) node.classList.add('workflow-node--no-body');
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--prompt" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="4" x2="12" y2="4"/><line x1="2" y1="7" x2="12" y2="7"/><line x1="2" y1="10" x2="8" y2="10"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(title)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
      </div>
      ${hasNote ? `<div class="workflow-node__body"><span class="workflow-node__note">${escapeHtml(noteTrimmed)}</span></div>` : ''}
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void handleWorkflowNodeDeleteClick(nodeId, 'prompt', () => {
        removeConnectionsInvolvingNodeId(nodeId);
        node.remove();
        updateContentSize();
        updateEdges();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      });
    });

    let dragStartX = 0;
    let dragStartY = 0;
    let nodeStartLeft = 0;
    let nodeStartTop = 0;
    let lastInteractionWasDrag = false;

    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      lastInteractionWasDrag = false;
      const rect = node.getBoundingClientRect();
      const swRect = scrollWrapper.getBoundingClientRect();
      const sl = scrollWrapper.scrollLeft;
      const st = scrollWrapper.scrollTop;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartLeft = (rect.left - swRect.left + sl) / zoomLevel;
      nodeStartTop = (rect.top - swRect.top + st) / zoomLevel;
      node.classList.add('workflow-node--dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, { once: true });
    }

    function onPointerMove(e) {
      lastInteractionWasDrag = true;
      const dx = (e.clientX - dragStartX) / zoomLevel;
      const dy = (e.clientY - dragStartY) / zoomLevel;
      node.style.left = `${nodeStartLeft + dx}px`;
      node.style.top = `${nodeStartTop + dy}px`;
      updateEdges();
    }

    function onPointerUp() {
      node.classList.remove('workflow-node--dragging');
      document.removeEventListener('pointermove', onPointerMove);
      updateContentSize();
      updateEdges();
      if (lastInteractionWasDrag) document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }

    node.addEventListener('pointerdown', onPointerDown);

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (lastInteractionWasDrag) return;
      e.preventDefault();
      e.stopPropagation();
      let sectionsData = [];
      try {
        sectionsData = JSON.parse(node.dataset.promptSections || node.dataset.promptFields || '[]');
      } catch (_) {}
      openPromptDetailModal({
        name: node.dataset.promptName || '',
        note: node.dataset.promptNote || '',
        sections: sectionsData,
        node,
        isPromptNameAlreadyUsed,
        onRunPrompt: () => {
          const left = parseFloat(node.style.left) || 0;
          const top = parseFloat(node.style.top) || 0;
          const width = node.offsetWidth || 280;
        const runNode = createRunNode({
          left: left + width + NEW_NODE_OFFSET,
          top,
          title: 'Run',
        });
          if (runNode?.dataset?.nodeId) {
            connections.push({
              fromId: node.dataset.nodeId,
              toId: runNode.dataset.nodeId,
              type: EDGE_TYPE_PROMPT_TO_RUN,
            });
            updateEdges();
          }
          updateContentSize();
          document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
          if (runNode?.dataset?.nodeId) {
            let sections = [];
            try {
              sections = JSON.parse(node.dataset.promptSections || node.dataset.promptFields || '[]');
            } catch (_) {}
            const promptInputFields = extractInputFieldsFromSections(Array.isArray(sections) ? sections : []);
            const workingSets = Array.from(nodesLayer.querySelectorAll('.workflow-node--dataset')).map((n) => {
              const id = n.dataset.nodeId || '';
              const content = datasetContentByNodeId.get(id);
              const colorIndex = n.dataset.datasetColorIndex != null ? parseInt(n.dataset.datasetColorIndex, 10) : 0;
              const color = DATASET_BORDER_COLORS[colorIndex % DATASET_BORDER_COLORS.length];
              return {
                nodeId: id,
                name: (n.dataset.datasetName || n.dataset.subsetName || '').trim() || 'Dataset',
                headers: content?.headers ? content.headers.slice() : [],
                color,
              };
            });
            function getSubsetContent(nodeId) {
              const c = datasetContentByNodeId.get(nodeId);
              return c ? { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) } : { headers: [], rows: [] };
            }
            function getPromptTemplate() {
              let sec = [];
              try {
                sec = JSON.parse(node.dataset.promptSections || node.dataset.promptFields || '[]');
              } catch (_) {}
              let fields = [];
              try {
                fields = JSON.parse(node.dataset.promptOutputFormat || '[]');
              } catch (_) {}
              const returnShape = node.dataset.promptOutputReturnShape || 'single';
              return { sections: sec, outputSchema: { return_shape: returnShape, fields } };
            }
            openRunDetailModal({
              node: runNode,
              getWorkingSets: () => workingSets,
              getPromptInputFields: () => promptInputFields,
              getSubsetContent,
              getPromptTemplate,
              registerPendingRun,
              unregisterPendingRun,
              getPendingRunId: () => pendingRuns.get(runNode.dataset.nodeId) || null,
              getPromptName: () => (node.dataset.promptName || '').trim() || (node.querySelector('.workflow-node__title')?.textContent?.trim() || ''),
              getUniqueDatasetExportName: findUniqueDatasetExportName,
              isRunNameAlreadyUsedForPrompt,
              getRunMappingsFromCanvas: () => Array.from(nodesLayer.querySelectorAll('.workflow-node--run')).map((n) => {
                try {
                  const raw = n.dataset.runInputToColumn;
                  if (!raw) return null;
                  const o = JSON.parse(raw);
                  return typeof o === 'object' && o !== null ? o : null;
                } catch (_) { return null; }
              }).filter(Boolean),
            });
          }
        },
      });
    });

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    return node;
  }

  // 高对比度调色板：相邻色相差异大，便于区分不同数据集
  const DATASET_BORDER_COLORS = [
    '#2563eb', '#dc2626', '#16a34a', '#c026d3', '#ea580c', '#0891b2', '#ca8a04', '#7c3aed',
    '#0d9488', '#b91c1c', '#65a30d', '#a855f7', '#f59e0b', '#06b6d4', '#84cc16', '#6366f1',
    '#10b981', '#ef4444', '#22c55e', '#d946ef', '#f97316', '#0ea5e9', '#eab308', '#8b5cf6',
    '#14b8a6', '#f43f5e', '#4ade80', '#c084fc', '#fb923c', '#38bdf8', '#a3e635', '#a78bfa',
    '#2dd4bf', '#ec4899', '#86efac', '#e879f9', '#fdba74', '#7dd3fc', '#bef264', '#c4b5fd',
  ]; // 40 colors

  /** 从 sampler 节点生成简短描述（用于 dataset 节点下方） */
  function formatSamplerDescription(samplerNode) {
    if (!samplerNode || !samplerNode.dataset) return '';
    const name = (samplerNode.dataset.samplerName || '').trim() || 'Sample';
    const type = samplerNode.dataset.samplerSamplingType || 'without-replacement';
    const typeLabel = type === 'with-replacement' ? 'with replacement' : type === 'specify-rows' ? 'specify rows' : 'without replacement';
    if (type === 'specify-rows') {
      const rowSpec = (samplerNode.dataset.samplerRowSpec || '').trim();
      return rowSpec ? `${name} · ${typeLabel}: ${rowSpec}` : `${name} · ${typeLabel}`;
    }
    const sizeType = samplerNode.dataset.samplerSampleSizeType || 'rows';
    const size = samplerNode.dataset.samplerSampleSize != null ? String(samplerNode.dataset.samplerSampleSize).trim() : '100';
    const sizeLabel = sizeType === 'ratio' ? `${size}%` : `${size} rows`;
    return `${name} · ${typeLabel}, ${sizeLabel}`;
  }

  function createSamplerNode({ name = '', notes = '', left, top, nodeId: givenNodeId, sourceNodeId = '', colorIndex: givenColorIndex, samplingType = 'without-replacement', sampleSizeType = 'rows', sampleSize = 100, rowSpec = '' }) {
    const nodeId = givenNodeId || generateNodeId();
    const title = (name && name.trim()) ? name.trim() : 'Sample';
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--sampler workflow-node--no-body';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', `Sample node: ${title}`);
    node.dataset.nodeId = nodeId;
    node.dataset.samplerName = name;
    node.dataset.samplerNote = notes;
    node.dataset.nodeType = 'sampler';
    node.dataset.samplerSamplingType = samplingType;
    if (samplingType === 'specify-rows') {
      node.dataset.samplerRowSpec = (rowSpec || '').trim();
    } else {
      node.dataset.samplerSampleSizeType = sampleSizeType;
      node.dataset.samplerSampleSize = String(sampleSize);
    }
    if (sourceNodeId) node.dataset.sourceNodeId = sourceNodeId;
    let colorIndex = typeof givenColorIndex === 'number' && givenColorIndex >= 0 ? givenColorIndex : 0;
    colorIndex = colorIndex % DATASET_BORDER_COLORS.length;
    node.dataset.samplerColorIndex = String(colorIndex);
    const x = typeof left === 'number' ? left : 80 + (nodeCount % 5) * (280 + STAGGER);
    const y = typeof top === 'number' ? top : 80 + Math.floor(nodeCount / 5) * (120 + STAGGER);
    nodeCount += 1;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--sampler" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2 2h10l-2 5H4L2 2z"/><line x1="4" y1="7" x2="10" y2="7"/><line x1="5" y1="11" x2="9" y2="11"/><line x1="6" y1="13" x2="8" y2="13"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(title)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
      </div>
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void handleWorkflowNodeDeleteClick(nodeId, 'sampler', () => {
        removeConnectionsInvolvingNodeId(nodeId);
        node.remove();
        updateContentSize();
        updateEdges();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      });
    });

    let dragStartX = 0, dragStartY = 0, nodeStartLeft = 0, nodeStartTop = 0;
    let lastInteractionWasDrag = false;
    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      lastInteractionWasDrag = false;
      const rect = node.getBoundingClientRect();
      const swRect = scrollWrapper.getBoundingClientRect();
      const sl = scrollWrapper.scrollLeft;
      const st = scrollWrapper.scrollTop;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartLeft = (rect.left - swRect.left + sl) / zoomLevel;
      nodeStartTop = (rect.top - swRect.top + st) / zoomLevel;
      node.classList.add('workflow-node--dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, { once: true });
    }
    function onPointerMove(e) {
      lastInteractionWasDrag = true;
      const dx = (e.clientX - dragStartX) / zoomLevel;
      const dy = (e.clientY - dragStartY) / zoomLevel;
      node.style.left = `${nodeStartLeft + dx}px`;
      node.style.top = `${nodeStartTop + dy}px`;
      updateEdges();
    }
    function onPointerUp() {
      node.classList.remove('workflow-node--dragging');
      document.removeEventListener('pointermove', onPointerMove);
      updateContentSize();
      updateEdges();
      if (lastInteractionWasDrag) document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
    node.addEventListener('pointerdown', onPointerDown);

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (lastInteractionWasDrag) return;
      e.preventDefault();
      e.stopPropagation();
      openSamplerDetailModal({ node, isSamplerNameAlreadyUsedForSource, hasSampledDatasets });
    });

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    return node;
  }

  function createDatasetNode({ name = '', notes = '', left, top, nodeId: givenNodeId, samplerNodeId = '', colorIndex: givenColorIndex, headers, rows }) {
    const nodeId = givenNodeId || generateNodeId();
    const title = (name && name.trim()) ? name.trim() : 'Dataset';
    const samplerNode = samplerNodeId ? getNodeById(samplerNodeId) : null;
    const samplerDesc = formatSamplerDescription(samplerNode);
    const notesTrimmed = (notes !== undefined && notes !== null) ? String(notes).trim() : '';
    const bodyText = samplerDesc || notesTrimmed || '';
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--dataset';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', `Dataset node: ${title}`);
    node.dataset.nodeId = nodeId;
    node.dataset.datasetName = name;
    if (notes !== undefined && notes !== null) node.dataset.datasetNote = String(notes);
    node.dataset.nodeType = 'dataset';
    if (samplerNodeId) node.dataset.samplerNodeId = samplerNodeId;
    const colorIndex = (typeof givenColorIndex === 'number' && givenColorIndex >= 0)
      ? (givenColorIndex % DATASET_BORDER_COLORS.length)
      : Math.floor(Math.random() * DATASET_BORDER_COLORS.length);
    node.dataset.datasetColorIndex = String(colorIndex);
    node.style.borderColor = DATASET_BORDER_COLORS[colorIndex];
    if (Array.isArray(headers) && Array.isArray(rows)) datasetContentByNodeId.set(nodeId, { headers: headers.slice(), rows: rows.map((r) => r.slice()) });
    const x = typeof left === 'number' ? left : 80 + (nodeCount % 5) * (280 + STAGGER);
    const y = typeof top === 'number' ? top : 80 + Math.floor(nodeCount / 5) * (120 + STAGGER);
    nodeCount += 1;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--dataset" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><rect x="1" y="1" width="12" height="12" rx="0.5"/><line x1="1" y1="4" x2="13" y2="4"/><line x1="1" y1="7" x2="13" y2="7"/><line x1="1" y1="10" x2="13" y2="10"/><line x1="4.5" y1="1" x2="4.5" y2="13"/><line x1="8" y1="1" x2="8" y2="13"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(title)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
      </div>
      <div class="workflow-node__body workflow-node__dataset-desc">${bodyText ? `<span class="workflow-node__note">${escapeHtml(bodyText)}</span>` : '<span class="workflow-node__note-placeholder">No description.</span>'}</div>
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void handleWorkflowNodeDeleteClick(nodeId, 'dataset', () => {
        removeConnectionsInvolvingNodeId(nodeId);
        datasetContentByNodeId.delete(nodeId);
        node.remove();
        updateContentSize();
        updateEdges();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      });
    });

    let dragStartX = 0, dragStartY = 0, nodeStartLeft = 0, nodeStartTop = 0;
    let lastInteractionWasDrag = false;
    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      lastInteractionWasDrag = false;
      const rect = node.getBoundingClientRect();
      const swRect = scrollWrapper.getBoundingClientRect();
      const sl = scrollWrapper.scrollLeft;
      const st = scrollWrapper.scrollTop;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartLeft = (rect.left - swRect.left + sl) / zoomLevel;
      nodeStartTop = (rect.top - swRect.top + st) / zoomLevel;
      node.classList.add('workflow-node--dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, { once: true });
    }
    function onPointerMove(e) {
      lastInteractionWasDrag = true;
      const dx = (e.clientX - dragStartX) / zoomLevel;
      const dy = (e.clientY - dragStartY) / zoomLevel;
      node.style.left = `${nodeStartLeft + dx}px`;
      node.style.top = `${nodeStartTop + dy}px`;
      updateEdges();
    }
    function onPointerUp() {
      node.classList.remove('workflow-node--dragging');
      document.removeEventListener('pointermove', onPointerMove);
      updateContentSize();
      updateEdges();
      if (lastInteractionWasDrag) document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
    node.addEventListener('pointerdown', onPointerDown);

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (lastInteractionWasDrag) return;
      e.preventDefault();
      e.stopPropagation();
      openDatasetDetailModal({
        node,
        getContent: () => datasetContentByNodeId.get(node.dataset.nodeId) || { headers: [], rows: [] },
        saveContent: (content) => {
          datasetContentByNodeId.set(node.dataset.nodeId, { headers: content.headers.slice(), rows: content.rows.map((r) => r.slice()) });
          document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
        },
      });
    });

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    return node;
  }

  function createRunNode({ left, top, nodeId: givenNodeId, title: givenTitle }) {
    const nodeId = givenNodeId || generateNodeId();
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--run workflow-node--no-body';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', 'Run node');
    node.dataset.nodeId = nodeId;
    node.dataset.nodeType = 'run';
    const runTitle = (givenTitle != null && givenTitle !== '') ? String(givenTitle) : 'Run';
    node.dataset.runName = runTitle;
    const x = typeof left === 'number' ? left : 80 + (nodeCount % 5) * (280 + STAGGER);
    const y = typeof top === 'number' ? top : 80 + Math.floor(nodeCount / 5) * (120 + STAGGER);
    nodeCount += 1;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--run" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 2v10l8-5-8-5z"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(runTitle)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
      </div>
      <div class="workflow-node__run-progress" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void handleWorkflowNodeDeleteClick(nodeId, 'run', () => {
        const runId = pendingRuns.get(nodeId);
        if (runId) {
          unregisterPendingRun(nodeId);
          fetch(`${RUN_API_BASE}/api/run/cancel/${runId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          }).catch(() => {});
        }
        removeConnectionsInvolvingNodeId(nodeId);
        node.remove();
        updateContentSize();
        updateEdges();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      });
    });

    let dragStartX = 0, dragStartY = 0, nodeStartLeft = 0, nodeStartTop = 0;
    let lastInteractionWasDrag = false;
    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      lastInteractionWasDrag = false;
      const rect = node.getBoundingClientRect();
      const swRect = scrollWrapper.getBoundingClientRect();
      const sl = scrollWrapper.scrollLeft;
      const st = scrollWrapper.scrollTop;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartLeft = (rect.left - swRect.left + sl) / zoomLevel;
      nodeStartTop = (rect.top - swRect.top + st) / zoomLevel;
      node.classList.add('workflow-node--dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, { once: true });
    }
    function onPointerMove(e) {
      lastInteractionWasDrag = true;
      const dx = (e.clientX - dragStartX) / zoomLevel;
      const dy = (e.clientY - dragStartY) / zoomLevel;
      node.style.left = `${nodeStartLeft + dx}px`;
      node.style.top = `${nodeStartTop + dy}px`;
      updateEdges();
    }
    function onPointerUp() {
      node.classList.remove('workflow-node--dragging');
      document.removeEventListener('pointermove', onPointerMove);
      updateContentSize();
      updateEdges();
      if (lastInteractionWasDrag) document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
    node.addEventListener('pointerdown', onPointerDown);

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (lastInteractionWasDrag) return;
      e.preventDefault();
      e.stopPropagation();
      const runNodeId = node.dataset.nodeId;
      const promptEdge = connections.find((c) => c.toId === runNodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN);
      let sections = [];
      if (promptEdge) {
        const promptNode = getNodeById(promptEdge.fromId);
        if (promptNode) {
          try {
            sections = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
          } catch (_) {}
        }
      }
      const promptInputFields = extractInputFieldsFromSections(Array.isArray(sections) ? sections : []);
      const workingSets = Array.from(nodesLayer.querySelectorAll('.workflow-node--dataset')).map((n) => {
        const id = n.dataset.nodeId || '';
        const content = datasetContentByNodeId.get(id);
        const colorIndex = n.dataset.datasetColorIndex != null ? parseInt(n.dataset.datasetColorIndex, 10) : 0;
        const color = DATASET_BORDER_COLORS[colorIndex % DATASET_BORDER_COLORS.length];
        return {
          nodeId: id,
          name: (n.dataset.datasetName || n.dataset.subsetName || '').trim() || 'Dataset',
          headers: content?.headers ? content.headers.slice() : [],
          color,
        };
      });
      const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
      function getSubsetContent(nodeId) {
        const c = datasetContentByNodeId.get(nodeId);
        return c ? { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) } : { headers: [], rows: [] };
      }
      function getPromptTemplate() {
        if (!promptNode) return { sections: [], outputSchema: { return_shape: 'single', fields: [] } };
        let sec = [];
        try {
          sec = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
        } catch (_) {}
        let fields = [];
        try {
          fields = JSON.parse(promptNode.dataset.promptOutputFormat || '[]');
        } catch (_) {}
        const returnShape = promptNode.dataset.promptOutputReturnShape || 'single';
        return { sections: sec, outputSchema: { return_shape: returnShape, fields } };
      }
      openRunDetailModal({
        node,
        getWorkingSets: () => workingSets,
        getPromptInputFields: () => promptInputFields,
        getSubsetContent,
        getPromptTemplate,
        registerPendingRun,
        unregisterPendingRun,
        getPendingRunId: () => pendingRuns.get(node.dataset.nodeId) || null,
        getPromptName: () => {
          if (!promptNode) return '';
          return (promptNode.dataset.promptName || '').trim() || (promptNode.querySelector('.workflow-node__title')?.textContent?.trim() || '');
        },
        getUniqueDatasetExportName: findUniqueDatasetExportName,
        isRunNameAlreadyUsedForPrompt,
        getRunMappingsFromCanvas: () => Array.from(nodesLayer.querySelectorAll('.workflow-node--run')).map((n) => {
          try {
            const raw = n.dataset.runInputToColumn;
            if (!raw) return null;
            const o = JSON.parse(raw);
            return typeof o === 'object' && o !== null ? o : null;
          } catch (_) { return null; }
        }).filter(Boolean),
      });
    });

    return node;
  }

  function createScoreNode({ left, top, nodeId: givenNodeId, title: givenTitle }) {
    const nodeId = givenNodeId || generateNodeId();
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--score workflow-node--no-body';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', 'Score node');
    node.dataset.nodeId = nodeId;
    node.dataset.nodeType = 'score';
    const scoreTitle = (givenTitle != null && givenTitle !== '') ? String(givenTitle) : 'Score';
    const x = typeof left === 'number' ? left : 80 + (nodeCount % 5) * (280 + STAGGER);
    const y = typeof top === 'number' ? top : 80 + Math.floor(nodeCount / 5) * (120 + STAGGER);
    nodeCount += 1;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--score" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8v4M6 5v7M9 3v9M12 6v6"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(scoreTitle)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
      </div>
      <div class="workflow-node__score-progress" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void handleWorkflowNodeDeleteClick(nodeId, 'score', () => {
        removeConnectionsInvolvingNodeId(nodeId);
        node.remove();
        updateContentSize();
        updateEdges();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      });
    });

    let dragStartX = 0, dragStartY = 0, nodeStartLeft = 0, nodeStartTop = 0;
    let lastInteractionWasDrag = false;
    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      lastInteractionWasDrag = false;
      const rect = node.getBoundingClientRect();
      const swRect = scrollWrapper.getBoundingClientRect();
      const sl = scrollWrapper.scrollLeft;
      const st = scrollWrapper.scrollTop;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartLeft = (rect.left - swRect.left + sl) / zoomLevel;
      nodeStartTop = (rect.top - swRect.top + st) / zoomLevel;
      node.classList.add('workflow-node--dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, { once: true });
    }
    function onPointerMove(e) {
      lastInteractionWasDrag = true;
      const dx = (e.clientX - dragStartX) / zoomLevel;
      const dy = (e.clientY - dragStartY) / zoomLevel;
      node.style.left = `${nodeStartLeft + dx}px`;
      node.style.top = `${nodeStartTop + dy}px`;
      updateEdges();
    }
    function onPointerUp() {
      node.classList.remove('workflow-node--dragging');
      document.removeEventListener('pointermove', onPointerMove);
      updateContentSize();
      updateEdges();
      if (lastInteractionWasDrag) document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
    node.addEventListener('pointerdown', onPointerDown);

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (lastInteractionWasDrag) return;
      e.preventDefault();
      e.stopPropagation();
      const workingSets = Array.from(nodesLayer.querySelectorAll('.workflow-node--dataset')).map((n) => {
        const id = n.dataset.nodeId || '';
        const content = datasetContentByNodeId.get(id);
        const colorIndex = n.dataset.datasetColorIndex != null ? parseInt(n.dataset.datasetColorIndex, 10) : 0;
        const color = DATASET_BORDER_COLORS[colorIndex % DATASET_BORDER_COLORS.length];
        return {
          nodeId: id,
          name: (n.dataset.datasetName || n.dataset.subsetName || '').trim() || 'Dataset',
          headers: content?.headers ? content.headers.slice() : [],
          color,
        };
      });
      const runEdge = connections.find((c) => c.toId === node.dataset.nodeId && c.type === EDGE_TYPE_RUN_TO_SCORE);
      const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
      const promptEdge = runNode ? connections.find((c) => c.toId === runNode.dataset.nodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN) : null;
      const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
      function getRunResultColumns() {
        if (!runNode) return [];
        const cols = [];
        cols.push({ key: '#', label: '#' });
        let results = [];
        try {
          results = JSON.parse(runNode.dataset.runResults || '[]');
          if (!Array.isArray(results)) results = [];
        } catch (_) {}
        let schemaFields = [];
        if (promptNode) {
          try {
            const raw = promptNode.dataset.promptOutputFormat || '[]';
            schemaFields = JSON.parse(raw);
            if (!Array.isArray(schemaFields)) schemaFields = [];
          } catch (_) {}
        }
        const outputFields = deriveOutputFields(results, schemaFields);
        outputFields.forEach((f) => cols.push({ key: f.key || '', label: (f.display || f.key || '').trim() || f.key || '—' }));
        const wsId = (runNode.dataset.runWorkingSetId || '').trim();
        const wsContent = wsId ? datasetContentByNodeId.get(wsId) : null;
        const wsHeaders = (wsContent && wsContent.headers) ? wsContent.headers.slice() : [];
        cols.push({ key: '[#]', label: 'Input: #' });
        wsHeaders.forEach((h) => {
          const headerText = String(h ?? '').trim() || ' ';
          cols.push({ key: `[${headerText}]`, label: `Input: ${headerText}` });
        });
        return cols;
      }
      function getGroundTruthHeaders(wsNodeId) {
        const c = datasetContentByNodeId.get(wsNodeId || '');
        return (c && c.headers) ? c.headers.slice() : [];
      }
      function getRunResults() {
        if (!runNode) return { results: [], outputFields: [] };
        let results = [];
        try {
          results = JSON.parse(runNode.dataset.runResults || '[]');
          if (!Array.isArray(results)) results = [];
        } catch (_) {}
        let schemaFields = [];
        if (promptNode) {
          try {
            const raw = promptNode.dataset.promptOutputFormat || '[]';
            schemaFields = JSON.parse(raw);
            if (!Array.isArray(schemaFields)) schemaFields = [];
          } catch (_) {}
        }
        const outputFields = deriveOutputFields(results, schemaFields);
        return { results, outputFields };
      }
      function getRunWorkingSetContent() {
        const wsId = (runNode && runNode.dataset.runWorkingSetId) ? runNode.dataset.runWorkingSetId.trim() : '';
        const c = wsId ? datasetContentByNodeId.get(wsId) : null;
        return c ? { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) } : { headers: [], rows: [] };
      }
      function getGroundTruthContent(wsNodeId) {
        const c = datasetContentByNodeId.get(wsNodeId || '');
        if (!c) return { headers: [], rows: [] };
        return { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) };
      }
      async function getReviewPayload() {
        if (!promptNode || !runNode || !node) return null;
        let sections = [];
        try {
          sections = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
        } catch (_) {}
        if (!Array.isArray(sections) || sections.length === 0) return null;
        const promptFullText = sections.map((s) => `## ${(s.name || '').trim() || '(unnamed)'}\n\n${(s.content || '').trim()}`).join('\n\n');
        let runResults = [];
        try {
          runResults = JSON.parse(runNode.dataset.runResults || '[]');
          if (!Array.isArray(runResults)) runResults = [];
        } catch (_) {}
        let schemaFields = [];
        try {
          const raw = promptNode.dataset.promptOutputFormat || '[]';
          schemaFields = JSON.parse(raw);
          if (!Array.isArray(schemaFields)) schemaFields = [];
        } catch (_) {}
        const outputFields = deriveOutputFields(runResults, schemaFields);
        let output_schema = null;
        try {
          const raw = JSON.parse(promptNode.dataset.promptOutputFormat || '[]');
          const fields = (Array.isArray(raw) ? raw : []).map((o) => ({
            key: o.key || '',
            type: o.type || 'str',
            description: o.description,
            allow_none: o.allowNone === true || o.allow_none === true,
          })).filter((f) => (f.key || '').trim());
          if (fields.length > 0) {
            output_schema = {
              return_shape: promptNode.dataset.promptOutputReturnShape || 'single',
              fields,
            };
          }
        } catch (_) {}
        const comparison_rows = await buildReviewComparisonRows(node, runNode, datasetContentByNodeId, sections);
        return {
          prompt_sections: sections,
          prompt_full_text: promptFullText,
          run_results: runResults,
          output_fields: outputFields,
          output_schema,
          comparison_rows,
        };
      }
      openScoreDetailModal({
        node,
        getWorkingSets: () => workingSets,
        getRunResultColumns,
        getGroundTruthHeaders,
        getRunResults,
        getRunWorkingSetContent,
        getGroundTruthContent,
        getReviewPayload,
        getScoreMappingsFromCanvas: () => Array.from(nodesLayer.querySelectorAll('.workflow-node--score')).map((n) => n.dataset.scoreMapping || '[]'),
      });
    });

    return node;
  }

  function createPromptReviewNode({ left, top, nodeId: givenNodeId, title: givenTitle }) {
    const nodeId = givenNodeId || generateNodeId();
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--prompt-review workflow-node--no-body';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', 'Review node');
    node.dataset.nodeId = nodeId;
    node.dataset.nodeType = 'promptReview';
    const promptReviewTitle = (givenTitle != null && givenTitle !== '') ? String(givenTitle) : 'Review';
    const x = typeof left === 'number' ? left : 80 + (nodeCount % 5) * (280 + STAGGER);
    const y = typeof top === 'number' ? top : 80 + Math.floor(nodeCount / 5) * (120 + STAGGER);
    nodeCount += 1;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--prompt-review" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="10" height="10" rx="1"/><path d="M4 7l2.5 2.5L10 4"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(promptReviewTitle)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
      </div>
      <div class="workflow-node__review-progress" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void handleWorkflowNodeDeleteClick(nodeId, 'promptReview', () => {
        const reviewId = pendingReviews.get(nodeId);
        if (reviewId) {
          unregisterPendingReview(nodeId);
          fetch(`${RUN_API_BASE}/api/review/cancel/${reviewId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          }).catch(() => {});
        } else {
          fetch(`${RUN_API_BASE}/api/review/cancel/by-node/${encodeURIComponent(nodeId)}`, { method: 'POST' }).catch(() => {});
        }
        pendingReviewNodeIds.delete(nodeId);
        removeConnectionsInvolvingNodeId(nodeId);
        node.remove();
        updateContentSize();
        updateEdges();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      });
    });

    let dragStartX = 0, dragStartY = 0, nodeStartLeft = 0, nodeStartTop = 0;
    let lastInteractionWasDrag = false;
    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      lastInteractionWasDrag = false;
      const rect = node.getBoundingClientRect();
      const swRect = scrollWrapper.getBoundingClientRect();
      const sl = scrollWrapper.scrollLeft;
      const st = scrollWrapper.scrollTop;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartLeft = (rect.left - swRect.left + sl) / zoomLevel;
      nodeStartTop = (rect.top - swRect.top + st) / zoomLevel;
      node.classList.add('workflow-node--dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, { once: true });
    }
    function onPointerMove(e) {
      lastInteractionWasDrag = true;
      const dx = (e.clientX - dragStartX) / zoomLevel;
      const dy = (e.clientY - dragStartY) / zoomLevel;
      node.style.left = `${nodeStartLeft + dx}px`;
      node.style.top = `${nodeStartTop + dy}px`;
      updateEdges();
    }
    function onPointerUp() {
      node.classList.remove('workflow-node--dragging');
      document.removeEventListener('pointermove', onPointerMove);
      updateContentSize();
      updateEdges();
      if (lastInteractionWasDrag) document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
    node.addEventListener('pointerdown', onPointerDown);

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (lastInteractionWasDrag) return;
      e.preventDefault();
      e.stopPropagation();
      const scoreEdge = connections.find((c) => c.toId === node.dataset.nodeId && c.type === EDGE_TYPE_SCORE_TO_PROMPT_REVIEW);
      const scoreNode = scoreEdge ? getNodeById(scoreEdge.fromId) : null;
      const runEdge = scoreNode ? connections.find((c) => c.toId === scoreNode.dataset.nodeId && c.type === EDGE_TYPE_RUN_TO_SCORE) : null;
      const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
      const promptEdge = runNode ? connections.find((c) => c.toId === runNode.dataset.nodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN) : null;
      const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
      async function getPayload() {
        if (!promptNode || !runNode || !scoreNode) return null;
        let sections = [];
        try {
          sections = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
        } catch (_) {}
        if (!Array.isArray(sections) || sections.length === 0) return null;
        const promptFullText = sections.map((s) => `## ${(s.name || '').trim() || '(unnamed)'}\n\n${(s.content || '').trim()}`).join('\n\n');
        let runResults = [];
        let outputFields = [];
        try {
          runResults = JSON.parse(runNode.dataset.runResults || '[]');
          outputFields = JSON.parse(runNode.dataset.runOutputFields || '[]');
        } catch (_) {}
        const comparison_rows = await buildReviewComparisonRows(scoreNode, runNode, datasetContentByNodeId, sections);
        let output_schema = null;
        try {
          const raw = promptNode.dataset.promptOutputFormat || '[]';
          const fields = (Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : []).map((o) => ({
            key: o.key || '',
            type: o.type || 'str',
            description: o.description,
            allow_none: o.allowNone === true || o.allow_none === true,
          })).filter((f) => (f.key || '').trim());
          if (fields.length > 0) {
            output_schema = { return_shape: promptNode.dataset.promptOutputReturnShape || 'single', fields };
          }
        } catch (_) {}
        const runWsId = (runNode.dataset.runWorkingSetId || '').trim();
        const gtId = (scoreNode.dataset.scoreGroundTruthId || '').trim();
        let run_input_to_column = {};
        try {
          const raw = runNode.dataset.runInputToColumn || '{}';
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') run_input_to_column = parsed;
        } catch (_) {}
        const run_credential_id = await resolveRunCredentialId(runNode);
        return {
          prompt_sections: sections,
          prompt_full_text: promptFullText,
          run_results: runResults,
          output_fields: outputFields,
          comparison_rows,
          output_schema,
          score_mapping: scoreNode.dataset.scoreMapping || '[]',
          run_credential_id,
          run_input_to_column,
          getRunWorkingSetContent: () => runWsId ? (datasetContentByNodeId.get(runWsId) || { headers: [], rows: [] }) : { headers: [], rows: [] },
          getGroundTruthContent: () => gtId ? (datasetContentByNodeId.get(gtId) || { headers: [], rows: [] }) : { headers: [], rows: [] },
        };
      }
      function getReviewResult() {
        try {
          let raw = (node.dataset.reviewResult || '').trim();
          if (!raw && scoreNode && (scoreNode.dataset.reviewResult || '').trim()) {
            raw = scoreNode.dataset.reviewResult || '';
            node.dataset.reviewResult = raw;
            document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
          }
          if (!raw) return null;
          return JSON.parse(raw);
        } catch (_) { return null; }
      }
      function updateReviewResult(updated) {
        try {
          node.dataset.reviewResult = JSON.stringify(updated);
          document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
        } catch (e) {
          console.error('reviewResult save failed', e);
          showAlert(String(e?.message || e || 'Could not save review data.'), { title: 'Save error' });
        }
      }
      function onExportNewPrompt(sections) {
        document.dispatchEvent(new CustomEvent('workflow:add-prompt-from-review', {
          detail: { sections, afterReviewNodeId: node.dataset.nodeId },
        }));
      }
      openReviewDetailModal({
        node,
        getPayload,
        getReviewResult,
        updateReviewResult,
        onExportNewPrompt,
        getIsReviewStreaming: () => pendingReviewNodeIds.has(node.dataset.nodeId),
      });
    });

    return node;
  }

  function removeConnectionsInvolvingNodeId(id) {
    connections = connections.filter((c) => c.fromId !== id && c.toId !== id);
  }

  /**
   * Given current dataset name, return a unique name for a new version.
   * Only strips trailing " vN" to get version base; never strips " (Copy N)".
   * So: "MySet v2" -> "MySet v3"; "MySet (Copy 1)" -> "MySet (Copy 1) v2".
   * Scans all subset nodes (including current) so version number always increments.
   * @param {string} baseName - current subset name
   * @param {string} [excludeNodeId] - unused; we count all nodes to get next version
   * @returns {string}
   */
  function findNextWorkingDatasetVersionName(baseName, excludeNodeId) {
    const raw = (baseName || 'Dataset').trim() || 'Dataset';
    const versionBase = stripVersionSuffixOnly(raw).trim() || 'Dataset';
    const datasetNodes = nodesLayer.querySelectorAll('.workflow-node--dataset');
    let nextV = 2;
    const versionPrefix = versionBase + ' v';
    for (const n of datasetNodes) {
      const name = (n.dataset.datasetName || n.dataset.subsetName || '').trim();
      const nBase = stripVersionSuffixOnly(name).trim();
      if (nBase !== versionBase) continue;
      if (name === versionBase) {
        nextV = Math.max(nextV, 2);
        continue;
      }
      if (!name.startsWith(versionPrefix)) continue;
      const numStr = name.slice(versionPrefix.length).trim();
      if (!/^\d+$/.test(numStr)) continue;
      const num = parseInt(numStr, 10);
      if (Number.isFinite(num) && num >= 1) nextV = Math.max(nextV, num + 1);
    }
    return `${versionBase} v${nextV}`;
  }

  function showNodeContextMenu(clientX, clientY, node) {
    const existing = document.querySelector('.workflow-node-context-menu');
    if (existing) existing.remove();

    const isDataset = node.dataset.nodeType === 'dataset';
    const isSampler = node.dataset.nodeType === 'sampler';
    const isRun = node.dataset.nodeType === 'run';
    const isScore = node.dataset.nodeType === 'score';
    const isPromptReview = node.dataset.nodeType === 'promptReview';
    let runHasResults = false;
    if (isRun) {
      try {
        const rr = JSON.parse(node.dataset.runResults || '[]');
        runHasResults = Array.isArray(rr) && rr.length > 0;
      } catch (_) {}
    }
    let scoreHasResults = false;
    let scoreHasReviewLlm = false;
    if (isScore) {
      const runEdge = connections.find((c) => c.toId === node.dataset.nodeId && c.type === EDGE_TYPE_RUN_TO_SCORE);
      const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
      if (runNode) {
        try {
          const rr = JSON.parse(runNode.dataset.runResults || '[]');
          scoreHasResults = Array.isArray(rr) && rr.length > 0;
        } catch (_) {}
      }
      scoreHasReviewLlm = (node.dataset.reviewCredentialId || '').trim() !== '';
    }
    let reviewHasResult = false;
    if (isPromptReview) {
      try {
        const raw = (node.dataset.reviewResult || '').trim();
        if (raw) {
          const data = JSON.parse(raw);
          const isComplete = data?.streamComplete === true;
          const sections = Array.isArray(data?.workingSections) ? data.workingSections : (Array.isArray(data?.promptSections) ? data.promptSections : []);
          reviewHasResult = isComplete && sections.length > 0;
        }
      } catch (_) {}
    }

    const menu = document.createElement('div');
    menu.className = 'workflow-node-context-menu';
    menu.setAttribute('role', 'menu');
    if (isRun) {
      menu.innerHTML = `
        <button type="button" class="workflow-node-context-item workflow-node-context-item--score" data-action="save-to-workspace-and-score" role="menuitem" ${runHasResults ? '' : 'disabled'}>Score</button>
        <button type="button" class="workflow-node-context-item" data-action="save-results-to-workspace" role="menuitem" ${runHasResults ? '' : 'disabled'}>Save results to workspace</button>
        <button type="button" class="workflow-node-context-item" data-action="edit-run-name" role="menuitem">Edit name</button>
      `;
    } else if (isScore) {
      const scoreHasGt = (node.dataset.scoreGroundTruthId || '').trim() !== '';
      const canSaveToWorkspace = scoreHasResults && scoreHasGt;
      menu.innerHTML = `
        <button type="button" class="workflow-node-context-item workflow-node-context-item--review" data-action="score-add-review" role="menuitem" ${scoreHasReviewLlm && scoreHasResults && scoreHasGt ? '' : 'disabled'}>Review</button>
        <button type="button" class="workflow-node-context-item" data-action="score-save-to-workspace" role="menuitem" ${canSaveToWorkspace ? '' : 'disabled'}>Save results to workspace</button>
        <button type="button" class="workflow-node-context-item" data-action="edit-score-name" role="menuitem">Edit name</button>
      `;
    } else if (isPromptReview) {
      menu.innerHTML = `
        <button type="button" class="workflow-node-context-item workflow-node-context-item--export" data-action="review-export" role="menuitem" ${reviewHasResult ? '' : 'disabled'}>Apply</button>
        <button type="button" class="workflow-node-context-item" data-action="edit-review-name" role="menuitem">Edit name</button>
      `;
    } else if (isDataset) {
      menu.innerHTML = `
        <button type="button" class="workflow-node-context-item workflow-node-context-item--sample" data-action="add-sampler" role="menuitem">Sample</button>
        <button type="button" class="workflow-node-context-item" data-action="duplicate-working-dataset" role="menuitem">Duplicate this dataset</button>
        <button type="button" class="workflow-node-context-item" data-action="add-version-of-dataset" role="menuitem">Add new version of this dataset</button>
        <button type="button" class="workflow-node-context-item" data-action="edit-dataset-name-description" role="menuitem">Edit name & description</button>
      `;
    } else if (isSampler) {
      menu.innerHTML = `
        <button type="button" class="workflow-node-context-item" data-action="create-working-dataset" role="menuitem">Create sample</button>
        <button type="button" class="workflow-node-context-item" data-action="edit-sampler-name" role="menuitem">Edit name</button>
      `;
    } else {
      menu.innerHTML = `
        <button type="button" class="workflow-node-context-item workflow-node-context-item--run" data-action="run-this-prompt" role="menuitem">Run</button>
        <button type="button" class="workflow-node-context-item" data-action="duplicate" role="menuitem">Duplicate this prompt</button>
        <button type="button" class="workflow-node-context-item" data-action="new-version" role="menuitem">Add new version of this prompt</button>
        <button type="button" class="workflow-node-context-item" data-action="edit-name-description" role="menuitem">Edit name & description</button>
      `;
    }

    function duplicateNode(isNewVersion = false) {
      const left = parseFloat(node.style.left) || 0;
      const top = parseFloat(node.style.top) || 0;
      const width = node.offsetWidth || 280;
      const height = node.offsetHeight || 80;
      let sections = [];
      let outputFormat = { returnShape: 'single', fields: [] };
      try {
        sections = JSON.parse(node.dataset.promptSections || node.dataset.promptFields || '[]');
      } catch (_) {}
      try {
        const raw = JSON.parse(node.dataset.promptOutputFormat || '[]');
        const fields = (Array.isArray(raw) ? raw : []).map((o) => ({ key: o.key || '', type: o.type || 'str', description: o.description ?? '', examples: o.examples || [], allowNone: o.allowNone === true }));
        outputFormat = { returnShape: node.dataset.promptOutputReturnShape || 'single', fields };
      } catch (_) {}
      const uniqueName = findUniquePromptName(node.dataset.promptName || '', isNewVersion);
      const newNode = createPromptNode({
        name: uniqueName,
        note: node.dataset.promptNote || '',
        sections: Array.isArray(sections) ? sections : [],
        outputFormat,
        left: isNewVersion ? left + width + NEW_NODE_OFFSET : left,
        top: isNewVersion ? top : top + height + NEW_NODE_OFFSET,
      });
      updateContentSize();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      return newNode;
    }

    const actions = {
      'save-results-to-workspace': () => {
        if (node.dataset.nodeType !== 'run') return;
        let results = [];
        let outputFields = [];
        try {
          results = JSON.parse(node.dataset.runResults || '[]');
          outputFields = JSON.parse(node.dataset.runOutputFields || '[]');
        } catch (_) {}
        if (!Array.isArray(results) || results.length === 0) return;
        if (!Array.isArray(outputFields)) outputFields = [];
        const runName = (node.querySelector('.workflow-node__title')?.textContent || '').trim() || 'Run';
        const promptEdge = connections.find((c) => c.toId === node.dataset.nodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN);
        const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
        const promptName = (promptNode?.dataset?.promptName || promptNode?.querySelector('.workflow-node__title')?.textContent || '').trim() || 'Prompt';
        const baseName = `${promptName} ${runName}`.trim();
        const datasetName = findUniqueDatasetExportName(baseName);
        const runCompleted = node.dataset.runCompleted === '1';
        const statusLine = runCompleted ? 'Run completed.' : 'Run incomplete.';
        const description = `Exported from ${promptName} ${runName}.\n${statusLine}`;
        const headers = outputFields.map((f) => ((f && (f.display || f.key)) ? String(f.display || f.key).trim() || 'output' : 'output'));
        const rows = results.map((r) =>
          r.error
            ? outputFields.map(() => String(r.error))
            : (outputFields || []).map((f) => {
                const val = r.output && f && r.output[f.key];
                if (val === null || val === undefined) return '—';
                if (Array.isArray(val)) return val.join(', ');
                return String(val);
              })
        );
        document.dispatchEvent(
          new CustomEvent('workflow:add-dataset-node', {
            detail: { name: datasetName, notes: description, headers, rows },
          })
        );
      },
      'save-to-workspace-and-score': () => {
        if (node.dataset.nodeType !== 'run') return;
        document.dispatchEvent(new CustomEvent('workflow:add-score-node', { detail: { runNodeId: node.dataset.nodeId } }));
      },
      'score-add-review': async () => {
        if (node.dataset.nodeType !== 'score') return;
        const scoreNode = node;
        const workingSets = Array.from(nodesLayer.querySelectorAll('.workflow-node--dataset')).map((n) => {
          const id = n.dataset.nodeId || '';
          const content = datasetContentByNodeId.get(id);
          const colorIndex = n.dataset.datasetColorIndex != null ? parseInt(n.dataset.datasetColorIndex, 10) : 0;
          const color = DATASET_BORDER_COLORS[colorIndex % DATASET_BORDER_COLORS.length];
          return {
            nodeId: id,
            name: (n.dataset.datasetName || n.dataset.subsetName || '').trim() || 'Dataset',
            headers: content?.headers ? content.headers.slice() : [],
            color,
          };
        });
        const runEdge = connections.find((c) => c.toId === scoreNode.dataset.nodeId && c.type === EDGE_TYPE_RUN_TO_SCORE);
        const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
        const promptEdge = runNode ? connections.find((c) => c.toId === runNode.dataset.nodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN) : null;
        const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
        function getRunResultColumns() {
          if (!runNode) return [];
          const cols = [];
          cols.push({ key: '#', label: '#' });
          let outputFields = [];
          try {
            const raw = runNode.dataset.runOutputFields || '[]';
            const arr = JSON.parse(raw);
            outputFields = Array.isArray(arr) ? arr : [];
          } catch (_) {}
          outputFields.forEach((f) => cols.push({ key: f.key || '', label: (f.display || f.key || '').trim() || f.key || '—' }));
          const wsId = (runNode.dataset.runWorkingSetId || '').trim();
          const wsContent = wsId ? datasetContentByNodeId.get(wsId) : null;
          const wsHeaders = (wsContent && wsContent.headers) ? wsContent.headers.slice() : [];
          cols.push({ key: '[#]', label: 'Input: #' });
          wsHeaders.forEach((h) => {
            const headerText = String(h ?? '').trim() || ' ';
            cols.push({ key: `[${headerText}]`, label: `Input: ${headerText}` });
          });
          return cols;
        }
        function getGroundTruthHeaders(wsNodeId) {
          const c = datasetContentByNodeId.get(wsNodeId || '');
          return (c && c.headers) ? c.headers.slice() : [];
        }
        function getRunResults() {
          if (!runNode) return { results: [], outputFields: [] };
          let results = [];
          let outputFields = [];
          try {
            results = JSON.parse(runNode.dataset.runResults || '[]');
            outputFields = JSON.parse(runNode.dataset.runOutputFields || '[]');
          } catch (_) {}
          return { results: Array.isArray(results) ? results : [], outputFields: Array.isArray(outputFields) ? outputFields : [] };
        }
        function getRunWorkingSetContent() {
          const wsId = (runNode && runNode.dataset.runWorkingSetId) ? runNode.dataset.runWorkingSetId.trim() : '';
          const c = wsId ? datasetContentByNodeId.get(wsId) : null;
          return c ? { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) } : { headers: [], rows: [] };
        }
        function getGroundTruthContent(wsNodeId) {
          const c = datasetContentByNodeId.get(wsNodeId || '');
          if (!c) return { headers: [], rows: [] };
          return { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) };
        }
        async function getReviewPayload() {
          if (!promptNode || !runNode || !scoreNode) return null;
          let sections = [];
          try {
            sections = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
          } catch (_) {}
          if (!Array.isArray(sections) || sections.length === 0) return null;
          const promptFullText = sections.map((s) => `## ${(s.name || '').trim() || '(unnamed)'}\n\n${(s.content || '').trim()}`).join('\n\n');
          let runResults = [];
          let outputFields = [];
          try {
            runResults = JSON.parse(runNode.dataset.runResults || '[]');
            outputFields = JSON.parse(runNode.dataset.runOutputFields || '[]');
          } catch (_) {}
          let output_schema = null;
          try {
            const raw = JSON.parse(promptNode.dataset.promptOutputFormat || '[]');
            const fields = (Array.isArray(raw) ? raw : []).map((o) => ({
              key: o.key || '',
              type: o.type || 'str',
              description: o.description,
              allow_none: o.allowNone === true || o.allow_none === true,
            })).filter((f) => (f.key || '').trim());
            if (fields.length > 0) {
              output_schema = {
                return_shape: promptNode.dataset.promptOutputReturnShape || 'single',
                fields,
              };
            }
          } catch (_) {}
          const comparison_rows = await buildReviewComparisonRows(scoreNode, runNode, datasetContentByNodeId, sections);
          return {
            prompt_sections: sections,
            prompt_full_text: promptFullText,
            run_results: runResults,
            output_fields: outputFields,
            output_schema,
            comparison_rows,
          };
        }
        await openReviewSelectionPreviewModal({ getReviewPayload });
      },
      'add-sampler': () => {
        if (node.dataset.nodeType !== 'dataset') return;
        const sourceNodeId = node.dataset.nodeId || '';
        const left = (parseFloat(node.style.left) || 0) + (node.offsetWidth || 280) + NEW_NODE_OFFSET;
        const top = parseFloat(node.style.top) || 0;
        const newNode = createSamplerNode({
          name: 'Sample',
          notes: '',
          left,
          top,
          sourceNodeId,
          samplingType: 'without-replacement',
          sampleSizeType: 'ratio',
          sampleSize: 100,
        });
        if (newNode?.dataset?.nodeId) {
          connections.push({
            fromId: sourceNodeId,
            toId: newNode.dataset.nodeId,
            type: EDGE_TYPE_DATASET_TO_SAMPLER,
          });
          updateEdges();
        }
        updateContentSize();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      },
      'create-working-dataset': () => {
        const samplerNodeId = node.dataset.nodeId || '';
        document.dispatchEvent(new CustomEvent('workflow:add-dataset-node', { detail: { samplerNodeId } }));
      },
      'run-this-prompt': () => {
        const left = parseFloat(node.style.left) || 0;
        const top = parseFloat(node.style.top) || 0;
        const width = node.offsetWidth || 280;
        const runNode = createRunNode({
          left: left + width + NEW_NODE_OFFSET,
          top,
          title: 'Run',
        });
        if (runNode?.dataset?.nodeId) {
          connections.push({
            fromId: node.dataset.nodeId,
            toId: runNode.dataset.nodeId,
            type: EDGE_TYPE_PROMPT_TO_RUN,
          });
          updateEdges();
        }
        updateContentSize();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      },
      duplicate: () => {
        const newNode = duplicateNode(false);
        if (newNode) {
          connections.filter((c) => c.toId === node.dataset.nodeId).forEach((c) => {
            connections.push({ fromId: c.fromId, toId: newNode.dataset.nodeId, type: c.type });
          });
          updateEdges();
          document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
        }
      },
      'new-version': () => {
        const newNode = duplicateNode(true);
        if (newNode) {
          connections.push({
            fromId: node.dataset.nodeId,
            toId: newNode.dataset.nodeId,
            type: EDGE_TYPE_PROMPT_TO_PROMPT,
          });
          updateEdges();
          document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
        }
      },
      'edit-name-description': () => {
        openEditPromptNameModal(node);
      },
      'edit-dataset-name-description': () => {
        openEditDatasetNameModal(node);
      },
      'edit-run-name': () => {
        if (node.dataset.nodeType !== 'run') return;
        openEditNodeNameModal(node, {
          modalTitle: 'Edit Run name',
          fieldLabel: 'Run name',
          placeholder: 'Run',
          getCurrentName: () => (node.dataset.runName || node.querySelector('.workflow-node__title')?.textContent || '').trim() || 'Run',
          onSave: (name) => {
            node.dataset.runName = name;
            const titleEl = node.querySelector('.workflow-node__title');
            if (titleEl) titleEl.textContent = name;
          },
        });
      },
      'edit-score-name': () => {
        if (node.dataset.nodeType !== 'score') return;
        openEditNodeNameModal(node, {
          modalTitle: 'Edit Scorecard name',
          fieldLabel: 'Scorecard name',
          placeholder: 'Score',
          getCurrentName: () => (node.querySelector('.workflow-node__title')?.textContent || '').trim() || 'Score',
          onSave: (name) => {
            const titleEl = node.querySelector('.workflow-node__title');
            if (titleEl) titleEl.textContent = name;
          },
        });
      },
      'score-save-to-workspace': async () => {
        if (node.dataset.nodeType !== 'score') return;
        const scoreNode = node;
        const runEdge = connections.find((c) => c.toId === scoreNode.dataset.nodeId && c.type === EDGE_TYPE_RUN_TO_SCORE);
        const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
        function getRunResults() {
          if (!runNode) return { results: [], outputFields: [] };
          let results = [];
          let outputFields = [];
          try {
            results = JSON.parse(runNode.dataset.runResults || '[]');
            outputFields = JSON.parse(runNode.dataset.runOutputFields || '[]');
          } catch (_) {}
          return { results: Array.isArray(results) ? results : [], outputFields: Array.isArray(outputFields) ? outputFields : [] };
        }
        function getRunWorkingSetContent() {
          const wsId = (runNode && runNode.dataset.runWorkingSetId) ? runNode.dataset.runWorkingSetId.trim() : '';
          const c = wsId ? datasetContentByNodeId.get(wsId) : null;
          return c ? { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) } : { headers: [], rows: [] };
        }
        function getGroundTruthContent(wsNodeId) {
          const c = datasetContentByNodeId.get(wsNodeId || '');
          if (!c) return { headers: [], rows: [] };
          return { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) };
        }
        function getGroundTruthHeaders(wsNodeId) {
          const c = datasetContentByNodeId.get(wsNodeId || '');
          return (c && c.headers) ? c.headers.slice() : [];
        }
        function getRunResultColumns() {
          if (!runNode) return [];
          const cols = [];
          cols.push({ key: '#', label: '#' });
          let outputFields = [];
          try {
            const raw = runNode.dataset.runOutputFields || '[]';
            const arr = JSON.parse(raw);
            outputFields = Array.isArray(arr) ? arr : [];
          } catch (_) {}
          outputFields.forEach((f) => cols.push({ key: f.key || '', label: (f.display || f.key || '').trim() || f.key || '—' }));
          const wsId = (runNode.dataset.runWorkingSetId || '').trim();
          const wsContent = wsId ? datasetContentByNodeId.get(wsId) : null;
          const wsHeaders = (wsContent && wsContent.headers) ? wsContent.headers.slice() : [];
          cols.push({ key: '[#]', label: 'Input: #' });
          wsHeaders.forEach((h) => cols.push({ key: `[${h}]`, label: `Input: ${h}` }));
          return cols;
        }
        const payload = await getScoreExportData({
          node: scoreNode,
          getRunResults,
          getRunWorkingSetContent,
          getGroundTruthContent,
          getGroundTruthHeaders,
          getRunResultColumns,
        });
        if (!payload || !payload.headers || !payload.rows) return;
        const scoreName = (scoreNode.querySelector('.workflow-node__title')?.textContent || '').trim() || 'Score';
        const datasetName = findUniqueDatasetExportName(scoreName + ' comparison');
        const notes = `Exported from Score "${scoreName}". Run vs ground truth comparison.`;
        document.dispatchEvent(new CustomEvent('workflow:add-dataset-node', {
          detail: { name: datasetName, notes, headers: payload.headers, rows: payload.rows },
        }));
      },
      'review-export': () => {
        if (node.dataset.nodeType !== 'promptReview') return;
        try {
          const raw = (node.dataset.reviewResult || '').trim();
          if (!raw) return;
          const data = JSON.parse(raw);
          const sections = Array.isArray(data.workingSections) && data.workingSections.length > 0
            ? data.workingSections.map((s) => ({ name: s.name || '', content: s.content || '' }))
            : (Array.isArray(data.promptSections) ? data.promptSections : []).map((s) => ({ name: s.name || '', content: s.content || '' }));
          if (sections.length === 0) return;
          document.dispatchEvent(new CustomEvent('workflow:add-prompt-from-review', {
            detail: { sections, afterReviewNodeId: node.dataset.nodeId },
          }));
        } catch (_) {}
      },
      'edit-review-name': () => {
        if (node.dataset.nodeType !== 'promptReview') return;
        openEditNodeNameModal(node, {
          modalTitle: 'Edit Review name',
          fieldLabel: 'Review name',
          placeholder: 'Review',
          getCurrentName: () => (node.querySelector('.workflow-node__title')?.textContent || '').trim() || 'Review',
          onSave: (name) => {
            const titleEl = node.querySelector('.workflow-node__title');
            if (titleEl) titleEl.textContent = name;
          },
        });
      },
      'edit-sampler-name': () => {
        if (node.dataset.nodeType !== 'sampler') return;
        openEditNodeNameModal(node, {
          modalTitle: 'Edit Sample name',
          fieldLabel: 'Sample name',
          placeholder: 'Sample',
          getCurrentName: () => (node.dataset.samplerName || node.querySelector('.workflow-node__title')?.textContent || '').trim() || 'Sample',
          onSave: (name) => {
            node.dataset.samplerName = name;
            const titleEl = node.querySelector('.workflow-node__title');
            if (titleEl) titleEl.textContent = name;
          },
        });
      },
      'duplicate-working-dataset': () => {
        const left = parseFloat(node.style.left) || 0;
        const top = parseFloat(node.style.top) || 0;
        const height = node.offsetHeight || 80;
        const currentName = (node.dataset.datasetName || node.dataset.subsetName || '').trim() || 'Dataset';
        const newName = findUniqueWorkingDatasetName(currentName, false);
        const content = datasetContentByNodeId.get(node.dataset.nodeId);
        const headers = content?.headers ? content.headers.slice() : [];
        const rows = content?.rows ? content.rows.map((r) => r.slice()) : [];
        const samplerNodeId = node.dataset.samplerNodeId || '';
        const samplerNode = samplerNodeId ? getNodeById(samplerNodeId) : null;
        const notes = (node.dataset.datasetNote ?? node.dataset.subsetNote ?? '').trim() || formatSamplerDescription(samplerNode);
        const newNode = createDatasetNode({
          name: newName,
          notes,
          left,
          top: top + height + NEW_NODE_OFFSET,
          samplerNodeId,
          headers,
          rows,
        });
        if (newNode?.dataset?.nodeId) {
          connections.filter((c) => c.toId === node.dataset.nodeId).forEach((c) => {
            connections.push({ fromId: c.fromId, toId: newNode.dataset.nodeId, type: c.type });
          });
          updateEdges();
        }
        updateContentSize();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      },
      'add-version-of-dataset': () => {
        const left = parseFloat(node.style.left) || 0;
        const top = parseFloat(node.style.top) || 0;
        const width = node.offsetWidth || 280;
        const currentName = (node.dataset.datasetName || node.dataset.subsetName || '').trim() || 'Dataset';
        const versionName = findNextWorkingDatasetVersionName(currentName, node.dataset.nodeId);
        const content = datasetContentByNodeId.get(node.dataset.nodeId);
        const headers = content?.headers ? content.headers.slice() : [];
        const rows = content?.rows ? content.rows.map((r) => r.slice()) : [];
        const samplerNodeId = node.dataset.samplerNodeId || '';
        const samplerNode = samplerNodeId ? getNodeById(samplerNodeId) : null;
        const notes = (node.dataset.datasetNote ?? node.dataset.subsetNote ?? '').trim() || formatSamplerDescription(samplerNode);
        const newNode = createDatasetNode({
          name: versionName,
          notes,
          left: left + width + NEW_NODE_OFFSET,
          top,
          samplerNodeId,
          headers,
          rows,
        });
        if (newNode?.dataset?.nodeId) {
          connections.push({
            fromId: node.dataset.nodeId,
            toId: newNode.dataset.nodeId,
            type: EDGE_TYPE_DATASET_TO_DATASET,
          });
          updateEdges();
        }
        updateContentSize();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      },
    };

    menu.querySelectorAll('.workflow-node-context-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        const action = btn.getAttribute('data-action');
        if (actions[action]) actions[action]();
        menu.remove();
      });
    });

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const padding = 8;
    let left = clientX;
    let top = clientY;
    if (left + rect.width + padding > window.innerWidth) left = window.innerWidth - rect.width - padding;
    if (top + rect.height + padding > window.innerHeight) top = window.innerHeight - rect.height - padding;
    if (left < padding) left = padding;
    if (top < padding) top = padding;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const close = () => {
      menu.remove();
      document.removeEventListener('click', close);
      document.removeEventListener('contextmenu', close);
    };
    requestAnimationFrame(() => document.addEventListener('click', close, { once: true }));
    document.addEventListener('contextmenu', close, { once: true });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = normalizeUnicodeDashesForDisplay(String(str ?? ''));
    return div.innerHTML;
  }

  /**
   * Open modal to edit a node's display name only (Run, Score, Review, Sample).
   * @param {HTMLElement} node - The workflow node
   * @param {{ modalTitle: string, fieldLabel: string, placeholder: string, getCurrentName: () => string, onSave: (name: string) => void }} options
   */
  function openEditNodeNameModal(node, { modalTitle, fieldLabel, placeholder, getCurrentName, onSave }) {
    const currentName = getCurrentName();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay modal-overlay--edit-node-name';
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'edit-node-name-title');
    overlay.innerHTML = `
      <div class="modal-panel modal-panel--edit-node-name">
        <div class="modal-header">
          <h2 id="edit-node-name-title" class="modal-title">${escapeHtml(modalTitle)}</h2>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <div class="dataset-meta-wrap prompt-meta-wrap">
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="edit-node-name-input">${escapeHtml(fieldLabel)}</label>
              <input type="text" id="edit-node-name-input" class="dataset-meta-input" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(currentName)}" aria-label="${escapeHtml(fieldLabel)}" />
            </div>
          </div>
          <div class="prompt-form-error prompt-modal-error edit-node-name-error" role="alert" aria-live="polite" hidden></div>
          <div class="prompt-actions">
            <button type="button" class="btn btn-secondary edit-node-name-cancel">Cancel</button>
            <button type="button" class="btn btn-secondary edit-node-name-save">Save</button>
          </div>
        </div>
      </div>
    `;
    const nameInput = overlay.querySelector('#edit-node-name-input');
    const errorEl = overlay.querySelector('.edit-node-name-error');

    function close() {
      overlay.remove();
      document.body.style.overflow = '';
    }

    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.querySelector('.edit-node-name-cancel').addEventListener('click', close);
    overlay.querySelector('.edit-node-name-save').addEventListener('click', () => {
      const name = (nameInput?.value ?? '').trim() || placeholder;
      if (!name) {
        if (errorEl) {
          errorEl.textContent = `Please enter a ${fieldLabel.toLowerCase()}.`;
          errorEl.hidden = false;
        }
        return;
      }
      onSave(name);
      close();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    });

    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
    nameInput?.focus();
  }

  /**
   * Open modal to edit prompt node name and description (same layout as Add prompt step 1).
   * @param {HTMLElement} node - The prompt workflow node
   */
  function openEditPromptNameModal(node) {
    const currentName = (node.dataset.promptName || '').trim() || '';
    const currentNote = (node.dataset.promptNote || '').trim() || '';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay modal-overlay--edit-prompt-name';
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'edit-prompt-name-title');
    overlay.innerHTML = `
      <div class="modal-panel modal-panel--prompt modal-panel--edit-prompt-name" data-add-prompt-step="1">
        <div class="modal-header">
          <h2 id="edit-prompt-name-title" class="modal-title">Edit name & description</h2>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <div class="prompt-main">
            <div class="prompt-step prompt-step-1">
              <div class="dataset-meta-wrap prompt-meta-wrap">
                <div class="dataset-meta-field">
                  <label class="dataset-meta-label" for="edit-prompt-name-input">Prompt name</label>
                  <input type="text" id="edit-prompt-name-input" class="dataset-meta-input" placeholder="My prompt" value="${escapeHtml(currentName)}" />
                </div>
                <div class="dataset-meta-field">
                  <label class="dataset-meta-label" for="edit-prompt-note-input">Prompt description</label>
                  <textarea id="edit-prompt-note-input" class="dataset-meta-input dataset-meta-textarea" rows="3" placeholder="What it does">${escapeHtml(currentNote)}</textarea>
                </div>
              </div>
              <div class="prompt-form-error prompt-modal-error edit-prompt-name-error" role="alert" aria-live="polite" hidden></div>
              <div class="prompt-actions">
                <button type="button" class="btn btn-secondary edit-prompt-name-cancel">Cancel</button>
                <button type="button" class="btn btn-secondary edit-prompt-name-save">Save</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    const nameInput = overlay.querySelector('#edit-prompt-name-input');
    const noteInput = overlay.querySelector('#edit-prompt-note-input');
    const errorEl = overlay.querySelector('.edit-prompt-name-error');

    function close() {
      overlay.remove();
      document.body.style.overflow = '';
    }

    function showError(msg) {
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.hidden = false;
      }
    }

    function clearError() {
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.hidden = true;
      }
    }

    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.querySelector('.edit-prompt-name-cancel').addEventListener('click', close);
    overlay.querySelector('.edit-prompt-name-save').addEventListener('click', () => {
      const name = (nameInput?.value ?? '').trim();
      const note = (noteInput?.value ?? '').trim();
      if (!name) {
        showError('Please enter a prompt name.');
        return;
      }
      if (!note) {
        showError('Please enter a prompt description.');
        return;
      }
      if (isPromptNameAlreadyUsed(name, node.dataset.nodeId || undefined)) {
        showError('This prompt name is already used on the canvas. Please choose another.');
        return;
      }
      node.dataset.promptName = name;
      node.dataset.promptNote = note;
      const titleEl = node.querySelector('.workflow-node__title');
      if (titleEl) titleEl.textContent = name;
      const ariaLabel = node.getAttribute('aria-label');
      if (ariaLabel != null) node.setAttribute('aria-label', `Prompt node: ${name}`);
      let bodyEl = node.querySelector('.workflow-node__body');
      if (note) {
        if (!bodyEl) {
          bodyEl = document.createElement('div');
          bodyEl.className = 'workflow-node__body';
          node.classList.remove('workflow-node--no-body');
          node.appendChild(bodyEl);
        }
        bodyEl.innerHTML = `<span class="workflow-node__note">${escapeHtml(note)}</span>`;
      } else {
        if (bodyEl) bodyEl.remove();
        node.classList.add('workflow-node--no-body');
      }
      close();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    nameInput?.addEventListener('input', clearError);
    noteInput?.addEventListener('input', clearError);

    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
    nameInput?.focus();
  }

  /**
   * Open modal to edit dataset (subset) node name and description (same layout as Add dataset step 1).
   * @param {HTMLElement} node - The subset workflow node
   */
  function openEditDatasetNameModal(node) {
    const currentName = (node.dataset.datasetName || node.dataset.subsetName || '').trim() || '';
    const currentNote = (node.dataset.datasetNote ?? node.dataset.subsetNote ?? '').trim() || '';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay modal-overlay--edit-dataset-name';
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'edit-dataset-name-title');
    overlay.innerHTML = `
      <div class="modal-panel modal-panel--dataset modal-panel--edit-dataset-name" data-add-dataset-step="1">
        <div class="modal-header">
          <h2 id="edit-dataset-name-title" class="modal-title">Edit name & description</h2>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body modal-body--dataset">
          <div class="dataset-add-main">
            <div class="dataset-add-step dataset-add-step-1">
              <div class="dataset-meta-wrap prompt-meta-wrap">
                <div class="dataset-meta-field">
                  <label class="dataset-meta-label" for="edit-dataset-name-input">Dataset name</label>
                  <input type="text" id="edit-dataset-name-input" class="dataset-meta-input" placeholder="My dataset" value="${escapeHtml(currentName)}" />
                </div>
                <div class="dataset-meta-field">
                  <label class="dataset-meta-label" for="edit-dataset-notes-input">Dataset description</label>
                  <textarea id="edit-dataset-notes-input" class="dataset-meta-input dataset-meta-textarea" rows="3" placeholder="What this dataset is for">${escapeHtml(currentNote)}</textarea>
                </div>
              </div>
              <div class="prompt-form-error prompt-modal-error edit-dataset-name-error" role="alert" aria-live="polite" hidden></div>
              <div class="prompt-actions">
                <button type="button" class="btn btn-secondary edit-dataset-name-cancel">Cancel</button>
                <button type="button" class="btn btn-secondary edit-dataset-name-save">Save</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    const nameInput = overlay.querySelector('#edit-dataset-name-input');
    const notesInput = overlay.querySelector('#edit-dataset-notes-input');
    const errorEl = overlay.querySelector('.edit-dataset-name-error');

    function close() {
      overlay.remove();
      document.body.style.overflow = '';
    }

    function showError(msg) {
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.hidden = false;
      }
    }

    function clearError() {
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.hidden = true;
      }
    }

    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.querySelector('.edit-dataset-name-cancel').addEventListener('click', close);
    overlay.querySelector('.edit-dataset-name-save').addEventListener('click', () => {
      const name = (nameInput?.value ?? '').trim();
      const notes = (notesInput?.value ?? '').trim();
      if (!name) {
        showError('Dataset name is required.');
        return;
      }
      if (!notes) {
        showError('Dataset description is required.');
        return;
      }
      if (isDatasetNameAlreadyUsed(name, node.dataset.nodeId || undefined)) {
        showError('This dataset name is already used on the canvas. Please choose another.');
        return;
      }
      node.dataset.datasetName = name;
      node.dataset.datasetNote = notes;
      const titleEl = node.querySelector('.workflow-node__title');
      if (titleEl) titleEl.textContent = name;
      if (node.getAttribute('aria-label') != null) node.setAttribute('aria-label', `Dataset node: ${name}`);
      const samplerNodeId = node.dataset.samplerNodeId;
      const samplerNode = samplerNodeId ? getNodeById(samplerNodeId) : null;
      const bodyText = formatSamplerDescription(samplerNode) || (notes || '').trim() || '';
      const bodyEl = node.querySelector('.workflow-node__dataset-desc');
      if (bodyEl) bodyEl.innerHTML = bodyText ? `<span class="workflow-node__note">${escapeHtml(bodyText)}</span>` : '<span class="workflow-node__note-placeholder">No description.</span>';
      close();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    nameInput?.addEventListener('input', clearError);
    notesInput?.addEventListener('input', clearError);

    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
    nameInput?.focus();
  }

  /**
   * Show an in-app alert dialog (replaces window.alert). Appends to document.body.
   * @param {string} message - Body text
   * @param {string} [title='Message'] - Dialog title
   */
  function showAppAlert(message, title = 'Message') {
    const overlay = document.createElement('div');
    overlay.className = 'app-alert-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'app-alert-title');
    overlay.innerHTML = `
      <div class="app-alert-dialog">
        <p id="app-alert-title" class="app-alert-dialog-title">${escapeHtml(title)}</p>
        <p class="app-alert-dialog-message">${escapeHtml(message)}</p>
        <div class="app-alert-dialog-btns">
          <button type="button" class="btn btn-secondary app-alert-ok">OK</button>
        </div>
      </div>
    `;
    const remove = () => overlay.remove();
    overlay.querySelector('.app-alert-ok').addEventListener('click', remove);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) remove(); });
    document.body.appendChild(overlay);
  }

  document.addEventListener('workflow:add-prompt-node', (e) => {
    const { name = '', note = '', sections = [], outputFormat } = e.detail || {};
    createPromptNode({ name, note, sections, outputFormat });
    updateContentSize();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  });

  document.addEventListener('workflow:score-export-to-workspace', (e) => {
    const { scoreName = '', headers, rows } = e.detail || {};
    if (!Array.isArray(headers) || !Array.isArray(rows)) return;
    const baseName = (scoreName && scoreName.trim()) ? scoreName.trim() + ' comparison' : 'Score comparison';
    const datasetName = findUniqueDatasetExportName(baseName);
    const notes = `Exported from Score "${(scoreName && scoreName.trim()) ? scoreName.trim() : 'Score'}". Run vs ground truth comparison.`;
    document.dispatchEvent(new CustomEvent('workflow:add-dataset-node', {
      detail: { name: datasetName, notes, headers, rows },
    }));
  });

  document.addEventListener('workflow:add-dataset-node', (e) => {
    const { name = '', notes = '', headers, rows, left: detailLeft, top: detailTop, samplerNodeId = '', colorIndex: detailColorIndex } = e.detail || {};
    const VISIBLE_PADDING = 40;
    let startLeft = typeof detailLeft === 'number' ? detailLeft : (scrollWrapper.scrollLeft + VISIBLE_PADDING);
    let startTop = typeof detailTop === 'number' ? detailTop : (scrollWrapper.scrollTop + VISIBLE_PADDING);
    let datasetHeaders = Array.isArray(headers) ? headers.slice() : [];
    let datasetRows = Array.isArray(rows) ? rows.map((r) => r.slice()) : [];
    let datasetName = (name && name.trim()) ? name.trim() : '';
    let datasetNotes = notes || '';

    if (samplerNodeId) {
      const samplerNode = getNodeById(samplerNodeId);
      if (samplerNode) {
        startLeft = (parseFloat(samplerNode.style.left) || 0) + (samplerNode.offsetWidth || 280) + NEW_NODE_OFFSET;
        startTop = parseFloat(samplerNode.style.top) || 0;
        const sourceNodeId = samplerNode.dataset.sourceNodeId;
        const sourceContent = sourceNodeId ? datasetContentByNodeId.get(sourceNodeId) : null;
        if (sourceContent?.headers?.length && Array.isArray(sourceContent.rows)) {
          datasetHeaders = sourceContent.headers.slice();
          const samplingType = samplerNode.dataset.samplerSamplingType || 'without-replacement';
          if (samplingType === 'specify-rows') {
            const rowSpec = (samplerNode.dataset.samplerRowSpec || '').trim();
            const totalRows = sourceContent.rows.length;
            const indices = parseRowSpec(rowSpec, totalRows);
            datasetRows = indices.map((i) => sourceContent.rows[i].slice());
          } else {
            const sampleSize = parseInt(samplerNode.dataset.samplerSampleSize, 10) || 100;
            const sampleSizeType = samplerNode.dataset.samplerSampleSizeType || 'rows';
            const totalRows = sourceContent.rows.length;
            const requestedCount = sampleSizeType === 'rows'
              ? Math.max(0, Math.floor(sampleSize))
              : Math.max(0, Math.floor((totalRows * sampleSize) / 100));
            if (samplingType === 'without-replacement' && requestedCount > 0) {
              let alreadyUsed = 0;
              nodesLayer.querySelectorAll('.workflow-node--dataset').forEach((dsNode) => {
                if ((dsNode.dataset.samplerNodeId || '') === samplerNodeId) {
                  const content = datasetContentByNodeId.get(dsNode.dataset.nodeId);
                  if (content?.rows?.length) alreadyUsed += content.rows.length;
                }
              });
              const remaining = totalRows - alreadyUsed;
              if (remaining < requestedCount) {
                showAppAlert(
                  'Not enough remaining data to create a new dataset when sampling without replacement.',
                  'Cannot create dataset'
                );
                return;
              }
            }
            datasetRows = sampleRows(sourceContent.rows, sampleSize, sampleSizeType, samplingType);
          }
        }
        datasetName = findNextWorkingDatasetName(samplerNodeId);
        datasetNotes = formatSamplerDescription(samplerNode);
      }
    } else {
      datasetName = datasetName || findUniqueWorkingDatasetName('Dataset', false);
    }

    const newNode = createDatasetNode({
      name: datasetName,
      notes: datasetNotes,
      left: startLeft,
      top: startTop,
      samplerNodeId: samplerNodeId || '',
      colorIndex: detailColorIndex,
      headers: datasetHeaders,
      rows: datasetRows,
    });
    if (samplerNodeId && newNode?.dataset?.nodeId) {
      connections.push({
        fromId: samplerNodeId,
        toId: newNode.dataset.nodeId,
        type: EDGE_TYPE_SAMPLER_TO_DATASET,
      });
      updateEdges();
    }
    updateContentSize();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  });

  document.addEventListener('workflow:add-sampler-node', (e) => {
    const { sourceNodeId = '', colorIndex, name: nameParam, samplingType = 'without-replacement', sampleSizeType = 'rows', sampleSize = 100, rowSpec = '' } = e.detail || {};
    const name = (nameParam && nameParam.trim()) ? nameParam.trim() : 'Sample';
    let left, top;
    const sourceNode = sourceNodeId ? getNodeById(sourceNodeId) : null;
    if (sourceNode) {
      left = (parseFloat(sourceNode.style.left) || 0) + (sourceNode.offsetWidth || 280) + NEW_NODE_OFFSET;
      top = parseFloat(sourceNode.style.top) || 0;
    }
    const newNode = createSamplerNode({ name, notes: '', left, top, sourceNodeId, colorIndex, samplingType, sampleSizeType, sampleSize, rowSpec });
    if (sourceNodeId && newNode?.dataset?.nodeId) {
      connections.push({
        fromId: sourceNodeId,
        toId: newNode.dataset.nodeId,
        type: EDGE_TYPE_DATASET_TO_SAMPLER,
      });
      updateEdges();
    }
    updateContentSize();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  });

  document.addEventListener('workflow:add-score-node', (e) => {
    const runNodeId = e.detail?.runNodeId || '';
    const runNode = runNodeId ? getNodeById(runNodeId) : null;
    if (!runNode || !runNode.classList.contains('workflow-node--run')) return;
    const left = (parseFloat(runNode.style.left) || 0) + (runNode.offsetWidth || 280) + NEW_NODE_OFFSET;
    const top = parseFloat(runNode.style.top) || 0;
    const scoreNode = createScoreNode({ left, top, title: 'Score' });
    if (scoreNode?.dataset?.nodeId) {
      connections.push({
        fromId: runNodeId,
        toId: scoreNode.dataset.nodeId,
        type: EDGE_TYPE_RUN_TO_SCORE,
      });
      updateEdges();
      const gtId = (scoreNode.dataset.scoreGroundTruthId || '').trim();
      if (gtId) {
        const wsNode = getNodeById(gtId);
        if (wsNode && wsNode.classList.contains('workflow-node--dataset')) {
          const colorIndex = wsNode.dataset.datasetColorIndex != null ? parseInt(wsNode.dataset.datasetColorIndex, 10) : 0;
          const color = DATASET_BORDER_COLORS[colorIndex % DATASET_BORDER_COLORS.length];
          const bar = scoreNode.querySelector('.workflow-node__score-progress');
          if (bar) bar.style.background = color;
        }
      }
    }
    updateContentSize();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  });

  document.addEventListener('workflow:add-prompt-review-node', (e) => {
    const scoreNodeId = e.detail?.scoreNodeId || '';
    const scoreNode = scoreNodeId ? getNodeById(scoreNodeId) : null;
    if (!scoreNode || !scoreNode.classList.contains('workflow-node--score')) return;
    const left = (parseFloat(scoreNode.style.left) || 0) + (scoreNode.offsetWidth || 280) + NEW_NODE_OFFSET;
    const top = parseFloat(scoreNode.style.top) || 0;
    const promptReviewNode = createPromptReviewNode({ left, top, title: 'Review' });
    if (promptReviewNode?.dataset?.nodeId) {
      const reviewNodeId = promptReviewNode.dataset.nodeId;
      connections.push({
        fromId: scoreNodeId,
        toId: reviewNodeId,
        type: EDGE_TYPE_SCORE_TO_PROMPT_REVIEW,
      });
      updateEdges();
      if (!e.detail) e.detail = {};
      e.detail.reviewNodeId = reviewNodeId;
      e.detail.registerPendingReview = registerPendingReview;
    }
    updateContentSize();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  });

  document.addEventListener('workflow:review-stream-started', (e) => {
    const id = e.detail?.reviewNodeId;
    if (id) pendingReviewNodeIds.add(id);
  });
  document.addEventListener('workflow:review-stream-ended', (e) => {
    const id = e.detail?.reviewNodeId;
    if (id) {
      pendingReviewNodeIds.delete(id);
      unregisterPendingReview(id);
    }
  });

  document.addEventListener('workflow:review-progress', (e) => {
    const reviewNodeId = e.detail?.reviewNodeId;
    const percent = e.detail?.percent;
    if (!reviewNodeId || percent == null) return;
    const reviewNode = getNodeById(reviewNodeId);
    if (!reviewNode || !reviewNode.classList.contains('workflow-node--prompt-review')) return;
    setReviewNodeProgress(reviewNode, percent);
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  });

  document.addEventListener('workflow:run-results-updated', (e) => {
    const runNodeId = e.detail?.nodeId;
    const results = e.detail?.results;
    if (!runNodeId) return;
    syncScoreNodesProgressForRunId(runNodeId, results);
  });

  document.addEventListener('workflow:canvas-changed', () => {
    nodesLayer.querySelectorAll('.workflow-node--score').forEach((sn) => syncScoreNodeProgressFromUpstreamRun(sn));
  });

  document.addEventListener('workflow:save-review-result', (e) => {
    const reviewNodeId = e.detail?.reviewNodeId;
    const data = e.detail?.data;
    if (!reviewNodeId || data === undefined) return;
    const reviewNode = getNodeById(reviewNodeId);
    if (!reviewNode || !reviewNode.classList.contains('workflow-node--prompt-review')) return;
    try {
      let toWrite = typeof data === 'string' ? (() => { try { return JSON.parse(data); } catch (_) { return null; } })() : data;
      if (!toWrite || typeof toWrite !== 'object') return;
      ensureReviewResultIds(toWrite);
      const existingRaw = (reviewNode.dataset.reviewResult || '').trim();
      let existing = null;
      if (existingRaw) {
        try {
          existing = JSON.parse(existingRaw);
        } catch (_) {}
      }
      if (existingRaw && Array.isArray(toWrite.suggestions) && existing && typeof existing === 'object' && Array.isArray(existing.suggestions)) {
        const merged = { ...toWrite };
        if (Array.isArray(existing.workingSections) && existing.workingSections.length > 0) {
          merged.workingSections = existing.workingSections.map((s) => ({ name: s.name || '', content: (s.content || '').slice() }));
        }
        const existSug = existing.suggestions;
        merged.suggestions = (toWrite.suggestions || []).map((s, i) => {
          const next = { ...s };
          const nextNum = parseNumericSuggestionId(next.suggestion_id);
          const prevById =
            nextNum != null
              ? existSug.find((p) => parseNumericSuggestionId(p?.suggestion_id) === nextNum)
              : null;
          const prev = prevById || existSug[i];
          if (prev && prev.applied === true) next.applied = true;
          if (prev && prev.review_finetune_completed === true) {
            next.review_finetune_completed = true;
            const pm = prev.review_finetune_meta;
            const nm = next.review_finetune_meta;
            const keepPrevMeta =
              pm &&
              typeof pm === 'object' &&
              (!nm || typeof nm !== 'object' || (nm.bestPassPct == null && pm.bestPassPct != null));
            if (keepPrevMeta) next.review_finetune_meta = pm;
          }
          const prevNumForMerge = prev ? parseNumericSuggestionId(prev.suggestion_id) : null;
          const sameSuggestionForTestMerge =
            prevById != null ||
            (prev != null && nextNum != null && prevNumForMerge != null && prevNumForMerge === nextNum);
          const nextRowCheckRunning =
            next.review_test_in_progress === true || next.review_test_in_progress === 1;
          if (prev && sameSuggestionForTestMerge && !nextRowCheckRunning) {
            for (const key of ['review_test_result', 'review_test_result_finetune_after', 'review_test_result_finetune_before']) {
              const pt = prev[key];
              if (pt === 'pass' || pt === 'fail') {
                const nt = next[key];
                if (nt !== 'pass' && nt !== 'fail') {
                  next[key] = pt;
                }
              }
            }
          }
          if (nextNum == null) {
            const prevNum = prev ? parseNumericSuggestionId(prev.suggestion_id) : null;
            next.suggestion_id = prevNum != null ? prevNum : allocNextReviewSuggestionId(merged);
          } else {
            next.suggestion_id = nextNum;
          }
          return next;
        });
        syncReviewSuggestionSeqNext(merged);
        toWrite = merged;
      }
      // Preserve chatHistory and chatRequestInProgress when stream/other updates would overwrite them
      if (existing && typeof existing === 'object') {
        if (!Array.isArray(toWrite.chatHistory) || toWrite.chatHistory.length === 0) {
          if (Array.isArray(existing.chatHistory) && existing.chatHistory.length > 0) {
            toWrite = { ...toWrite, chatHistory: existing.chatHistory };
          }
        }
        if (toWrite.chatRequestInProgress !== true && existing.chatRequestInProgress === true) {
          toWrite = { ...toWrite, chatRequestInProgress: true };
        }
      }
      reviewNode.dataset.reviewResult = JSON.stringify(toWrite);
      if (toWrite.reviewProgress != null) {
        setReviewNodeProgress(reviewNode, toWrite.reviewProgress);
      }
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    } catch (_) {}
  });

  document.addEventListener('workflow:add-prompt-from-review', (e) => {
    const { sections = [], afterReviewNodeId, afterScoreNodeId } = e.detail || {};
    if (!Array.isArray(sections) || sections.length === 0) return;
    let refNode = afterReviewNodeId ? getNodeById(afterReviewNodeId) : null;
    if (!refNode && afterScoreNodeId) {
      const reviewEdge = connections.find(
        (c) => c.fromId === afterScoreNodeId && c.type === EDGE_TYPE_SCORE_TO_PROMPT_REVIEW
      );
      refNode = reviewEdge ? getNodeById(reviewEdge.toId) : null;
    }
    let outputFormat;
    let scoreNode = null;
    let sourcePromptNode = null;
    if (refNode) {
      const scoreToReview = connections.find((c) => c.toId === refNode.dataset.nodeId && c.type === EDGE_TYPE_SCORE_TO_PROMPT_REVIEW);
      scoreNode = scoreToReview ? getNodeById(scoreToReview.fromId) : null;
    } else if (afterScoreNodeId) {
      scoreNode = getNodeById(afterScoreNodeId);
    }
    if (scoreNode) {
      const runEdge = connections.find((c) => c.toId === scoreNode.dataset.nodeId && c.type === EDGE_TYPE_RUN_TO_SCORE);
      const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
      const promptEdge = runNode ? connections.find((c) => c.toId === runNode.dataset.nodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN) : null;
      sourcePromptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
      if (sourcePromptNode && sourcePromptNode.classList.contains('workflow-node--prompt')) {
        try {
          const fields = JSON.parse(sourcePromptNode.dataset.promptOutputFormat || '[]');
          const returnShape = sourcePromptNode.dataset.promptOutputReturnShape || 'single';
          outputFormat = { fields: Array.isArray(fields) ? fields : [], returnShape };
        } catch (_) {}
      }
    }
    const refLeft = refNode ? (parseFloat(refNode.style.left) || 0) : 0;
    const refWidth = refNode ? (refNode.offsetWidth || 280) : 280;
    const refTop = refNode ? (parseFloat(refNode.style.top) || 0) : 0;
    const left = refNode ? refLeft + refWidth + NEW_NODE_OFFSET : undefined;
    const top = refNode ? refTop : undefined;
    const baseName = (sourcePromptNode && (sourcePromptNode.dataset.promptName || sourcePromptNode.querySelector('.workflow-node__title')?.textContent || '').trim()) || 'Prompt (from Review)';
    const promptName = findUniquePromptName(baseName, true);
    const promptNote = 'Exported from Review.';
    const newNode = createPromptNode({
      name: promptName,
      note: promptNote,
      sections: sections.map((s) => ({ name: s.name || '', content: s.content || '' })),
      outputFormat: outputFormat || undefined,
      left,
      top,
    });
    if (refNode && newNode?.dataset?.nodeId) {
      const refHeight = refNode.offsetHeight || 80;
      const newHeight = newNode.offsetHeight || 80;
      newNode.style.top = `${refTop + refHeight / 2 - newHeight / 2}px`;
      connections.push({
        fromId: refNode.dataset.nodeId,
        toId: newNode.dataset.nodeId,
        type: EDGE_TYPE_PROMPT_REVIEW_TO_PROMPT,
      });
      updateEdges();
    }
    updateContentSize();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  });

  function getCanvasState() {
    const nodeEls = Array.from(nodesLayer.querySelectorAll('.workflow-node'));
    const nodes = nodeEls.map((node) => {
      const left = parseFloat(node.style.left) || 0;
      const top = parseFloat(node.style.top) || 0;
      const nodeId = node.dataset.nodeId || '';
      if (node.classList.contains('workflow-node--dataset')) {
        const content = datasetContentByNodeId.get(nodeId);
        return {
          type: 'dataset',
          nodeId,
          left,
          top,
          name: node.dataset.datasetName || node.dataset.subsetName || '',
          note: node.dataset.datasetNote ?? node.dataset.subsetNote ?? '',
          samplerNodeId: node.dataset.samplerNodeId || '',
          colorIndex: node.dataset.datasetColorIndex != null ? parseInt(node.dataset.datasetColorIndex, 10) : undefined,
          subsetContent: content ? { headers: content.headers, rows: content.rows } : undefined,
          datasetContent: content ? { headers: content.headers, rows: content.rows } : undefined,
        };
      }
      if (node.classList.contains('workflow-node--sampler')) {
        const samplingType = node.dataset.samplerSamplingType || 'without-replacement';
        const out = {
          type: 'sampler',
          nodeId,
          left,
          top,
          name: node.dataset.samplerName || '',
          note: node.dataset.samplerNote || '',
          sourceNodeId: node.dataset.sourceNodeId || '',
          colorIndex: node.dataset.samplerColorIndex != null ? parseInt(node.dataset.samplerColorIndex, 10) : undefined,
          samplingType,
        };
        if (samplingType === 'specify-rows') {
          out.rowSpec = (node.dataset.samplerRowSpec || '').trim();
        } else {
          out.sampleSizeType = node.dataset.samplerSampleSizeType || 'rows';
          out.sampleSize = node.dataset.samplerSampleSize != null ? parseInt(node.dataset.samplerSampleSize, 10) : 100;
        }
        return out;
      }
      if (node.classList.contains('workflow-node--run')) {
        const bar = node.querySelector('.workflow-node__run-progress');
        let pct = bar ? parseInt(bar.getAttribute('aria-valuenow') || '0', 10) : 0;
        const runName = (node.dataset.runName || '').trim() || node.querySelector('.workflow-node__title')?.textContent?.trim() || 'Run';
        let runResults = node.dataset.runResults || undefined;
        if (runResults) {
          try {
            let results = JSON.parse(runResults);
            if (Array.isArray(results) && node.dataset.runInputContent) {
              let content = null;
              try {
                content = JSON.parse(node.dataset.runInputContent);
              } catch (_) {}
              results = embedInputRow(results, content);
              runResults = JSON.stringify(results);
            }
          } catch (_) {}
        }
        const out = {
          type: 'run',
          nodeId,
          left,
          top,
          runName,
          runWorkingSetId: (node.dataset.runWorkingSetId || '').trim() || undefined,
          runCredentialId: (node.dataset.runCredentialId || '').trim() || undefined,
          runInputToColumn: node.dataset.runInputToColumn || undefined,
          runResults,
          runCompleted: node.dataset.runCompleted || undefined,
          runInputContent: node.dataset.runInputContent || undefined,
        };
        if (pct <= 0 && node.dataset.runResults && node.dataset.runInputContent) {
          try {
            const results = JSON.parse(node.dataset.runResults);
            const content = JSON.parse(node.dataset.runInputContent);
            const totalInputRows = Array.isArray(content?.rows) ? content.rows.length : 0;
            if (Array.isArray(results) && results.length > 0 && totalInputRows > 0) {
              const completed = countCompletedInputRows(results);
              pct = Math.min(99, Math.round((completed / totalInputRows) * 100));
            }
          } catch (_) {}
        }
        if (pct > 0) out.runProgress = pct;
        return out;
      }
      if (node.classList.contains('workflow-node--score')) {
        const scoreName = node.querySelector('.workflow-node__title')?.textContent?.trim() || 'Score';
        const scoreGroundTruthId = (node.dataset.scoreGroundTruthId || '').trim() || undefined;
        let scoreMapping;
        try {
          const raw = node.dataset.scoreMapping || '[]';
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const tree = parseScoreMappingToTree(data);
          const hasRules = (tree.type === 'group' && tree.children && tree.children.length > 0) || flattenScoreTreeToRules(tree).length > 0;
          scoreMapping = hasRules ? tree : undefined;
        } catch (_) {}
        const reviewResult = (node.dataset.reviewResult || '').trim();
        const reviewCredentialId = (node.dataset.reviewCredentialId || '').trim() || undefined;
        const scoreRowExcludedFromScoring = (node.dataset.scoreRowExcludedFromScoring || '').trim();
        let scoreRowExcludedFromScoringObj;
        try {
          scoreRowExcludedFromScoringObj = scoreRowExcludedFromScoring ? JSON.parse(scoreRowExcludedFromScoring) : undefined;
        } catch (_) {}
        return {
          type: 'score',
          nodeId,
          left,
          top,
          scoreName,
          scoreGroundTruthId,
          scoreMapping,
          scoreRowExcludedFromScoring: scoreRowExcludedFromScoringObj,
          reviewResult: reviewResult || undefined,
          reviewCredentialId,
        };
      }
      if (node.classList.contains('workflow-node--prompt-review')) {
        const promptReviewName = node.querySelector('.workflow-node__title')?.textContent?.trim() || 'Review';
        const reviewResult = (node.dataset.reviewResult || '').trim();
        const bar = node.querySelector('.workflow-node__review-progress');
        const pct = bar ? parseInt(bar.getAttribute('aria-valuenow') || '0', 10) : (node.dataset.reviewProgress != null ? parseInt(node.dataset.reviewProgress, 10) : 0);
        const out = {
          type: 'promptReview',
          nodeId,
          left,
          top,
          promptReviewName,
          reviewResult: reviewResult || undefined,
        };
        if (pct > 0) out.reviewProgress = pct;
        return out;
      }
      let sections = [];
      let outputFormat = [];
      try {
        sections = JSON.parse(node.dataset.promptSections || node.dataset.promptFields || '[]');
      } catch (_) {}
      try {
        const raw = JSON.parse(node.dataset.promptOutputFormat || '[]');
        const fields = (Array.isArray(raw) ? raw : []).map((o) => ({ key: o.key || '', type: o.type || 'str', description: o.description ?? '', examples: o.examples || [] }));
        const returnShape = node.dataset.promptOutputReturnShape || 'single';
        outputFormat = { returnShape, fields };
      } catch (_) {
        outputFormat = { returnShape: 'single', fields: [] };
      }
      return {
        type: 'prompt',
        nodeId,
        left,
        top,
        name: node.dataset.promptName || '',
        note: node.dataset.promptNote || '',
        sections: Array.isArray(sections) ? sections : [],
        outputFormat,
      };
    });
    return { version: 2, nodes, connections: connections.slice() };
  }

  function loadCanvasState(state) {
    const list = state?.nodes;
    if (!Array.isArray(list)) return;
    nodesLayer.innerHTML = '';
    nodeCount = 0;
    const createdNodes = [];
    list.forEach((n) => {
      if (n.type === 'dataset' || n.type === 'subset') {
        const content = n.subsetContent || n.datasetContent;
        const node = createDatasetNode({
          name: n.name || '',
          notes: n.note || '',
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
          samplerNodeId: n.samplerNodeId || '',
          colorIndex: n.colorIndex,
          headers: content?.headers,
          rows: content?.rows,
        });
        createdNodes.push(node);
      } else if (n.type === 'sampler') {
        const samplingType = n.samplingType || 'without-replacement';
        const node = createSamplerNode({
          name: n.name || '',
          notes: n.note || '',
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
          sourceNodeId: n.sourceNodeId || '',
          colorIndex: n.colorIndex,
          samplingType,
          sampleSizeType: n.sampleSizeType || 'rows',
          sampleSize: n.sampleSize != null ? n.sampleSize : 100,
          rowSpec: (n.rowSpec || '').trim(),
        });
        createdNodes.push(node);
      } else if (n.type === 'run') {
        const runNode = createRunNode({
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
          title: n.runName || 'Run',
        });
        if (n.runName) runNode.dataset.runName = n.runName;
        if (n.runWorkingSetId) runNode.dataset.runWorkingSetId = n.runWorkingSetId;
        if (n.runCredentialId) runNode.dataset.runCredentialId = n.runCredentialId;
        if (n.runInputToColumn) runNode.dataset.runInputToColumn = n.runInputToColumn;
        if (n.runCompleted) runNode.dataset.runCompleted = n.runCompleted;
        if (n.runInputContent) runNode.dataset.runInputContent = n.runInputContent;
        if (n.runResults) {
          let results = [];
          try {
            results = JSON.parse(n.runResults);
            if (Array.isArray(results) && n.runInputContent) {
              let content = null;
              try {
                content = JSON.parse(n.runInputContent);
              } catch (_) {}
              results = embedInputRow(results, content);
            }
            runNode.dataset.runResults = Array.isArray(results) ? JSON.stringify(results) : n.runResults;
          } catch (_) {
            runNode.dataset.runResults = n.runResults;
          }
        }
        if (n.runProgress != null && n.runProgress >= 0 && n.runProgress <= 100) {
          setRunNodeProgress(runNode, n.runProgress, 100);
        } else if (n.runResults && n.runInputContent) {
          try {
            const results = JSON.parse(n.runResults);
            const content = typeof n.runInputContent === 'string' ? JSON.parse(n.runInputContent) : n.runInputContent;
            const totalInputRows = Array.isArray(content?.rows) ? content.rows.length : 0;
            if (Array.isArray(results) && results.length > 0 && totalInputRows > 0) {
              const completed = countCompletedInputRows(results);
              setRunNodeProgress(runNode, completed, totalInputRows);
            }
          } catch (_) {}
        }
        createdNodes.push(runNode);
      } else if (n.type === 'assessment' || n.type === 'score') {
        const scoreNode = createScoreNode({
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
          title: n.scoreName || 'Score',
        });
        if (n.scoreGroundTruthId) scoreNode.dataset.scoreGroundTruthId = n.scoreGroundTruthId;
        if (n.scoreMapping != null) {
          try {
            const tree = parseScoreMappingToTree(n.scoreMapping);
            const hasRules = (tree.type === 'group' && tree.children && tree.children.length > 0) || flattenScoreTreeToRules(tree).length > 0;
            if (hasRules) scoreNode.dataset.scoreMapping = JSON.stringify(tree);
          } catch (_) {}
        }
        if (n.scoreRowExcludedFromScoring && typeof n.scoreRowExcludedFromScoring === 'object') {
          try {
            scoreNode.dataset.scoreRowExcludedFromScoring = JSON.stringify(n.scoreRowExcludedFromScoring);
          } catch (_) {}
        }
        if (n.reviewResult && typeof n.reviewResult === 'string') {
          scoreNode.dataset.reviewResult = n.reviewResult;
        }
        if (n.reviewCredentialId && typeof n.reviewCredentialId === 'string') {
          scoreNode.dataset.reviewCredentialId = n.reviewCredentialId;
        }
        createdNodes.push(scoreNode);
      } else if (n.type === 'promptReview') {
        const promptReviewNode = createPromptReviewNode({
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
          title: n.promptReviewName || 'Review',
        });
        if (n.reviewResult && typeof n.reviewResult === 'string') {
          promptReviewNode.dataset.reviewResult = n.reviewResult;
        }
        if (n.reviewProgress != null && n.reviewProgress >= 0 && n.reviewProgress <= 100) {
          setReviewNodeProgress(promptReviewNode, n.reviewProgress);
        }
        createdNodes.push(promptReviewNode);
      } else {
        const node = createPromptNode({
          name: n.name || '',
          note: n.note || '',
          sections: n.sections || n.fields || [],
          outputFormat: n.outputFormat,
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
        });
        createdNodes.push(node);
      }
    });
    // Apply Run node border color and progress bar color from selected working set (so it shows when loading from JSON)
    createdNodes.forEach((runNode) => {
      if (runNode.classList.contains('workflow-node--run') && runNode.dataset.runWorkingSetId) {
        const wsNode = getNodeById(runNode.dataset.runWorkingSetId);
        if (wsNode && wsNode.classList.contains('workflow-node--dataset')) {
          const colorIndex = wsNode.dataset.datasetColorIndex != null ? parseInt(wsNode.dataset.datasetColorIndex, 10) : 0;
          const color = DATASET_BORDER_COLORS[colorIndex % DATASET_BORDER_COLORS.length];
          runNode.style.borderColor = color;
          const progressBar = runNode.querySelector('.workflow-node__run-progress');
          if (progressBar) progressBar.style.background = color;
        }
      }
    });
    // Apply Score node border color from selected ground truth working set (so it shows when loading from JSON)
    nodesLayer.querySelectorAll('.workflow-node--score').forEach((scoreNode) => {
      const gtId = (scoreNode.dataset.scoreGroundTruthId || '').trim();
      if (!gtId) return;
      const wsNode = getNodeById(gtId);
      if (wsNode && wsNode.classList.contains('workflow-node--dataset')) {
        const colorIndex = wsNode.dataset.datasetColorIndex != null ? parseInt(wsNode.dataset.datasetColorIndex, 10) : 0;
        const color = DATASET_BORDER_COLORS[colorIndex % DATASET_BORDER_COLORS.length];
        scoreNode.style.borderColor = color;
        const progressBar = scoreNode.querySelector('.workflow-node__score-progress');
        if (progressBar) progressBar.style.background = color;
      }
    });
    // Refresh dataset node description: sampler desc or dataset notes (always show body)
    nodesLayer.querySelectorAll('.workflow-node--dataset').forEach((dsNode) => {
      const samplerNodeId = dsNode.dataset.samplerNodeId;
      const samplerNode = samplerNodeId ? getNodeById(samplerNodeId) : null;
      const samplerDesc = formatSamplerDescription(samplerNode);
      const notesTrimmed = (dsNode.dataset.datasetNote || dsNode.dataset.subsetNote || '').trim();
      const bodyText = samplerDesc || notesTrimmed || '';
      let bodyEl = dsNode.querySelector('.workflow-node__dataset-desc');
      if (!bodyEl) {
        bodyEl = document.createElement('div');
        bodyEl.className = 'workflow-node__body workflow-node__dataset-desc';
        dsNode.appendChild(bodyEl);
      }
      dsNode.classList.remove('workflow-node--no-body');
      bodyEl.innerHTML = bodyText ? `<span class="workflow-node__note">${escapeHtml(bodyText)}</span>` : '<span class="workflow-node__note-placeholder">No description.</span>';
    });
    // Normalize connections: support old { from, to } indices and new { fromId, toId, type }; drop edges whose nodes were removed (e.g. sampler)
    const rawConnections = Array.isArray(state.connections) ? state.connections : [];
    connections = rawConnections.map((c) => {
      if (c.fromId != null && c.toId != null) {
        let type = c.type || EDGE_TYPE_PROMPT_TO_PROMPT;
        if (type === 'run-to-assessment') type = EDGE_TYPE_RUN_TO_SCORE;
        if (type === 'score-to-prompt-review') type = EDGE_TYPE_SCORE_TO_PROMPT_REVIEW;
        if (type === 'prompt-review-to-prompt') type = EDGE_TYPE_PROMPT_REVIEW_TO_PROMPT;
        if (type === 'sampler-to-subset') type = EDGE_TYPE_SAMPLER_TO_DATASET;
        if (type === 'subset-to-subset') type = EDGE_TYPE_DATASET_TO_DATASET;
        return { fromId: c.fromId, toId: c.toId, type };
      }
      if (typeof c.from === 'number' && typeof c.to === 'number') {
        const fromNode = createdNodes[c.from];
        const toNode = createdNodes[c.to];
        if (fromNode?.dataset?.nodeId && toNode?.dataset?.nodeId) {
          return {
            fromId: fromNode.dataset.nodeId,
            toId: toNode.dataset.nodeId,
            type: EDGE_TYPE_PROMPT_TO_PROMPT,
          };
        }
      }
      return null;
    }).filter(Boolean).filter((c) => getNodeById(c.fromId) && getNodeById(c.toId));
    nodesLayer.querySelectorAll('.workflow-node--score').forEach((scoreNode) => syncScoreNodeProgressFromUpstreamRun(scoreNode));
    updateContentSize();
    updateEdges();
  }

  function setOnCanvasChange(fn) {
    document.addEventListener('workflow:canvas-changed', fn);
  }

  root.appendChild(canvas);
  return {
    getCanvasState,
    loadCanvasState,
    setOnCanvasChange,
    isPromptNameAlreadyUsed,
    isDatasetNameAlreadyUsed,
    shutdownRunPoll,
  };
}
