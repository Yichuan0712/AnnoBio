/**
 * Workflow canvas (node-based editor surface).
 * Listens for workflow:add-prompt-node to add prompt nodes.
 * Edges use stable node ids and a type field for future extensibility.
 */

import { openPromptDetailModal, extractInputFieldsFromSections } from './promptDetailModal.js';
import { openRunDetailModal, deriveOutputFields } from './runDetailModal.js';
import { openProcessDetailModal } from './processDetailModal.js';
import {
  getNextRowIndex,
  mergeResumeResults,
  embedInputRow,
  processApiResults,
  countCompletedInputRows,
  markEmptyOutputAsError,
} from './runResumeUtils.js';
import { normalizeUnicodeDashesForDisplay, formatResultOutputColumnLabel } from './displayTextNormalize.js';
import { openReviewDetailModal } from './reviewDetailModal.js';
import {
  allocNextReviewSuggestionId,
  ensureReviewResultIds,
  ensureSuggestionObjectId,
  normalizeSuggestionIdsToDisplayOrder,
  parseNumericSuggestionId,
  syncReviewSuggestionSeqNext,
} from './reviewSuggestionIds.js';
import { computeGreedyRunToGtPairing, flattenScoreRules } from './scoreRunGtPairing.js';
import {
  parseScoreMappingBundle,
  serializeScoreMappingBundle,
  emptyScoreRuleGroup,
  scoreBundleRootsForEmbeddingWalk,
} from './scoreMappingBundle.js';
import {
  openScoreDetailModal,
  runReviewFromScore,
  runReviewStart,
  getScoreExportData,
  SCORE_GT_ROW_INDEX_COLUMN,
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
  buildScoreResultDescriptorsInRunOrder,
  attachInputMatchedUnpairedGtDescriptors,
  buildScoreTableGtColumns,
  buildCodeMatchRunToGt,
} from './scoreDetailModal.js';
import { openSamplerDetailModal } from './samplerDetailModal.js';
import { openDatasetDetailModal } from './datasetDetailModal.js';
import { enrichInspectScoreResultWithComparisonRows, inspectWorkflowNode } from './agent/canvas/workflowNodeInspector.js';
import { createWorkflowCanvasNames } from './workflowCanvasNames.js';
import { createWorkflowNodeFactories, formatSamplerDescription } from './workflowNodeFactories.js';
import { createWorkflowCanvasRuntime } from './workflowCanvasRuntime.js';
import { DATASET_BORDER_COLORS, datasetColorAt } from './workflowNodeColors.js';
import { dependencyColorSources, dependentNodeVisualColors } from './workflowDependencyColors.js';
import { showAlert, showConfirm, showSelect } from './alertModal.js';
import { openAgentWindowModal } from './agentWindowModal.js';
import { detectPipelines } from './pipelineDetection.js';
import { showPipelineOverviewModal } from './pipelineOverviewModal.js';
import { createWorkspacePanels } from './workspacePanels.js';
import { mountErrorsPanel, setErrorsPanelAvailable, subscribeAppErrors } from './appErrors.js';
import { mountBackendLogPanel } from './backendLogPanel.js';
import { iconGitCompareArrows, iconLayoutPanel, iconLayoutSidebarRight, iconWorkflow } from './icons.js';
import { runSettingsOverrides, reviewSettingsOverrides } from './nodeSettings.js';
import { BACKEND_API_BASE } from './backendConfig.js';
import { DatasetContentMap, cloneCell, cloneDatasetContent, displayCell, isAssetCell } from './datasetContent.js';
import { openDatasetDiffModal } from './datasetDiffModal.js';
import { readHistoryEdits } from './datasetHistoryEdits.js';
import { resolveDataframeProcessCode } from './processCode.js';
import { buildProcessDatasetBindings, referencedDatasetAliases } from './processDatasetBindings.js';
import { runProcessCode, waitForProcessJob } from './processRunClient.js';
import { getCurrentProjectId, getPipelineProjectId } from './currentProject.js';
import { analysisInputKeys, analysisKeyForSave } from './runAnalysisHistory.js';

/** Same backend as Run/Review (embeddings API). */
const SCORE_BACKEND_BASE = BACKEND_API_BASE;

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

async function resolveReviewCredentialId(scoreNode, preferredCredentialId = '') {
  let id = String(preferredCredentialId || '').trim();
  if (id) return id;
  id = (scoreNode?.dataset?.reviewCredentialId || '').trim();
  if (id) return id;
  try {
    const res = await fetch(`${SCORE_BACKEND_BASE}/api/settings`);
    const settings = res.ok ? await res.json() : null;
    id = settings && settings.default_review_credential_id ? String(settings.default_review_credential_id).trim() : '';
  } catch (_) {}
  return id;
}

const MIN_CONTENT_PADDING = 200;
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
/** Read-only visual edge for the Dataset selected as a Run's input. */
const EDGE_TYPE_DATASET_TO_RUN = 'dataset-to-run';
/** Read-only visual edge for a Dataset materialized from Run results. */
const EDGE_TYPE_RUN_TO_DATASET = 'run-to-dataset';
/** Read-only visual edge for the Dataset selected as a Score's ground truth. */
const EDGE_TYPE_GROUND_TRUTH_TO_SCORE = 'ground-truth-to-score';
/** Edge type for run → score (compare result with ground truth). */
const EDGE_TYPE_RUN_TO_SCORE = 'run-to-score';
/** Edge type for score → prompt review (LLM analyzes results and suggests prompt changes). */
const EDGE_TYPE_SCORE_TO_PROMPT_REVIEW = 'score-to-prompt-review';
const EDGE_TYPE_PROMPT_REVIEW_TO_PROMPT = 'prompt-review-to-prompt';
/** Edge type for dataset → process (run a user-written function over each row, no LLM). */
const EDGE_TYPE_DATASET_TO_PROCESS = 'dataset-to-process';
/** Edge type for process → dataset (exporting Process results creates a connected dataset). */
const EDGE_TYPE_PROCESS_TO_DATASET = 'process-to-dataset';
const EDGE_TYPE_RUN_TO_DATASET_SNAPSHOT = 'run-to-dataset-snapshot';
const EDGE_TYPE_PROCESS_TO_DATASET_SNAPSHOT = 'process-to-dataset-snapshot';

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
  if ((scoreNode?.dataset?.scoreActiveMatchMode || 'rules') === 'code') {
    return buildReviewComparisonRowsFromCodeMatch(scoreNode, runNode, datasetContentByNodeId, promptSections);
  }
  const toCompareStr = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) return v.map((x) => toCompareStr(x)).join(', ').trim();
    return displayCell(v).trim();
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
    if (String(columnName).trim() === SCORE_GT_ROW_INDEX_COLUMN) {
      if (typeof rowIndex !== 'number' || rowIndex < 0) return '';
      return toCompareStr(rowIndex);
    }
    const headers = gtContent.headers || [];
    const rows = gtContent.rows || [];
    const colIdx = headers.findIndex((h) => String(h).trim() === String(columnName).trim());
    if (colIdx >= 0 && rows[rowIndex]) return toCompareStr(rows[rowIndex][colIdx]);
    return '';
  };
  const getGtValueForDisplay = (gtContent, rowIndex, columnName) => {
    if (String(columnName).trim() === SCORE_GT_ROW_INDEX_COLUMN) {
      if (typeof rowIndex !== 'number' || rowIndex < 0) return '';
      return String(rowIndex + 1);
    }
    return getGtValue(gtContent, rowIndex, columnName);
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
  let inputRoot = emptyScoreRuleGroup();
  let outputRoot = emptyScoreRuleGroup();
  try {
    const raw = scoreNode.dataset.scoreMapping || '{}';
    const b = parseScoreMappingBundle(typeof raw === 'string' ? raw : JSON.stringify(raw));
    inputRoot = b.inputRoot;
    outputRoot = b.outputRoot;
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
      out[name] = cloneCell(val);
    }
    return out;
  }

  let excludedFromScoring = {};
  try {
    excludedFromScoring = JSON.parse(scoreNode.dataset.scoreRowExcludedFromScoring || '{}');
  } catch (_) {}

  const rulesFlat = [...flattenScoreRules(inputRoot), ...flattenScoreRules(outputRoot)];
  const gtColsUsed = buildScoreTableGtColumns(rulesFlat, gtSafe);

  const gtRows = gtSafe.rows || [];
  const resultsForScore = (results || []).filter((r) => r);
  const validDedupedResults = resultsForScore.filter((r) => isValidRunOutputForScoreRow(r, outputFields));
  const outputKeysForBundleInference = (outputFields || []).map((f) => String(f.key || '').trim()).filter(Boolean);

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
        root: scoreBundleRootsForEmbeddingWalk(inputRoot, outputRoot),
        results: validDedupedResults,
        outputFields,
        runWs: runWsSafe,
        gtContent: gtSafe,
        getRunValue: (rr, ok, _rowIdx, ws, of) => getRunValue(rr, ok, ws, of),
        getGtValue,
      });
    } catch (_) {
      reviewEmbeddingCosineMap = new Map();
    }
  }
  const gtCount = gtRows.length;
  const maxRunRowIndex = runRowIndices.length ? Math.max(...runRowIndices) : -1;
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
    outputFields,
    ruleMatchesRow,
    getRunValue: getRunValueForPairingBand,
  });

  const gtToRun = new Array(gtCount).fill(-1);
  for (let ii = 0; ii < runToGt.length; ii++) {
    const jj = runToGt[ii];
    if (jj >= 0) gtToRun[jj] = ii;
  }

  function evaluateNodeLocal(node, runRowIndex, gtRowIndex) {
    if (!node) return false;
    if (node.type === 'rule') {
      return ruleMatchesRow(node, runRowIndex, gtRowIndex, resultsByIndex, runWsSafe, outputFields, gtSafe);
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

  /** Same descriptor order as scoreDetailModal.renderResults (unfiltered): run row_index order, then unmatched GT. */
  function treeMatchesPairLocal(rootTree, runRowIndex, gtRowIndex) {
    const leaves = flattenScoreRules(rootTree || emptyScoreRuleGroup());
    if (leaves.length === 0) return true;
    return evaluateNodeLocal(rootTree, runRowIndex, gtRowIndex);
  }
  const scoreDetailDescriptors = attachInputMatchedUnpairedGtDescriptors(
    buildScoreResultDescriptorsInRunOrder({
      runRowIndices,
      runToGt,
      gtToRun,
      gtRowsLength: gtCount,
      evaluateRunMatchesAnyGt: (i) => {
        for (let jj = 0; jj < gtCount; jj++) {
          if (treeMatchesPairLocal(inputRoot, i, jj) && treeMatchesPairLocal(outputRoot, i, jj)) return true;
        }
        return false;
      },
    }),
    {
      runRowIndices,
      runToGt,
      gtToRun,
      inputMatchesPairForRow: (i, jj) => treeMatchesPairLocal(inputRoot, i, jj),
    },
  );
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
      const gtVals = (rule.gtColumns || []).map((col) => getGtValueForDisplay(gtSafe, gtIdxForRules, col));
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

  function isPairMatchLocal(iRun, jGt) {
    if (iRun < 0 || jGt < 0) return false;
    if (!treeMatchesPairLocal(inputRoot, iRun, jGt)) return false;
    const outLeaves = flattenScoreRules(outputRoot || emptyScoreRuleGroup());
    if (outLeaves.length === 0) return true;
    return evaluateNodeLocal(outputRoot, iRun, jGt);
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
    const isFullMatch = gtIdxForRules >= 0 && isPairMatchLocal(runR, gtIdxForRules);
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
      const v = String(getGtValue(gtSafe, gtJ, col) || '').trim();
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
        for (const k of outputKeysForBundleInference) {
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

/**
 * Review payload for "Match by code" runs: sources from the persisted `node.dataset.scoreMatchResult`
 * (input_row/output_row/gt_row dicts already built when the run completed in scoreDetailModal.js)
 * instead of re-deriving pairing from rule trees. Row numbering matches the modal's own Results table
 * via buildCodeMatchRunToGt + the same descriptor helpers rule mode uses.
 */
async function buildReviewComparisonRowsFromCodeMatch(scoreNode, runNode, datasetContentByNodeId, promptSections = []) {
  let lastResult = null;
  try {
    lastResult = JSON.parse(scoreNode.dataset.scoreMatchResult || 'null');
  } catch (_) {}
  if (!lastResult || !Array.isArray(lastResult.runRowIndices)) return [];
  const { runRowIndices, outcomes, runRows, gtRows } = lastResult;

  let results = [];
  try { results = JSON.parse(runNode.dataset.runResults || '[]'); } catch (_) {}
  const resultsByIndex = new Map();
  (results || []).forEach((r) => { if (r) resultsByIndex.set(r.row_index, r); });

  const runWsId = (runNode.dataset.runWorkingSetId || '').trim();
  const runWs = runWsId ? datasetContentByNodeId.get(runWsId) : null;
  const runWsSafe = runWs ? { headers: runWs.headers || [], rows: runWs.rows || [] } : { headers: [], rows: [] };

  let runInputToColumn = {};
  try {
    const parsed = JSON.parse(runNode.dataset.runInputToColumn || '{}');
    if (parsed && typeof parsed === 'object') runInputToColumn = parsed;
  } catch (_) {}
  const promptPlaceholderNames = extractInputFieldsFromSections(Array.isArray(promptSections) ? promptSections : []);
  const hdrsForPrompt = runWsSafe.headers || [];
  function rowInputAsPromptPlaceholders(inpIdx) {
    const wsRow = runWsSafe.rows && runWsSafe.rows[inpIdx] ? runWsSafe.rows[inpIdx] : [];
    const out = {};
    for (const name of promptPlaceholderNames) {
      const col = String(runInputToColumn[name] || '').trim();
      if (!col) { out[name] = ''; continue; }
      const colIdx = hdrsForPrompt.findIndex((h) => String(h).trim() === col);
      const val = colIdx >= 0 ? (wsRow[colIdx] ?? '') : '';
      out[name] = cloneCell(val);
    }
    return out;
  }

  let excludedFromScoring = {};
  try { excludedFromScoring = JSON.parse(scoreNode.dataset.scoreRowExcludedFromScoring || '{}'); } catch (_) {}

  const matchCode = (scoreNode.dataset.scoreMatchCode || '').trim();
  const gtCount = gtRows.length;
  const runToGt = buildCodeMatchRunToGt(lastResult, gtCount);
  const gtToRun = new Array(gtCount).fill(-1);
  for (let i = 0; i < runToGt.length; i++) {
    if (runToGt[i] >= 0) gtToRun[runToGt[i]] = i;
  }

  const scoreDetailDescriptors = attachInputMatchedUnpairedGtDescriptors(
    buildScoreResultDescriptorsInRunOrder({
      runRowIndices,
      runToGt,
      gtToRun,
      gtRowsLength: gtCount,
      evaluateRunMatchesAnyGt: (i) => runToGt[i] >= 0,
    }),
    {
      runRowIndices,
      runToGt,
      gtToRun,
      inputMatchesPairForRow: (i, jj) => runToGt[i] === jj,
    },
  );
  const scoreTableRowByKey = new Map();
  scoreDetailDescriptors.forEach((d, idx) => {
    const n = idx + 1;
    if (d.type === 'gt') scoreTableRowByKey.set(`gt:${d.j}`, n);
    else scoreTableRowByKey.set(`runOnly:${d.i}`, n);
  });

  const rows = [];
  outcomes.forEach((outcome, k) => {
    const runR = runRowIndices[k];
    if (typeof runR !== 'number') return;
    const r = resultsByIndex.get(runR) || null;
    const inpIdx = r?.input_row_index ?? runR;
    const jPaired = outcome.ok && typeof outcome.matched_gt_index === 'number' ? outcome.matched_gt_index : -1;
    const modalKey = jPaired >= 0 ? String(jPaired) : `run:${runR}`;
    if (excludedFromScoring[modalKey]) return;

    const runOutput = (runRows[k] && runRows[k].output_row) || {};
    const matched = jPaired >= 0;
    const groundTruthOutput = matched ? ((gtRows[jPaired] && gtRows[jPaired].gt_row) || {}) : {};
    const expected = !outcome.ok
      ? `Error running match(): ${outcome.error || 'unknown error'}`
      : (matched
        ? 'Matched via custom code (see comparison_types for the match() function).'
        : 'No match (custom code) — see comparison_types for the match() function.');
    const comparison_types = matchCode ? [`Custom code:\n${matchCode}`] : null;
    const row_input = rowInputAsPromptPlaceholders(inpIdx);
    const score_table_row = jPaired >= 0
      ? (scoreTableRowByKey.get(`gt:${jPaired}`) ?? null)
      : (scoreTableRowByKey.get(`runOnly:${runR}`) ?? null);
    rows.push({
      row_index: r?.row_index ?? runR,
      input_row_index: inpIdx,
      matched,
      run_output: runOutput,
      expected,
      comparison_types,
      ground_truth_output: groundTruthOutput,
      row_input,
      gt_only: false,
      source_gt_row_index: jPaired >= 0 ? jPaired : null,
      score_table_row,
    });
  });

  // Ground-truth rows no run row matched: synthetic rows, same convention as rule mode -- but code
  // mode has no rule columns to infer a "same input row" grouping hint from, so row_input is unknown.
  let synthRow = (runRowIndices.length ? Math.max(...runRowIndices) : -1) + 1;
  for (let j = 0; j < gtCount; j++) {
    if (gtToRun[j] >= 0) continue;
    if (excludedFromScoring[String(j)]) continue;
    const score_table_row = scoreTableRowByKey.get(`gt:${j}`) ?? null;
    rows.push({
      row_index: synthRow,
      input_row_index: null,
      matched: false,
      run_output: {},
      expected: 'No matching run row (custom code).',
      comparison_types: matchCode ? [`Custom code:\n${matchCode}`] : null,
      ground_truth_output: (gtRows[j] && gtRows[j].gt_row) || {},
      row_input: null,
      gt_only: true,
      source_gt_row_index: j,
      score_table_row,
    });
    synthRow += 1;
  }

  return rows;
}

function canvasNormalizeNodeId(value) {
  return String(value || '').trim();
}

function buildDatasetContentMapFromCanvasNodes(nodes) {
  const map = new Map();
  for (const n of nodes || []) {
    if (!n || n.type !== 'dataset') continue;
    const id = canvasNormalizeNodeId(n.nodeId);
    const c = n.subsetContent || n.datasetContent;
    if (!id || !c || !Array.isArray(c.headers)) continue;
    map.set(id, { headers: c.headers, rows: Array.isArray(c.rows) ? c.rows : [] });
  }
  return map;
}

function scoreRawToFakeScoreNode(scoreRaw) {
  const sm = scoreRaw?.scoreMapping;
  const mappingStr = sm && typeof sm === 'object' ? JSON.stringify(sm) : (typeof sm === 'string' ? sm : '{}');
  const ex = scoreRaw?.scoreRowExcludedFromScoring;
  const exStr = ex == null ? '' : (typeof ex === 'string' ? ex : JSON.stringify(ex));
  return {
    dataset: {
      scoreMapping: mappingStr,
      scoreGroundTruthId: canvasNormalizeNodeId(scoreRaw?.scoreGroundTruthId),
      scoreRowExcludedFromScoring: exStr,
    },
  };
}

function runRawToFakeRunNode(runRaw) {
  const ric = runRaw?.runInputToColumn;
  const ricStr = typeof ric === 'string' ? ric : JSON.stringify(ric && typeof ric === 'object' ? ric : {});
  return {
    dataset: {
      runResults: runRaw?.runResults || '[]',
      runOutputFields: runRaw?.runOutputFields || '[]',
      runWorkingSetId: canvasNormalizeNodeId(runRaw?.runWorkingSetId),
      runInputToColumn: ricStr,
    },
  };
}

function resolveLiveScoreComparisonContext(canvasState, scoreRaw) {
  const nodes = Array.isArray(canvasState?.nodes) ? canvasState.nodes : [];
  const connections = Array.isArray(canvasState?.connections) ? canvasState.connections : [];
  const scoreId = canvasNormalizeNodeId(scoreRaw?.nodeId);
  if (!scoreId) return null;

  const runEdge = connections.find(
    (c) => String(c?.type || '').trim() === 'run-to-score' && canvasNormalizeNodeId(c?.toId) === scoreId,
  );
  if (!runEdge) return null;

  const nodeById = new Map(nodes.map((n) => [canvasNormalizeNodeId(n?.nodeId), n]));
  const runRaw = nodeById.get(canvasNormalizeNodeId(runEdge.fromId));
  if (!runRaw || runRaw.type !== 'run') return null;

  const runId = canvasNormalizeNodeId(runRaw.nodeId);
  const promptEdge = connections.find(
    (c) => String(c?.type || '').trim() === 'prompt-to-run' && canvasNormalizeNodeId(c?.toId) === runId,
  );
  if (!promptEdge) return null;

  const promptRaw = nodeById.get(canvasNormalizeNodeId(promptEdge.fromId));
  if (!promptRaw || promptRaw.type !== 'prompt') return null;

  const gtId = canvasNormalizeNodeId(scoreRaw.scoreGroundTruthId);
  const wsId = canvasNormalizeNodeId(runRaw.runWorkingSetId);
  if (!gtId || !wsId) return null;

  const datasetMap = buildDatasetContentMapFromCanvasNodes(nodes);
  if (!datasetMap.has(gtId) || !datasetMap.has(wsId)) return null;

  const promptSections = Array.isArray(promptRaw.sections) ? promptRaw.sections : [];
  if (promptSections.length === 0) return null;

  return {
    scoreEl: scoreRawToFakeScoreNode(scoreRaw),
    runEl: runRawToFakeRunNode(runRaw),
    datasetMap,
    promptSections,
  };
}

/** Invisible stroke width for edge hit area (px). */
const EDGE_HIT_STROKE_WIDTH = 16;

/** Horizontal gap when placing a new node to the right of its parent (source → sampler, sampler → dataset, duplicate prompt). */
const NEW_NODE_OFFSET = 40;

function generateNodeId() {
  return 'n_' + Date.now() + '_' + (Math.random() * 1e9 | 0);
}

export function buildWorkflowCanvas(root, options = {}) {
  const getCurrentProjectPath =
    options && typeof options.getCurrentProjectPath === 'function'
      ? options.getCurrentProjectPath
      : () => '';
  const isElectron = !!options.isElectron;
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

  // Marquee (box) select — Ctrl/Shift+drag on empty canvas, in place of the plain-drag pan above.
  // Tracked in plain viewport (client) coordinates throughout, compared against each node's own
  // getBoundingClientRect(): both are already in the same space, so no zoom/scroll math is needed
  // (unlike node dragging, which works in un-scaled canvas-content coordinates instead).
  const marqueeEl = document.createElement('div');
  marqueeEl.className = 'workflow-canvas__marquee';
  document.body.appendChild(marqueeEl);
  let marqueeStartX = 0;
  let marqueeStartY = 0;
  /** Selection as it stood before this marquee drag started — toggle mode diffs against this, not the live selection, so growing/shrinking the rectangle stays reversible. */
  let marqueeBaseline = new Set();
  /** @type {'add'|'toggle'} */
  let marqueeMode = 'add';

  function rectsIntersect(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function onMarqueeMove(e) {
    const rect = {
      left: Math.min(marqueeStartX, e.clientX),
      top: Math.min(marqueeStartY, e.clientY),
      right: Math.max(marqueeStartX, e.clientX),
      bottom: Math.max(marqueeStartY, e.clientY),
    };
    marqueeEl.style.left = `${rect.left}px`;
    marqueeEl.style.top = `${rect.top}px`;
    marqueeEl.style.width = `${rect.right - rect.left}px`;
    marqueeEl.style.height = `${rect.bottom - rect.top}px`;

    const hits = new Set();
    nodesLayer.querySelectorAll('.workflow-node').forEach((node) => {
      if (rectsIntersect(rect, node.getBoundingClientRect())) hits.add(node.dataset.nodeId);
    });
    const next = new Set(marqueeBaseline);
    hits.forEach((id) => {
      if (marqueeMode === 'toggle' && marqueeBaseline.has(id)) next.delete(id);
      else next.add(id);
    });
    selectedNodeIds = next;
    applySelectionVisuals();
  }
  function onMarqueeEnd() {
    marqueeEl.classList.remove('workflow-canvas__marquee--active');
    document.removeEventListener('pointermove', onMarqueeMove);
    document.removeEventListener('pointerup', onMarqueeEnd);
    document.removeEventListener('pointercancel', onMarqueeEnd);
  }
  function startMarqueeSelect(e) {
    marqueeStartX = e.clientX;
    marqueeStartY = e.clientY;
    marqueeBaseline = new Set(selectedNodeIds);
    marqueeMode = e.ctrlKey ? 'toggle' : 'add';
    marqueeEl.style.left = `${e.clientX}px`;
    marqueeEl.style.top = `${e.clientY}px`;
    marqueeEl.style.width = '0px';
    marqueeEl.style.height = '0px';
    marqueeEl.classList.add('workflow-canvas__marquee--active');
    document.addEventListener('pointermove', onMarqueeMove);
    document.addEventListener('pointerup', onMarqueeEnd, { once: true });
    document.addEventListener('pointercancel', onMarqueeEnd, { once: true });
  }

  scrollWrapper.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.workflow-node, .workflow-canvas__zoom-toolbar, .workflow-edge--compare')) return;
    e.preventDefault();
    if (e.ctrlKey || e.shiftKey) {
      startMarqueeSelect(e);
      return;
    }
    clearSelection();
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
  let lastAutoNodeColorIndex = -1;
  const STAGGER = 36;
  /** @type {{ fromId: string, toId: string, type: string }[]} */
  let connections = [];

  /** @type {Set<string>} Multi-selected node ids — Ctrl/Shift+click or marquee-select (see startMarqueeSelect). */
  let selectedNodeIds = new Set();

  function applySelectionVisuals() {
    nodesLayer.querySelectorAll('.workflow-node').forEach((node) => {
      node.classList.toggle('workflow-node--selected', selectedNodeIds.has(node.dataset.nodeId));
    });
  }

  function highlightPipelineNodes(nodeIds = []) {
    const highlightedIds = new Set((Array.isArray(nodeIds) ? nodeIds : [])
      .map((nodeId) => String(nodeId || '').trim())
      .filter(Boolean));
    nodesLayer.querySelectorAll('.workflow-node').forEach((node) => {
      node.classList.toggle(
        'workflow-node--pipeline-highlighted',
        highlightedIds.has(node.dataset.nodeId),
      );
    });
  }

  function focusPipelineNodes(nodeIds = []) {
    const nodes = nodeIds.map(getNodeById).filter(Boolean);
    if (!nodes.length) return;
    highlightPipelineNodes(nodeIds);
    const left = Math.min(...nodes.map((node) => parseFloat(node.style.left) || 0));
    const top = Math.min(...nodes.map((node) => parseFloat(node.style.top) || 0));
    const right = Math.max(...nodes.map((node) => (parseFloat(node.style.left) || 0) + node.offsetWidth));
    const bottom = Math.max(...nodes.map((node) => (parseFloat(node.style.top) || 0) + node.offsetHeight));
    scrollWrapper.scrollTo({
      left: Math.max(0, (left + right) / 2 * zoomLevel - scrollWrapper.clientWidth / 2),
      top: Math.max(0, (top + bottom) / 2 * zoomLevel - scrollWrapper.clientHeight / 2),
      behavior: 'smooth',
    });
  }

  function clearSelection() {
    if (selectedNodeIds.size === 0) return;
    selectedNodeIds = new Set();
    applySelectionVisuals();
  }

  function isNodeSelected(nodeId) {
    return selectedNodeIds.has(nodeId);
  }

  function getSelectedNodeIds() {
    return selectedNodeIds;
  }

  /** @param {'add'|'toggle'} mode */
  function toggleNodeSelection(nodeId, mode) {
    const next = new Set(selectedNodeIds);
    if (mode === 'toggle') {
      if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
    } else {
      next.add(nodeId);
    }
    selectedNodeIds = next;
    applySelectionVisuals();
  }

  /** @type {Map<string, { headers: string[], rows: string[][] }>} nodeId -> dataset content (imported or sampled) */
  const datasetContentByNodeId = new DatasetContentMap();

  function getProcessDatasets(processNode) {
    const datasets = Array.from(nodesLayer.querySelectorAll('.workflow-node--dataset'))
      .map((datasetNode) => {
        const colorIndex = normalizeDatasetColorIndex(datasetNode.dataset.datasetColorIndex) ?? 0;
        return {
          nodeId: datasetNode.dataset.nodeId,
          name: datasetNode.dataset.datasetName || 'Dataset',
          color: datasetColorAt(colorIndex),
          content: datasetContentByNodeId.get(datasetNode.dataset.nodeId),
          missingResult: datasetNode.dataset.resultMissing === '1',
        };
      })
      .filter((dataset) => dataset.content);
    const incoming = connections.find((connection) => (
      connection.toId === processNode?.dataset?.nodeId && connection.type === EDGE_TYPE_DATASET_TO_PROCESS
    ));
    const primaryDatasetId = datasets.some((dataset) => dataset.nodeId === processNode?.dataset?.processPrimaryDatasetId)
      ? processNode.dataset.processPrimaryDatasetId
      : (incoming?.fromId || '');
    if (primaryDatasetId && processNode?.dataset) processNode.dataset.processPrimaryDatasetId = primaryDatasetId;
    return { datasets, primaryDatasetId };
  }

  function syncProcessDependencies(processNode, code) {
    const { datasets, primaryDatasetId } = getProcessDatasets(processNode);
    const bindings = buildProcessDatasetBindings(datasets, primaryDatasetId);
    processNode.dataset.processDatasetAliases = JSON.stringify(Object.fromEntries(bindings.map((binding) => [binding.nodeId, binding.alias])));
    const referenced = referencedDatasetAliases(code, bindings);
    const required = new Set([primaryDatasetId, ...referenced]);
    const processId = processNode?.dataset?.nodeId || '';
    connections = connections.filter((connection) => !(
      connection.toId === processId && connection.type === EDGE_TYPE_DATASET_TO_PROCESS
    ));
    bindings.filter((binding) => required.has(binding.nodeId)).forEach((binding) => {
      connections.push({ fromId: binding.nodeId, toId: processId, type: EDGE_TYPE_DATASET_TO_PROCESS });
    });
    updateEdges();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  }

  /** Every image/PDF asset id any dataset node's asset cells currently reference — the "keep" set
   * for pruneUnusedImageAssets (see renderer.js): anything in the project's asset registry that
   * ISN'T in this set is safe to delete. */
  function getUsedAssetIds() {
    const ids = new Set();
    datasetContentByNodeId.forEach((content) => {
      (content.rows || []).forEach((row) => {
        row.forEach((cell) => {
          if (isAssetCell(cell)) cell.assetIds.forEach((id) => ids.add(id));
        });
      });
    });
    return Array.from(ids);
  }

  /** Whether a dataset node's content has any image/PDF cell with at least one asset — used to
   * warn on delete that undo can't bring the asset files back (unused assets are pruned on
   * autosave, which can happen before an undo, so a restored cell can end up pointing at deleted
   * files). */
  function nodeHasImageCells(nodeId) {
    const content = datasetContentByNodeId.get(nodeId);
    if (!content) return false;
    return (content.rows || []).some((row) =>
      row.some((cell) => isAssetCell(cell) && cell.assetIds && cell.assetIds.length > 0),
    );
  }

  const IMAGE_UNDO_WARNING =
    " It contains images or PDFs — undo can bring back the row, but not those files themselves, since unused assets are cleaned up automatically and may already be gone.";

  /** Pending Run jobs: nodeId -> runId. Poll backend and update Run node when done. */
  const pendingRuns = new Map();
  const pendingProcesses = new Set();
  const pendingRunHistoryRecords = new Map();
  async function persistRunHistoryProgress(nodeId, status, results, outputFields) {
    const record = pendingRunHistoryRecords.get(nodeId);
    if (!record || !historySession?.projectId || canvasHistoryVersion !== 1) return;
    const node = getNodeById(nodeId);
    const progress = Number(node?.querySelector('.workflow-node__run-progress')?.getAttribute('aria-valuenow') || 0);
    const updated = {
      ...record, status, updatedAt: new Date().toISOString(),
      summary: { ...record.summary, errorCount: results.filter((item) => item?.error).length },
      results: {
        runResults: results,
        runInputContent: JSON.parse(node.dataset.runInputContent || 'null'),
        runOutputFields: Array.isArray(outputFields) ? outputFields : [],
        runProgress: progress,
      },
    };
    await historySession.putRecord(updated);
    if (status === 'completed' || status === 'stopped' || status === 'failed') pendingRunHistoryRecords.delete(nodeId);
    else pendingRunHistoryRecords.set(nodeId, updated);
  }
  /** Pending Review jobs: reviewNodeId -> reviewId. Poll backend and update Review node when done (like Run). */
  const pendingReviews = new Map();
  /** Review nodes currently streaming (UI progress); used for delete-confirm "cancel job" messaging. */
  const pendingReviewNodeIds = new Set();
  function normalizeDatasetColorIndex(value) {
    if (!Array.isArray(DATASET_BORDER_COLORS) || DATASET_BORDER_COLORS.length === 0) return 0;
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return parsed % DATASET_BORDER_COLORS.length;
  }
  function chooseAutomaticNodeColorIndex() {
    if (!Array.isArray(DATASET_BORDER_COLORS) || DATASET_BORDER_COLORS.length === 0) return 0;
    const usageCounts = Array(DATASET_BORDER_COLORS.length).fill(0);
    nodesLayer.querySelectorAll('.workflow-node--dataset, .workflow-node--prompt').forEach((existingNode) => {
      const existingIndex = normalizeDatasetColorIndex(
        existingNode.dataset.datasetColorIndex ?? existingNode.dataset.promptColorIndex,
      );
      if (existingIndex != null) usageCounts[existingIndex] += 1;
    });
    const minUsage = usageCounts.reduce((min, count) => Math.min(min, count), Number.POSITIVE_INFINITY);
    const startIndex = lastAutoNodeColorIndex >= 0
      ? ((lastAutoNodeColorIndex + 1) % DATASET_BORDER_COLORS.length)
      : 0;
    for (let offset = 0; offset < DATASET_BORDER_COLORS.length; offset += 1) {
      const candidateIndex = (startIndex + offset) % DATASET_BORDER_COLORS.length;
      if (usageCounts[candidateIndex] === minUsage) {
        lastAutoNodeColorIndex = candidateIndex;
        return candidateIndex;
      }
    }
    lastAutoNodeColorIndex = startIndex;
    return startIndex;
  }
  function allocateNodePosition(left, top) {
    const x = typeof left === 'number' ? left : 80 + (nodeCount % 5) * (280 + STAGGER);
    const y = typeof top === 'number' ? top : 80 + Math.floor(nodeCount / 5) * (120 + STAGGER);
    nodeCount += 1;
    return { left: x, top: y };
  }
  function registerPendingReview(nodeId, reviewId) {
    if (nodeId && reviewId) pendingReviews.set(nodeId, reviewId);
  }
  function unregisterPendingReview(nodeId) {
    if (nodeId) pendingReviews.delete(nodeId);
  }
  const RUN_API_BASE = BACKEND_API_BASE;
  function registerPendingRun(nodeId, runId) {
    if (nodeId && runId) pendingRuns.set(nodeId, runId);
  }
  function unregisterPendingRun(nodeId) {
    // History needs the terminal cancelled payload to persist the partial result and stop state.
    if (nodeId && !(historySession?.projectId && canvasHistoryVersion === 1)) pendingRuns.delete(nodeId);
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
      const raw = scoreNode.dataset.scoreMapping || '{}';
      const { inputRoot: ir, outputRoot: or } = parseScoreMappingBundle(typeof raw === 'string' ? raw : JSON.stringify(raw));
      const rules = [...flattenScoreRules(ir), ...flattenScoreRules(or)];
      return rules.some((r) => (r.outputKey || '').trim() && Array.isArray(r.gtColumns) && r.gtColumns.some((c) => String(c || '').trim()));
    } catch (_) {
      return false;
    }
  }
  /** "Match by code" has no rule tree -- a completed run (persisted by scoreDetailModal.js) is its own readiness signal. */
  function scoreNodeHasCodeMatchResult(scoreNode) {
    return !!(scoreNode && scoreNode.dataset && scoreNode.dataset.scoreMatchResult);
  }
  function scoreNodeIsReadyForScoring(scoreNode) {
    const gtId = (scoreNode?.dataset?.scoreGroundTruthId || '').trim();
    return !!gtId && getNodeById(gtId)?.dataset?.resultMissing !== '1'
      && (scoreNodeHasCompleteRules(scoreNode) || scoreNodeHasCodeMatchResult(scoreNode));
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
  let jobPollBusy = false;

  /** Poll only runs that are already in pendingRuns (started in this session or restored when user opened Run modal). No by-node loop here; restore is done in runDetailModal when modal opens. */
  const runPollIntervalId = setInterval(async () => {
    if (runPollStopped || jobPollBusy) return;
    jobPollBusy = true;
    try {
    for (const [nodeId, runId] of pendingRuns) {
      if (runPollStopped) return;
      try {
        const res = await fetch(`${RUN_API_BASE}/api/run/result/${runId}`);
        const data = await res.json().catch(() => ({}));
        if (pendingRuns.get(nodeId) !== runId) continue;
        const node = getNodeById(nodeId);
        if (!node) {
          const record = pendingRunHistoryRecords.get(nodeId);
          if (record && historySession?.projectId && canvasHistoryVersion === 1) {
            await historySession.putRecord({ ...record, status: 'failed', updatedAt: new Date().toISOString(), error: 'The Run node was removed while its job ran.' });
            pendingRunHistoryRecords.delete(nodeId);
          }
          pendingRuns.delete(nodeId);
          continue;
        }
        if (res.status === 404) {
          const record = pendingRunHistoryRecords.get(nodeId);
          if (record && historySession?.projectId && canvasHistoryVersion === 1) {
            await historySession.putRecord({
              ...record,
              status: 'stopped',
              updatedAt: new Date().toISOString(),
              error: 'The Run was interrupted when the app closed. Resume to process the remaining rows.',
            });
            node.dataset.runResumable = '1';
            pendingRunHistoryRecords.delete(nodeId);
          }
          pendingRuns.delete(nodeId);
          document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
          continue;
        }
        const tracked = pendingRunHistoryRecords.get(nodeId);
        if (tracked && historySession?.projectId && canvasHistoryVersion === 1) {
          const current = await historySession.resolve(getCanvasState());
          if (current.currentRecordIds[nodeId] !== tracked.id) {
            await fetch(`${RUN_API_BASE}/api/run/cancel/${runId}`, { method: 'POST' }).catch(() => {});
            await historySession.putRecord({
              ...tracked, status: 'stopped', updatedAt: new Date().toISOString(),
              error: 'Inputs changed while this Run was active.',
            });
            pendingRunHistoryRecords.delete(nodeId);
            pendingRuns.delete(nodeId);
            document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
            continue;
          }
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
            await persistRunHistoryProgress(nodeId, 'running', partialResults, outputFields);
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
          const inputRowsCompleted = data.status === 'done'
            ? total
            : Math.min(total, startIndex + (data.completed ?? countCompletedInputRows(results)));
          setRunNodeProgress(node, inputRowsCompleted, total);
          if (data.status === 'done') {
            node.dataset.runCompleted = '1';
            delete node.dataset.runResumable;
          } else {
            delete node.dataset.runCompleted;
            node.dataset.runResumable = '1';
          }
          if (data.status === 'done' && data.error && results.length === 0) {
            results = [{ row_index: 0, output: null, error: data.error }];
            outputFields = [];
            node.dataset.runResults = JSON.stringify(results);
          } else {
            node.dataset.runResults = JSON.stringify(results);
          }
          await persistRunHistoryProgress(nodeId, data.status === 'done' ? 'completed' : 'stopped', results, outputFields);
          document.dispatchEvent(new CustomEvent('workflow:run-results-updated', { detail: { nodeId, results, outputFields, isComplete: true, cancelled: data.status === 'cancelled', error: data.error || '' } }));
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
    } finally {
      jobPollBusy = false;
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
        const planReviewNode = getNodeById(reviewNodeId);
        let planStages = [];
        try {
          planStages = JSON.parse(planReviewNode?.dataset.reviewStages || '[]');
        } catch (_) {}
        streamSaved = {
          ...streamSaved,
          summary: ev.summary || '',
          suggestions: [],
          data_refinement: [],
          row_diagnostics: [],
          stage_log: [],
          streamComplete: false,
          diagnosisComplete: dt === 0,
          reviewProgress: REVIEW_STREAM_PLAN_PCT,
          review_method_id: planReviewNode?.dataset.reviewMethodId || '',
          review_stages: Array.isArray(planStages) ? planStages : [],
          supports_segment_optimization: planReviewNode?.dataset.supportsSegmentOptimization !== '0',
        };
        /* Poll replays all events from `plan` each tick; clearing lists without resetting the id cursor made
         * `allocNextReviewSuggestionId` continue from disk — # on cards crept up every poll. */
        streamSaved.review_suggestion_seq_next = 1;
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
          const iid = ev.input_index != null ? parseInt(ev.input_index, 10) : NaN;
          if (!Number.isNaN(iid)) {
            const list = Array.isArray(streamSaved.row_diagnostics) ? streamSaved.row_diagnostics.slice() : [];
            const rowIndicesRaw = Array.isArray(ev.row_indices) ? ev.row_indices : [];
            const row_indices = rowIndicesRaw.map((x) => parseInt(x, 10)).filter((x) => !Number.isNaN(x));
            const entry = {
              input_index: iid,
              row_indices,
              card_title: String(ev.opinion.card_title || ''),
              issue_summary: String(ev.opinion.issue_summary || ''),
              rough_modification_opinion: String(ev.opinion.rough_modification_opinion || ''),
              problem_category_hint: String(ev.opinion.problem_category_hint || ''),
              gt_suspect_note: String(ev.opinion.gt_suspect_note || ''),
            };
            const idx = list.findIndex((x) => x && Number(x.input_index) === iid);
            if (idx >= 0) list[idx] = entry;
            else list.push(entry);
            list.sort((a, b) => Number(a.input_index) - Number(b.input_index));
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
      } else if (ev.type === 'stage' && ev.stage_id) {
        /* Generic step event for review methods other than the built-in one (backend/review_methods.py). */
        const stageLog = Array.isArray(streamSaved.stage_log) ? streamSaved.stage_log.slice() : [];
        stageLog.push({
          stage_id: String(ev.stage_id),
          kind: String(ev.kind || 'note'),
          payload: ev.payload && typeof ev.payload === 'object' ? ev.payload : {},
        });
        streamSaved.stage_log = stageLog;
        /* Generic progress: place the latest-seen declared stage at an even fraction of the bar (no per-stage
         * item counts to weight by, unlike diagnosis_row above), reserving the tail for `done`. Never regresses
         * a percent already reached (e.g. by `plan`/`suggestions`), since events can arrive out of stage order. */
        const stages = Array.isArray(streamSaved.review_stages) ? streamSaved.review_stages : [];
        if (stages.length > 0) {
          const seenIds = new Set(stageLog.map((s) => s.stage_id));
          let lastSeenIdx = -1;
          stages.forEach((s, i) => {
            if (seenIds.has(String(s.id))) lastSeenIdx = Math.max(lastSeenIdx, i);
          });
          if (lastSeenIdx >= 0) {
            const pct = Math.min(95, Math.round(((lastSeenIdx + 1) / stages.length) * 90));
            const prevPct = Number.isFinite(streamSaved.reviewProgress) ? streamSaved.reviewProgress : 0;
            if (pct > prevPct) {
              setReviewNodeProgress(getNodeById(reviewNodeId), pct);
              streamSaved.reviewProgress = pct;
            }
          }
        }
      } else if (ev.type === 'done') {
        const finalizePct = 100;
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
    let msg = 'Delete this node? You can undo this with Ctrl+Z.';
    if (runBusy || reviewBusy) {
      msg =
        "Delete this node? A job is still running on it; deleting will cancel that run or review on the server — that part can't be undone.";
    }
    if (nodeHasImageCells(nodeId)) {
      msg += IMAGE_UNDO_WARNING;
    }
    const ok = await showConfirm(msg, { title: 'Delete node', confirmText: 'Delete' });
    if (!ok) return;
    doDelete();
  }

  function getNodeKind(node) {
    if (node.classList.contains('workflow-node--dataset')) return 'dataset';
    if (node.classList.contains('workflow-node--sampler')) return 'sampler';
    if (node.classList.contains('workflow-node--process')) return 'process';
    if (node.classList.contains('workflow-node--run')) return 'run';
    if (node.classList.contains('workflow-node--score')) return 'score';
    if (node.classList.contains('workflow-node--prompt-review')) return 'promptReview';
    return 'prompt';
  }

  /**
   * Same rule as getWorkflowNodeDeleteBlockReason, except a reference from another node that's
   * ALSO being deleted in this batch doesn't count as blocking — only a reference from outside
   * the batch does. Used by deleteSelectedNodes() so selecting a connected pair (e.g. a Prompt and
   * its Run) and deleting them together doesn't get blocked by their own connection to each other.
   * @param {Set<string>} batchIds
   */
  function getWorkflowNodeDeleteBlockReasonForBatch(nodeId, kind, batchIds) {
    const outsideOutgoing = getOutgoingEdgesFromNode(nodeId).filter((c) => !batchIds.has(c.toId));
    if (outsideOutgoing.length > 0) return { blocked: true, reason: 'downstream' };
    if (kind === 'dataset') {
      const usedByRun = Array.from(nodesLayer.querySelectorAll('.workflow-node--run')).some(
        (n) => (n.dataset.runWorkingSetId || '').trim() === nodeId && !batchIds.has(n.dataset.nodeId),
      );
      const usedByScore = Array.from(nodesLayer.querySelectorAll('.workflow-node--score')).some(
        (n) => (n.dataset.scoreGroundTruthId || '').trim() === nodeId && !batchIds.has(n.dataset.nodeId),
      );
      if (usedByRun || usedByScore) return { blocked: true, reason: 'dataset_ref' };
    }
    return { blocked: false };
  }

  /** Delete every currently-selected node in one confirm + one undo step. Falls back to the
   * single-node path (with its existing messaging) when only one node is selected. */
  async function deleteSelectedNodes() {
    const ids = Array.from(selectedNodeIds);
    if (ids.length === 0) return;
    if (ids.length === 1) {
      const node = getNodeById(ids[0]);
      if (!node) return;
      const kind = getNodeKind(node);
      await handleWorkflowNodeDeleteClick(ids[0], kind, () => {
        removeConnectionsInvolvingNodeId(ids[0]);
        node.remove();
        selectedNodeIds.delete(ids[0]);
        updateContentSize();
        updateEdges();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      });
      return;
    }

    const batchIds = new Set(ids);
    const deletable = [];
    let blockedCount = 0;
    ids.forEach((id) => {
      const node = getNodeById(id);
      if (!node) return;
      const kind = getNodeKind(node);
      const block = getWorkflowNodeDeleteBlockReasonForBatch(id, kind, batchIds);
      if (block.blocked) blockedCount += 1;
      else deletable.push({ id, node, kind });
    });

    if (deletable.length === 0) {
      showAlert(
        "None of the selected nodes can be deleted — they're all still referenced by nodes outside the selection.",
        { title: 'Cannot delete' },
      );
      return;
    }

    const anyBusy = deletable.some(
      ({ id, kind }) =>
        (kind === 'run' && pendingRuns.has(id)) ||
        (kind === 'promptReview' && (pendingReviews.has(id) || pendingReviewNodeIds.has(id))),
    );
    let msg = `Delete ${deletable.length} node${deletable.length > 1 ? 's' : ''}? You can undo this with Ctrl+Z.`;
    if (anyBusy) {
      msg = `Delete ${deletable.length} node${deletable.length > 1 ? 's' : ''}? Some have a job still running; deleting them will cancel that run or review on the server — that part can't be undone.`;
    }
    if (deletable.some(({ id }) => nodeHasImageCells(id))) {
      msg += IMAGE_UNDO_WARNING;
    }
    if (blockedCount > 0) {
      msg += ` (${blockedCount} other selected node${blockedCount > 1 ? 's' : ''} can't be deleted — still referenced outside the selection — and will be left alone.)`;
    }
    const ok = await showConfirm(msg, { title: 'Delete nodes', confirmText: 'Delete' });
    if (!ok) return;

    deletable.forEach(({ id, node }) => {
      removeConnectionsInvolvingNodeId(id);
      node.remove();
      selectedNodeIds.delete(id);
    });
    applySelectionVisuals();
    updateContentSize();
    updateEdges();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
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

  function isRunNameAlreadyUsedForPrompt(nameToCheck, excludeRunNodeId = null) {
    const promptEdge = connections.find((c) => c.toId === excludeRunNodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN);
    if (!promptEdge) return false;
    return isRunNameAlreadyUsedForPromptNodeId(nameToCheck, promptEdge.fromId, excludeRunNodeId);
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

  function countSampledDatasetsForSampler(samplerNodeId) {
    let count = 0;
    nodesLayer.querySelectorAll('.workflow-node--dataset').forEach((dsNode) => {
      if ((dsNode.dataset.samplerNodeId || '') === samplerNodeId) count += 1;
    });
    return count;
  }

  function prepareSampledDatasetFromSampler({
    samplerNodeId = '',
    name = '',
    notes = '',
    left,
    top,
  } = {}) {
    const normalizedSamplerNodeId = String(samplerNodeId || '').trim();
    if (!normalizedSamplerNodeId) {
      throw new Error('Sampler node id is required.');
    }
    const samplerNode = getNodeById(normalizedSamplerNodeId);
    if (!samplerNode || !samplerNode.classList.contains('workflow-node--sampler')) {
      throw new Error('Sampler node was not found.');
    }

    const existingCount = countSampledDatasetsForSampler(normalizedSamplerNodeId);

    const sourceNodeId = samplerNode.dataset.sourceNodeId;
    const sourceContent = sourceNodeId ? datasetContentByNodeId.get(sourceNodeId) : null;
    if (!sourceContent?.headers?.length || !Array.isArray(sourceContent.rows)) {
      throw new Error('Sampler source dataset has no available content.');
    }

    const samplingType = samplerNode.dataset.samplerSamplingType || 'without-replacement';
    const datasetHeaders = sourceContent.headers.slice();
    let datasetRows = [];
    if (samplingType === 'specify-rows') {
      const rowSpec = (samplerNode.dataset.samplerRowSpec || '').trim();
      const totalRows = sourceContent.rows.length;
      const indices = parseRowSpec(rowSpec, totalRows);
      datasetRows = indices.map((i) => sourceContent.rows[i].slice());
    } else {
      const sampleSize = parseInt(samplerNode.dataset.samplerSampleSize, 10) || 100;
      const sampleSizeType = samplerNode.dataset.samplerSampleSizeType || 'ratio';
      const totalRows = sourceContent.rows.length;
      const requestedCount = sampleSizeType === 'rows'
        ? Math.max(0, Math.floor(sampleSize))
        : Math.max(0, Math.floor((totalRows * sampleSize) / 100));
      if (samplingType === 'without-replacement' && requestedCount > 0) {
        let alreadyUsed = 0;
        nodesLayer.querySelectorAll('.workflow-node--dataset').forEach((dsNode) => {
          if ((dsNode.dataset.samplerNodeId || '') === normalizedSamplerNodeId) {
            const content = datasetContentByNodeId.get(dsNode.dataset.nodeId);
            if (content?.rows?.length) alreadyUsed += content.rows.length;
          }
        });
        const remaining = totalRows - alreadyUsed;
        if (remaining < requestedCount) {
          throw new Error('Not enough remaining data to create a new dataset when sampling without replacement.');
        }
      }
      datasetRows = sampleRows(sourceContent.rows, sampleSize, sampleSizeType, samplingType);
    }

    return {
      sourceNodeId: String(sourceNodeId || '').trim(),
      existingCount,
      datasetHeaders,
      datasetRows,
      datasetColumnTypes: sourceContent.columnTypes?.slice(),
      datasetRowIds: datasetRows.map(() => crypto.randomUUID()),
      datasetName: (name && name.trim()) ? name.trim() : findNextWorkingDatasetName(normalizedSamplerNodeId),
      datasetNotes: notes || formatSamplerDescription(samplerNode),
      startLeft: typeof left === 'number'
        ? left
        : (parseFloat(samplerNode.style.left) || 0) + (samplerNode.offsetWidth || 280) + NEW_NODE_OFFSET,
      startTop: typeof top === 'number' ? top : (parseFloat(samplerNode.style.top) || 0),
    };
  }

  /**
   * Draw a single edge into SVG group g. Override per edge type for different visuals/anchors.
   * @param {SVGGElement} g
   * @param {{ fromId: string, toId: string, type: string }} edge
   * @param {number} edgeIndex - index in connections (for data-edge-index / future click)
   */
  const RUN_NODE_FALLBACK_HEIGHT = 40;
  const EDGE_CURVE_MIN_VERTICAL_DELTA = 96;
  const EDGE_CURVE_SLOPE_THRESHOLD = 0.75;
  const EDGE_NODE_CLEARANCE = 12;
  // Tried in order, so an earlier ratio wins ties: the midpoint is the default and the outer
  // ones are only reached when nodes sit in the way.
  const EDGE_CORRIDOR_RATIOS = [0.5, 0.35, 0.65, 0.2, 0.8];

  /**
   * Measure every node once per repaint. updateEdges() runs on every pointer move while a node is
   * dragged, so the corridor search must not re-query and re-measure the DOM for each edge.
   */
  function collectNodeBoxes() {
    return Array.from(nodesLayer.querySelectorAll('.workflow-node')).map((node) => {
      const left = parseFloat(node.style.left) || 0;
      const top = parseFloat(node.style.top) || 0;
      return {
        node,
        left,
        top,
        right: left + (node.offsetWidth || 0),
        bottom: top + (node.offsetHeight || 0),
      };
    });
  }

  function findOpenEdgeCorridor(startX, startY, endX, endY, fromNode, toNode, nodeBoxes) {
    const top = Math.min(startY, endY);
    const bottom = Math.max(startY, endY);

    let bestX = startX + (endX - startX) * EDGE_CORRIDOR_RATIOS[0];
    let bestCollisions = Infinity;
    for (const ratio of EDGE_CORRIDOR_RATIOS) {
      const x = startX + (endX - startX) * ratio;
      let collisions = 0;
      for (const box of nodeBoxes) {
        if (box.node === fromNode || box.node === toNode) continue;
        const overlapsVerticalSpan = box.bottom + EDGE_NODE_CLEARANCE >= top
          && box.top - EDGE_NODE_CLEARANCE <= bottom;
        const blocksCorridor = x >= box.left - EDGE_NODE_CLEARANCE
          && x <= box.right + EDGE_NODE_CLEARANCE;
        if (overlapsVerticalSpan && blocksCorridor) collisions += 1;
      }
      if (collisions === 0) return x;
      if (collisions < bestCollisions) {
        bestCollisions = collisions;
        bestX = x;
      }
    }
    return bestX;
  }

  /**
   * Keep ordinary left-to-right connections straight. When an edge is steep or bends back
   * toward the left, use a pronounced S curve with horizontal tangents at both nodes so its
   * source and destination remain visually unambiguous. The central corridor prefers open
   * space between unrelated nodes.
   */
  function getEdgeGeometry(startX, startY, endX, endY, fromNode, toNode, nodeBoxes) {
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const shouldCurve = deltaX <= 0
      || (Math.abs(deltaY) >= EDGE_CURVE_MIN_VERTICAL_DELTA
        && Math.abs(deltaY) > Math.abs(deltaX) * EDGE_CURVE_SLOPE_THRESHOLD);

    if (!shouldCurve) {
      return {
        tagName: 'line',
        attributes: { x1: startX, y1: startY, x2: endX, y2: endY },
        labelPoint: { x: (startX + endX) / 2, y: (startY + endY) / 2 },
      };
    }

    if (deltaX > 0) {
      const corridorX = findOpenEdgeCorridor(startX, startY, endX, endY, fromNode, toNode, nodeBoxes);
      const middleY = startY + deltaY / 2;
      return {
        tagName: 'path',
        labelPoint: { x: corridorX, y: middleY },
        attributes: {
          d: `M ${startX} ${startY} C ${corridorX} ${startY}, ${corridorX} ${startY}, ${corridorX} ${middleY} C ${corridorX} ${endY}, ${corridorX} ${endY}, ${endX} ${endY}`,
          fill: 'none',
        },
      };
    }

    const handleLength = Math.min(240, Math.max(96, Math.abs(deltaX) * 0.4, Math.abs(deltaY) * 0.35));
    return {
      tagName: 'path',
      labelPoint: { x: (startX + endX) / 2, y: (startY + endY) / 2 },
      attributes: {
        d: `M ${startX} ${startY} C ${startX + handleLength} ${startY}, ${endX - handleLength} ${endY}, ${endX} ${endY}`,
        fill: 'none',
      },
    };
  }

  function createEdgeShape(geometry) {
    const shape = document.createElementNS('http://www.w3.org/2000/svg', geometry.tagName);
    Object.entries(geometry.attributes).forEach(([name, value]) => {
      shape.setAttribute(name, String(value));
    });
    return shape;
  }

  function renderEdge(g, edge, edgeIndex, nodeBoxes) {
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

    const startX = x1 + w1;
    const startY = y1 + h1 / 2;
    const endX = x2;
    const toHeight = edge.type === EDGE_TYPE_PROMPT_TO_PROMPT
      ? h2
      : (isRunOrScore ? RUN_NODE_FALLBACK_HEIGHT : h2);
    const endY = y2 + (toHeight > 0 ? toHeight / 2 : RUN_NODE_FALLBACK_HEIGHT / 2);
    const geometry = getEdgeGeometry(startX, startY, endX, endY, fromNode, toNode, nodeBoxes);
    const isDatasetVersionEdge = edge.type === EDGE_TYPE_DATASET_TO_DATASET;
    const canCompare = !edge.derived && (
      edge.type === EDGE_TYPE_PROMPT_TO_PROMPT || edge.type === EDGE_TYPE_PROMPT_REVIEW_TO_PROMPT || isDatasetVersionEdge
    );
    const compareLabel = isDatasetVersionEdge ? 'Compare dataset versions' : 'Compare prompt versions';
    const edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    edgeGroup.setAttribute('class', canCompare ? 'workflow-edge workflow-edge--compare' : 'workflow-edge');
    edgeGroup.setAttribute('data-edge-type', edge.type || '');
    edgeGroup.setAttribute('data-edge-index', String(edgeIndex));
    g.appendChild(edgeGroup);

    if (canCompare) {
      edgeGroup.setAttribute('role', 'button');
      edgeGroup.setAttribute('tabindex', '0');
      edgeGroup.setAttribute('aria-label', compareLabel);
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = compareLabel;
      edgeGroup.appendChild(title);
      const hitLine = createEdgeShape(geometry);
      hitLine.setAttribute('stroke', 'transparent');
      hitLine.setAttribute('stroke-width', String(EDGE_HIT_STROKE_WIDTH));
      hitLine.setAttribute('class', 'workflow-edge-hit');
      edgeGroup.appendChild(hitLine);
    }

    const line = createEdgeShape(geometry);
    line.setAttribute('class', 'workflow-edge-line');
    line.setAttribute('stroke', 'var(--text-muted)');
    line.setAttribute('stroke-width', '2');
    if (edge.type === EDGE_TYPE_RUN_TO_DATASET_SNAPSHOT || edge.type === EDGE_TYPE_PROCESS_TO_DATASET_SNAPSHOT) {
      line.setAttribute('stroke-dasharray', '5 4');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = 'Saved Dataset snapshot; its content does not follow upstream History.';
      edgeGroup.appendChild(title);
    }
    line.setAttribute('marker-end', 'url(#workflow-arrow)');
    line.setAttribute('pointer-events', 'none');
    if (edge.derived) {
      line.classList.add('workflow-edge--derived');
      line.setAttribute('data-derived', 'true');
      line.setAttribute('aria-label', edge.type === EDGE_TYPE_DATASET_TO_RUN
        ? 'Selected input dataset'
        : edge.type === EDGE_TYPE_GROUND_TRUTH_TO_SCORE
          ? 'Selected ground truth dataset'
          : 'Dataset saved from Run results');
    }
    edgeGroup.appendChild(line);

    if (canCompare) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      label.setAttribute('class', 'workflow-edge-compare-label');
      label.setAttribute('transform', `translate(${geometry.labelPoint.x}, ${geometry.labelPoint.y})`);
      const background = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      background.setAttribute('class', 'workflow-edge-compare-label__bg');
      background.setAttribute('r', '12');
      const icon = iconGitCompareArrows(14);
      icon.setAttribute('x', '-7');
      icon.setAttribute('y', '-7');
      label.append(background, icon);
      edgeGroup.appendChild(label);
    }
  }

  /** Build read-only data-flow edges from fields that already drive execution and provenance. */
  function getDerivedDataFlowEdges() {
    const derived = [];
    const seen = new Set(connections.map((edge) => `${edge.type}:${edge.fromId}:${edge.toId}`));
    const add = (fromId, toId, type) => {
      if (!fromId || !toId || !getNodeById(fromId) || !getNodeById(toId)) return;
      const key = `${type}:${fromId}:${toId}`;
      if (seen.has(key)) return;
      seen.add(key);
      derived.push({ fromId, toId, type, derived: true });
    };

    nodesLayer.querySelectorAll('.workflow-node--run').forEach((runNode) => {
      add(
        String(runNode.dataset.runWorkingSetId || '').trim(),
        String(runNode.dataset.nodeId || '').trim(),
        EDGE_TYPE_DATASET_TO_RUN,
      );
    });
    nodesLayer.querySelectorAll('.workflow-node--dataset').forEach((datasetNode) => {
      add(
        String(datasetNode.dataset.sourceRunNodeId || '').trim(),
        String(datasetNode.dataset.nodeId || '').trim(),
        EDGE_TYPE_RUN_TO_DATASET,
      );
    });
    nodesLayer.querySelectorAll('.workflow-node--score').forEach((scoreNode) => {
      add(
        String(scoreNode.dataset.scoreGroundTruthId || '').trim(),
        String(scoreNode.dataset.nodeId || '').trim(),
        EDGE_TYPE_GROUND_TRUTH_TO_SCORE,
      );
    });
    return derived;
  }

  function syncNodeDependencyColors() {
    const nodeById = new Map(Array.from(nodesLayer.querySelectorAll('.workflow-node'))
      .map((node) => [node.dataset.nodeId, node]));
    nodeById.forEach((node) => {
      if (!['sampler', 'process', 'run', 'score', 'promptReview'].includes(node.dataset.nodeType)) return;
      const { datasetIds, promptId } = dependencyColorSources(node, nodeById, connections);
      const dataColors = datasetIds.map((id) => nodeById.get(id))
        .filter((sourceNode) => sourceNode?.classList.contains('workflow-node--dataset'))
        .map((sourceNode) => datasetColorAt(normalizeDatasetColorIndex(sourceNode.dataset.datasetColorIndex) ?? 0))
        .filter(Boolean);
      const promptNode = nodeById.get(promptId);
      const promptColor = promptNode?.classList.contains('workflow-node--prompt')
        ? datasetColorAt(normalizeDatasetColorIndex(promptNode.dataset.promptColorIndex) ?? 0)
        : '';
      const { borderColor, dataColor } = dependentNodeVisualColors(dataColors, promptColor);
      node.style.borderColor = borderColor;
      const progressBar = node.querySelector('.workflow-node__run-progress, .workflow-node__score-progress, .workflow-node__review-progress, .workflow-node__process-progress');
      if (progressBar) progressBar.style.background = dataColor || '';
    });
  }

  function updateEdges() {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('pointer-events', 'none');
    const nodeBoxes = collectNodeBoxes();
    // Automatic dependency lines sit behind explicit, user-managed workflow edges.
    getDerivedDataFlowEdges().forEach((edge) => renderEdge(g, edge, -1, nodeBoxes));
    connections.forEach((edge, i) => renderEdge(g, edge, i, nodeBoxes));
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
      inputTypes: (() => { try { return JSON.parse(node.dataset.promptInputTypes || '{}'); } catch (_) { return {}; } })(),
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

  function openEdgeDetailModal(edge) {
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

  function openDatasetEdgeDetailModal(edge) {
    const contentOf = (node) => (node && node.dataset.resultMissing !== '1'
      ? datasetContentByNodeId.get(node.dataset.nodeId) || null
      : null);
    const nameOf = (node) => (node?.dataset.datasetName || node?.dataset.subsetName || '').trim() || 'Dataset';
    const fromNode = getNodeById(edge.fromId);
    const toNode = getNodeById(edge.toId);
    openDatasetDiffModal({
      before: contentOf(fromNode),
      after: contentOf(toNode),
      fromName: nameOf(fromNode),
      toName: nameOf(toNode),
    });
  }

  function onEdgesLayerClick(e) {
    const edgeGroup = e.target.closest?.('.workflow-edge--compare');
    if (!edgeGroup) return;
    const edge = connections[Number(edgeGroup.getAttribute('data-edge-index'))];
    if (!edge) return;
    e.preventDefault();
    e.stopPropagation();
    if (edge.type === EDGE_TYPE_PROMPT_TO_PROMPT) {
      openEdgeDetailModal(edge);
    } else if (edge.type === EDGE_TYPE_PROMPT_REVIEW_TO_PROMPT) {
      openReviewToPromptEdgeDetailModal(edge);
    } else if (edge.type === EDGE_TYPE_DATASET_TO_DATASET) {
      openDatasetEdgeDetailModal(edge);
    }
  }

  edgesLayer.addEventListener('click', onEdgesLayerClick);
  edgesLayer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') onEdgesLayerClick(e);
  });

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

  function clampCanvasPosition(value) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) return 0;
    return Math.max(0, normalized);
  }

  function setNodeCanvasPosition(node, left, top) {
    if (!node) return;
    node.style.left = `${clampCanvasPosition(left)}px`;
    node.style.top = `${clampCanvasPosition(top)}px`;
  }

  function markNodeAsAgentCreated(node) {
    if (!node) return;
    node.dataset.nodeOrigin = 'agent';
    node.classList.add('workflow-node--agent-created');
  }

  function escapeRegex(value) {
    return String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const {
    isPromptNameAlreadyUsed,
    isDatasetNameAlreadyUsed,
    findUniqueDatasetExportName,
    isSamplerNameAlreadyUsedForSource,
    getNextDefaultSamplerName,
    findUniqueSamplerName,
    isRunNameAlreadyUsedForPromptNodeId,
    findUniqueRunName,
    isReviewNameAlreadyUsedForScoreNodeId,
    findUniqueReviewName,
    findUniquePromptName,
    findUniqueWorkingDatasetName,
    findNextWorkingDatasetVersionName,
  } = createWorkflowCanvasNames({
    nodesLayer,
    getNodeList,
    getConnections: () => connections,
    getNodeById,
    EDGE_TYPE_PROMPT_TO_RUN,
    EDGE_TYPE_SCORE_TO_PROMPT_REVIEW,
  });

  const {
    createPromptNode,
    createDatasetNode,
    createSamplerNode,
    createRunNode,
    createScoreNode,
    createPromptReviewNode,
    createProcessNode,
  } = createWorkflowNodeFactories({
    generateNodeId,
    allocateNodePosition,
    setNodeCanvasPosition,
    scrollWrapper,
    nodesLayer,
    getZoomLevel: () => zoomLevel,
    updateContentSize,
    updateEdges,
    emitCanvasChanged: () => document.dispatchEvent(new CustomEvent('workflow:canvas-changed')),
    showNodeContextMenu,
    handleWorkflowNodeDeleteClick,
    removeConnectionsInvolvingNodeId,
    getNodeById,
    getConnections: () => connections,
    datasetContentByNodeId,
    openPromptDetailModal,
    openRunDetailModal,
    startRunNode: (options) => startRunNode(options),
    openSamplerDetailModal,
    openDatasetDetailModal,
    openScoreDetailModal,
    openReviewDetailModal,
    openProcessDetailModal,
    runProcessNode: (nodeId, options) => runProcessNode(nodeId, options),
    showAlert,
    escapeHtml,
    extractInputFieldsFromSections,
    deriveOutputFields,
    formatResultOutputColumnLabel,
    buildReviewComparisonRows,
    resolveRunCredentialId,
    resolveReviewCredentialId,
    runReviewStart,
    DATASET_BORDER_COLORS,
    normalizeDatasetColorIndex,
    chooseAutomaticNodeColorIndex,
    hasSampledDatasets,
    registerPendingRun,
    unregisterPendingRun,
    pendingRuns,
    getHistoryForNode,
    pendingReviews,
    pendingReviewNodeIds,
    registerPendingReview,
    unregisterPendingReview,
    RUN_API_BASE,
    NEW_NODE_OFFSET,
    findUniqueDatasetExportName,
    isPromptNameAlreadyUsed,
    isRunNameAlreadyUsedForPrompt: isRunNameAlreadyUsedForPromptNodeId,
    toggleNodeSelection,
    isNodeSelected,
    clearSelection,
    getSelectedNodeIds,
  });

  const {
    addPromptNode,
    addPromptVersion,
    addRunNode,
    startRunNode,
    saveRunResultsToWorkspace,
    saveScoreResultsToWorkspace,
    addScoreNode,
    updateScoreNode,
    updateScoreRowSelection,
    addPromptReviewNode,
    createAndRunReviewNode,
    verifyReviewSuggestions,
    acceptReviewSuggestions,
    applyReviewSuggestions,
    addDatasetNode,
    addSamplerNode,
    addSampledDatasetNode,
    addProcessNode,
    importPubmedDataset,
    importClinicaltrialsDataset,
    importPreprintDataset,
    importChemblDataset,
  } = createWorkflowCanvasRuntime({
    extractInputFieldsFromSections,
    deriveOutputFields,
    getNextRowIndex,
    mergeResumeResults,
    embedInputRow,
    processApiResults,
    countCompletedInputRows,
    markEmptyOutputAsError,
    formatResultOutputColumnLabel,
    parseScoreMappingBundle,
    serializeScoreMappingBundle,
    flattenScoreRules,
    runReviewStart,
    getScoreExportData,
    DATASET_BORDER_COLORS,
    RUN_API_BASE,
    NEW_NODE_OFFSET,
    getNodeById,
    getConnections: () => connections,
    datasetContentByNodeId,
    scrollWrapper,
    createPromptNode,
    createRunNode,
    createScoreNode,
    createDatasetNode,
    createSamplerNode,
    createProcessNode,
    createPromptReviewNode,
    updateContentSize,
    updateEdges,
    syncScoreNodeProgressFromUpstreamRun,
    setRunNodeProgress,
    setReviewNodeProgress,
    registerPendingRun,
    pendingRuns,
    pendingRunHistoryRecords,
    getHistorySession: () => historySession?.projectId && canvasHistoryVersion === 1 ? historySession : null,
    getCanvasState,
    reconcileHistory,
    reconcileRunHistory,
    resolveRunCredentialId,
    resolveReviewCredentialId,
    pendingReviewNodeIds,
    pendingReviews,
    registerPendingReview,
    findUniquePromptName,
    isPromptNameAlreadyUsed,
    getPromptDataFromNode,
    isRunNameAlreadyUsedForPromptNodeId,
    findUniqueRunName,
    findUniqueDatasetExportName,
    findUniqueWorkingDatasetName,
    isDatasetNameAlreadyUsed,
    isSamplerNameAlreadyUsedForSource,
    getNextDefaultSamplerName,
    findUniqueSamplerName,
    findUniqueReviewName,
    prepareSampledDatasetFromSampler,
    buildReviewComparisonRows,
    escapeRegex,
    markNodeAsAgentCreated,
    setNodeCanvasPosition,
    emitCanvasChanged: () => document.dispatchEvent(new CustomEvent('workflow:canvas-changed')),
    emitRunResultsUpdated: (detail) => document.dispatchEvent(new CustomEvent('workflow:run-results-updated', { detail })),
    emitSaveReviewResult: (detail) => document.dispatchEvent(new CustomEvent('workflow:save-review-result', { detail })),
  });

  const canvasControlsStack = document.createElement('div');
  canvasControlsStack.className = 'workflow-canvas__controls-stack';

  // The panel toggles sit in the top bar (topBar.js places them: left of the window controls on
  // desktop, left of the account avatar on web) but live here, beside the panels they control.
  const panelToggles = document.createElement('div');
  panelToggles.className = 'top-bar-panel-toggles';
  panelToggles.hidden = true;
  panelToggles.innerHTML = `
    <button type="button" class="top-bar-panel-toggle" aria-controls="workspace-pipeline"><span class="top-bar-panel-toggle__icon" aria-hidden="true"></span></button>
    <button type="button" class="top-bar-panel-toggle" aria-controls="workspace-agent"><span class="top-bar-panel-toggle__icon" aria-hidden="true"></span></button>
  `;
  const [currentPipelineBtn, agentAssistantBtn] = panelToggles.querySelectorAll('.top-bar-panel-toggle');
  const [pipelineToggleIcon, agentToggleIcon] = panelToggles.querySelectorAll('.top-bar-panel-toggle__icon');
  // Desktop's title bar gets VS Code-style layout icons that show each panel's state (redrawn in
  // syncPanelButtons); the web top bar keeps the Pipeline / ✦ icons, with state shown by color.
  if (!isElectron) {
    pipelineToggleIcon.appendChild(iconWorkflow(16));
    agentToggleIcon.textContent = '✦';
    agentToggleIcon.classList.add('top-bar-panel-toggle__sparkle');
  }
  // Uncaught errors land in the bottom panel's Errors tab (desktop); this keeps them noticeable
  // while that panel is collapsed or showing another tab.
  const panelErrorBadge = document.createElement('span');
  panelErrorBadge.className = 'top-bar-panel-toggle__badge';
  panelErrorBadge.hidden = true;
  currentPipelineBtn.appendChild(panelErrorBadge);
  currentPipelineBtn.addEventListener('click', () => workspacePanels.toggle('pipeline'));
  agentAssistantBtn.addEventListener('click', () => workspacePanels.toggle('agent'));
  let panelProjectPath = '';
  let agentMountGeneration = 0;
  let pendingAgentMount = false;
  const agentHistoryDeletionPreviews = new Map();
  function mountAgentPanel() {
    if (pendingAgentMount || workspacePanels.agentHost.querySelector('.agent-window-overlay')) return;
    pendingAgentMount = true;
    const generation = agentMountGeneration;
    openAgentWindowModal({
      projectPath: getCurrentProjectPath(),
      host: workspacePanels.agentHost,
      onClose: () => { workspacePanels.collapse('agent'); agentAssistantBtn.focus(); },
      isCurrent: () => generation === agentMountGeneration,
      workspace: {
        getCanvasState,
        inspectNode,
        getScoreComparisonRows,
        getSelectedNodeIds: () => [...selectedNodeIds],
        extractInputFields: extractInputFieldsFromSections,
        applyCanvasState: applyAgentCanvasState,
        previewHistorySelection: planHistorySelectionForCanvas,
        applyHistorySelection: async (recordId) => {
          const plan = await planHistorySelectionForCanvas(recordId);
          applyAgentCanvasState(plan.state, { highlightNodeIds: plan.changedNodeIds });
          return plan;
        },
        previewHistoryDeletion: async (recordId) => {
          const session = historySession;
          if (!session?.projectId || canvasHistoryVersion !== 1) throw new Error('History is not available for this project.');
          const plan = await session.planDelete(recordId, getCanvasState(), { runningNodeIds: [...pendingRuns.keys(), ...pendingProcesses] });
          agentHistoryDeletionPreviews.set(recordId, { projectId: session.projectId, ids: plan.ids });
          return plan;
        },
        applyHistoryDeletion: async (recordId) => {
          const session = historySession;
          const preview = agentHistoryDeletionPreviews.get(recordId);
          if (!session?.projectId || !preview || preview.projectId !== session.projectId) throw new Error('Preview this history deletion again.');
          const plan = await session.delete(recordId, getCanvasState(), { runningNodeIds: [...pendingRuns.keys(), ...pendingProcesses] }, preview.ids);
          agentHistoryDeletionPreviews.delete(recordId);
          document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
          return plan;
        },
        highlightNodes: highlightPipelineNodes,
        startRunNode,
        stopRunNode,
        runProcessNode,
        // df / df_<name> bindings over every canvas Dataset for try_process, as a Process would see them.
        getDatasetBindings: (primaryDatasetId) => {
          const { datasets } = getProcessDatasets(null);
          return buildProcessDatasetBindings(datasets, primaryDatasetId);
        },
        createAndRunReviewNode,
        stopReviewNode,
        verifyReviewSuggestions,
      },
    }).catch((error) => {
      if (generation === agentMountGeneration) {
        showAlert(error?.message || 'Could not open Agent Assistant.', { title: 'Agent Assistant' });
      }
    }).finally(() => {
      if (generation === agentMountGeneration) pendingAgentMount = false;
    });
  }

  function setAgentWindowVisible(visible) {
    panelToggles.hidden = !visible;
    const projectPath = visible ? String(getCurrentProjectPath() || '') : '';
    if (projectPath !== panelProjectPath || !visible) {
      panelProjectPath = projectPath;
      agentMountGeneration += 1;
      pendingAgentMount = false;
      workspacePanels.agentHost.querySelector('.agent-window-overlay')?.destroyAgentWindow?.();
      workspacePanels.pipelineHost.querySelector('.pipeline-overview-overlay')?.destroyPipelineOverview?.();
    }
    workspacePanels.setEnabled(visible);
    if (isElectron) setErrorsPanelAvailable(visible);
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

  canvasControlsStack.appendChild(zoomToolbar);
  canvas.appendChild(canvasControlsStack);

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

  function removeConnectionsInvolvingNodeId(id) {
    connections = connections.filter((c) => c.fromId !== id && c.toId !== id);
  }

  async function copyTextToClipboard(text) {
    const s = String(text ?? '');
    if (!s) return false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(s);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  function showNodeContextMenu(clientX, clientY, node) {
    const existing = document.querySelector('.workflow-node-context-menu');
    if (existing) existing.remove();

    const isDataset = node.dataset.nodeType === 'dataset';
    const isSampler = node.dataset.nodeType === 'sampler';
    const isRun = node.dataset.nodeType === 'run';
    const isScore = node.dataset.nodeType === 'score';
    const isPromptReview = node.dataset.nodeType === 'promptReview';
    const isProcess = node.dataset.nodeType === 'process';
    let runHasResults = false;
    if (isRun) {
      try {
        const rr = JSON.parse(node.dataset.runResults || '[]');
        runHasResults = Array.isArray(rr) && rr.length > 0;
      } catch (_) {}
    }
    let processHasResults = false;
    if (isProcess) {
      try {
        const pdf = JSON.parse(node.dataset.processDfResults || 'null');
        const legacy = JSON.parse(node.dataset.processResults || 'null');
        processHasResults = Boolean(pdf?.outputs && typeof pdf.outputs === 'object' && Object.keys(pdf.outputs).length)
          || (!!pdf && Array.isArray(pdf.rows))
          || (!!legacy && Array.isArray(legacy.rows));
      } catch (_) {}
    }
    let scoreHasResults = false;
    if (isScore) {
      const runEdge = connections.find((c) => c.toId === node.dataset.nodeId && c.type === EDGE_TYPE_RUN_TO_SCORE);
      const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
      if (runNode) {
        try {
          const rr = JSON.parse(runNode.dataset.runResults || '[]');
          scoreHasResults = Array.isArray(rr) && rr.length > 0;
        } catch (_) {}
      }
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
        <button type="button" class="workflow-node-context-item workflow-node-context-item--review" data-action="score-add-review" role="menuitem" ${scoreHasResults && scoreHasGt ? '' : 'disabled'}>Review</button>
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
        <button type="button" class="workflow-node-context-item workflow-node-context-item--run" data-action="process-this-dataset" role="menuitem">Process with code</button>
        <button type="button" class="workflow-node-context-item" data-action="duplicate-working-dataset" role="menuitem">Duplicate this dataset</button>
        <button type="button" class="workflow-node-context-item" data-action="add-version-of-dataset" role="menuitem">Add new version of this dataset</button>
        <button type="button" class="workflow-node-context-item" data-action="edit-dataset-name-description" role="menuitem">Edit name & description</button>
      `;
    } else if (isSampler) {
      menu.innerHTML = `
        <button type="button" class="workflow-node-context-item workflow-node-context-item--sample" data-action="create-working-dataset" role="menuitem">Create sample</button>
        <button type="button" class="workflow-node-context-item" data-action="edit-sampler-name" role="menuitem">Edit name</button>
      `;
    } else if (isProcess) {
      menu.innerHTML = `
        <button type="button" class="workflow-node-context-item workflow-node-context-item--export" data-action="process-save-to-workspace" role="menuitem" ${processHasResults ? '' : 'disabled'}>Create dataset</button>
        <button type="button" class="workflow-node-context-item" data-action="edit-process-name" role="menuitem">Edit name</button>
      `;
    } else {
      menu.innerHTML = `
        <button type="button" class="workflow-node-context-item workflow-node-context-item--run" data-action="run-this-prompt" role="menuitem">Run</button>
        <button type="button" class="workflow-node-context-item" data-action="duplicate" role="menuitem">Duplicate this prompt</button>
        <button type="button" class="workflow-node-context-item" data-action="new-version" role="menuitem">Add new version of this prompt</button>
        <button type="button" class="workflow-node-context-item" data-action="edit-name-description" role="menuitem">Edit name & description</button>
      `;
    }

    menu.insertAdjacentHTML('beforeend', `
      <button type="button" class="workflow-node-context-item" data-action="copy-name-and-id" role="menuitem">Copy name and ID</button>
    `);

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
        inputTypes: (() => { try { return JSON.parse(node.dataset.promptInputTypes || '{}'); } catch (_) { return {}; } })(),
        colorIndex: normalizeDatasetColorIndex(node.dataset.promptColorIndex),
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
        const headers = [
          'Input: #',
          formatResultOutputColumnLabel('#'),
          ...outputFields.map((f) => formatResultOutputColumnLabel((f && (f.display || f.key)) ? String(f.display || f.key).trim() || 'output' : 'output')),
        ];
        const rows = results.map((r) => {
          const inputNum = String((typeof r.input_row_index === 'number' && !Number.isNaN(r.input_row_index) ? r.input_row_index : r.row_index ?? 0) + 1);
          const outputNum = String((r.row_index ?? 0) + 1);
          const outputPart = r.error
            ? outputFields.map(() => String(r.error))
            : (outputFields || []).map((f) => {
                const val = r.output && f && r.output[f.key];
                if (val === null || val === undefined) return '—';
                if (Array.isArray(val)) return val.join(', ');
                return String(val);
              });
          return [inputNum, outputNum, ...outputPart];
        });
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
          const color = datasetColorAt(colorIndex);
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
          outputFields.forEach((f) => cols.push({ key: f.key || '', label: formatResultOutputColumnLabel((f.display || f.key || '').trim() || f.key || '—') }));
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
          if (getNodeById(wsNodeId)?.dataset?.resultMissing === '1') return { headers: [], rows: [], missingResult: true };
          if (!c) return { headers: [], rows: [] };
          return { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) };
        }
        async function getReviewPayload() {
          if (!promptNode || !runNode || !scoreNode) return null;
          const gtId = String(scoreNode.dataset.scoreGroundTruthId || '').trim();
          if (gtId && getNodeById(gtId)?.dataset?.resultMissing === '1') return null;
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
            // Same request as the Score window's Review button.
            review_method: (scoreNode.dataset.reviewMethod || '').trim() || undefined,
            score_mapping: scoreNode.dataset.scoreMapping || undefined,
            target_section_index: Number.isInteger(parseInt(scoreNode.dataset.gepaTargetSectionIndex, 10))
              ? parseInt(scoreNode.dataset.gepaTargetSectionIndex, 10)
              : undefined,
            settings_overrides: reviewSettingsOverrides(scoreNode),
          };
        }
        const credentialId = await resolveReviewCredentialId(scoreNode);
        if (!credentialId) {
          showAlert('No Review model: set a default Review model in Settings.', { title: 'Review' });
          return;
        }
        const started = await runReviewFromScore({
          scoreNodeId: scoreNode.dataset.nodeId,
          getReviewPayload,
          credentialId,
        });
        if (!started) {
          showAlert('Could not start Review. Open Score detail and ensure the prompt has sections, Run has results, and ground truth is selected.', { title: 'Review' });
        }
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
      'process-this-dataset': () => newProcessNode({ datasetNode: node }),
      'run-this-prompt': () => newRunNode({ promptNode: node }),
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
          if (getNodeById(wsNodeId)?.dataset?.resultMissing === '1') return { headers: [], rows: [], missingResult: true };
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
          outputFields.forEach((f) => cols.push({ key: f.key || '', label: formatResultOutputColumnLabel((f.display || f.key || '').trim() || f.key || '—') }));
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
            node.dataset.promptReviewName = name;
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
      'edit-process-name': () => {
        if (node.dataset.nodeType !== 'process') return;
        openEditNodeNameModal(node, {
          modalTitle: 'Edit Process name',
          fieldLabel: 'Process name',
          placeholder: 'Process',
          getCurrentName: () => (node.dataset.processName || node.querySelector('.workflow-node__title')?.textContent || '').trim() || 'Process',
          onSave: (name) => {
            node.dataset.processName = name;
            const titleEl = node.querySelector('.workflow-node__title');
            if (titleEl) titleEl.textContent = name;
          },
        });
      },
      'process-save-to-workspace': () => {
        if (node.dataset.nodeType !== 'process') return;
        let saved = null;
        try {
          saved = JSON.parse(node.dataset.processDfResults || node.dataset.processResults || 'null');
        } catch (_) {}
        const outputs = saved?.outputs && typeof saved.outputs === 'object'
          ? saved.outputs
          : (saved && Array.isArray(saved.headers) && Array.isArray(saved.rows)
            ? { result: saved }
            : {});
        const entries = Object.entries(outputs).filter(([, result]) => (
          result && Array.isArray(result.headers) && Array.isArray(result.rows)
        ));
        if (!entries.length) return;
        const processName = (node.dataset.processName || node.querySelector('.workflow-node__title')?.textContent || '').trim() || 'Process';
        const left = (parseFloat(node.style.left) || 0) + (node.offsetWidth || 160) + NEW_NODE_OFFSET;
        const top = parseFloat(node.style.top) || 0;
        entries.forEach(([branchName, result], index) => {
          const baseName = entries.length === 1 ? `${processName} results` : `${processName} — ${branchName}`;
          document.dispatchEvent(new CustomEvent('workflow:add-dataset-node', {
            detail: {
              name: findUniqueDatasetExportName(baseName),
              notes: `Branch "${branchName}" exported from Process "${processName}".`,
              headers: result.headers,
              rows: result.rows,
              processNodeId: node.dataset.nodeId || '',
              processOutputName: branchName,
              left,
              top: top + index * 132,
            },
          }));
        });
      },
      'duplicate-working-dataset': () => {
        if (node.dataset.resultMissing === '1') {
          showAlert('This Dataset has no current result to duplicate. Select matching upstream History or run the upstream node.', { title: 'Duplicate Dataset' });
          return;
        }
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
          connections.filter((c) => c.toId === node.dataset.nodeId
            && ![EDGE_TYPE_PROCESS_TO_DATASET, EDGE_TYPE_RUN_TO_DATASET_SNAPSHOT, EDGE_TYPE_PROCESS_TO_DATASET_SNAPSHOT].includes(c.type)).forEach((c) => {
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
          columnTypes: content?.columnTypes,
          // Shared row IDs let the version-edge diff line rows up across edits.
          rowIds: content?.rowIds,
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
      'copy-name-and-id': async () => {
        const id = String(node.dataset.nodeId || '').trim();
        const titleEl = node.querySelector('.workflow-node__title');
        const rawName = (titleEl?.textContent || '').trim();
        const name = (rawName.replace(/\s+/g, ' ') || id || 'Node').trim();
        const text = id ? `${name} | ${id}` : name;
        const ok = await copyTextToClipboard(text);
        if (!ok) {
          showAlert('Could not copy to clipboard.', { title: 'Copy' });
        }
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
      const bodyText = (notes || '').trim() || formatSamplerDescription(samplerNode) || '';
      const bodyEl = node.querySelector('.workflow-node__dataset-desc');
      if (bodyEl) bodyEl.innerHTML = bodyText ? `<span class="workflow-node__note">${escapeHtml(bodyText)}</span>` : '<span class="workflow-node__note-placeholder">No description.</span>';
      close();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
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
    const { name = '', note = '', sections = [], outputFormat, left, top } = e.detail || {};
    addPromptNode({ name, note, sections, outputFormat, left, top, ensureUniqueName: false });
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
    const { name = '', notes = '', headers, rows, columnTypes, rowIds, left: detailLeft, top: detailTop, samplerNodeId = '', processNodeId = '', processOutputName = '', runNodeId = '', colorIndex: detailColorIndex } = e.detail || {};
    const VISIBLE_PADDING = 40;
    let startLeft = typeof detailLeft === 'number' ? detailLeft : (scrollWrapper.scrollLeft + VISIBLE_PADDING);
    let startTop = typeof detailTop === 'number' ? detailTop : (scrollWrapper.scrollTop + VISIBLE_PADDING);
    let datasetHeaders = Array.isArray(headers) ? headers.slice() : [];
    let datasetRows = Array.isArray(rows) ? rows.map((r) => r.slice()) : [];
    let datasetColumnTypes = Array.isArray(columnTypes) ? columnTypes.slice() : undefined;
    let datasetRowIds = Array.isArray(rowIds) ? rowIds.slice() : undefined;
    let datasetName = (name && name.trim()) ? name.trim() : '';
    let datasetNotes = notes || '';

    const processNode = processNodeId ? getNodeById(processNodeId) : null;
    if (processNode && typeof detailLeft !== 'number') {
      startLeft = (parseFloat(processNode.style.left) || 0) + (processNode.offsetWidth || 160) + NEW_NODE_OFFSET;
      startTop = parseFloat(processNode.style.top) || 0;
    }

    if (samplerNodeId) {
      try {
        const prepared = prepareSampledDatasetFromSampler({
          samplerNodeId,
          name: datasetName,
          notes: datasetNotes,
          left: startLeft,
          top: startTop,
        });
        startLeft = prepared.startLeft;
        startTop = prepared.startTop;
        datasetHeaders = prepared.datasetHeaders;
        datasetRows = prepared.datasetRows;
        datasetColumnTypes = prepared.datasetColumnTypes;
        datasetRowIds = prepared.datasetRowIds;
        datasetName = prepared.datasetName;
        datasetNotes = prepared.datasetNotes;
      } catch (error) {
        showAppAlert(
          error instanceof Error ? error.message : 'Could not create dataset from sampler.',
          'Cannot create dataset'
        );
        return;
      }
    } else {
      datasetName = datasetName || findUniqueWorkingDatasetName('Dataset', false);
    }

    const newNode = addDatasetNode({
      name: datasetName,
      notes: datasetNotes,
      left: startLeft,
      top: startTop,
      samplerNodeId: samplerNodeId || '',
      sourceRunNodeId: runNodeId || '',
      processOutputName,
      colorIndex: detailColorIndex,
      headers: datasetHeaders,
      rows: datasetRows,
      columnTypes: datasetColumnTypes,
      rowIds: datasetRowIds,
      ensureUniqueName: false,
    });
    if (samplerNodeId && newNode?.nodeId) {
      connections.push({
        fromId: samplerNodeId,
        toId: newNode.nodeId,
        type: EDGE_TYPE_SAMPLER_TO_DATASET,
      });
      updateEdges();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    } else if (processNode && newNode?.nodeId) {
      connections.push({
        fromId: processNode.dataset.nodeId,
        toId: newNode.nodeId,
        type: EDGE_TYPE_PROCESS_TO_DATASET,
      });
      updateEdges();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
  });

  /** Where a node created on its own (not from a source node) appears: the visible top left. */
  function visibleNodePosition() {
    return { left: scrollWrapper.scrollLeft + 40, top: scrollWrapper.scrollTop + 40 };
  }
  function besideNode(sourceNode) {
    return {
      left: (parseFloat(sourceNode.style.left) || 0) + (sourceNode.offsetWidth || 280) + NEW_NODE_OFFSET,
      top: parseFloat(sourceNode.style.top) || 0,
    };
  }

  /**
   * Adds a Process. A Process picks its df Dataset in its window; started from a Dataset, it
   * begins with that one. `open` opens its window, as when it is added from the top bar.
   */
  function newProcessNode({ datasetNode = null, open = false } = {}) {
    const fromDataset = datasetNode?.dataset?.nodeType === 'dataset';
    const processNode = createProcessNode({ ...(fromDataset ? besideNode(datasetNode) : visibleNodePosition()), title: 'Process' });
    if (processNode?.dataset?.nodeId && fromDataset) {
      processNode.dataset.processPrimaryDatasetId = datasetNode.dataset.nodeId || '';
      connections.push({
        fromId: datasetNode.dataset.nodeId,
        toId: processNode.dataset.nodeId,
        type: EDGE_TYPE_DATASET_TO_PROCESS,
      });
      updateEdges();
    }
    updateContentSize();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    if (open) processNode?.click();
    return processNode;
  }

  /** Adds a Run. A Run picks its Prompt and Dataset in its window; started from a Prompt, it begins with that one. */
  function newRunNode({ promptNode = null, open = false } = {}) {
    const fromPrompt = promptNode?.dataset?.nodeType === 'prompt' || promptNode?.classList?.contains('workflow-node--prompt');
    const runNode = createRunNode({ ...(fromPrompt ? besideNode(promptNode) : visibleNodePosition()), title: 'Run' });
    if (runNode?.dataset?.nodeId && fromPrompt) {
      connections.push({
        fromId: promptNode.dataset.nodeId,
        toId: runNode.dataset.nodeId,
        type: EDGE_TYPE_PROMPT_TO_RUN,
      });
      updateEdges();
    }
    updateContentSize();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    if (open) runNode?.click();
    return runNode;
  }

  document.addEventListener('workflow:add-process-node', (e) => {
    const sourceNodeId = e.detail?.sourceNodeId || '';
    newProcessNode({ datasetNode: sourceNodeId ? getNodeById(sourceNodeId) : null, open: e.detail?.open === true });
  });
  document.addEventListener('workflow:add-run-node', (e) => {
    const promptNodeId = e.detail?.promptNodeId || '';
    newRunNode({ promptNode: promptNodeId ? getNodeById(promptNodeId) : null, open: e.detail?.open === true });
  });

  document.addEventListener('workflow:add-sampler-node', (e) => {
    const { sourceNodeId = '', colorIndex, name: nameParam, samplingType = 'without-replacement', sampleSizeType = 'ratio', sampleSize = 100, rowSpec = '' } = e.detail || {};
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
          const color = datasetColorAt(colorIndex);
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
    try {
      const created = addPromptReviewNode({
        scoreNodeId,
        name: e.detail?.name,
        left: Number.isFinite(Number(e.detail?.left)) ? Number(e.detail.left) : undefined,
        top: Number.isFinite(Number(e.detail?.top)) ? Number(e.detail.top) : undefined,
        ensureUniqueName: e.detail?.ensureUniqueName === true,
      });
      if (!e.detail) e.detail = {};
      e.detail.reviewNodeId = created.reviewNodeId;
      e.detail.registerPendingReview = registerPendingReview;
    } catch (_) {}
  });

  document.addEventListener('workflow:review-stream-started', (e) => {
    const id = e.detail?.reviewNodeId;
    if (id) {
      pendingReviewNodeIds.add(id);
      const node = getNodeById(id);
      if (node) delete node.dataset.reviewInterrupted;
    }
  });
  document.addEventListener('workflow:review-stream-ended', (e) => {
    const id = e.detail?.reviewNodeId;
    if (id) {
      pendingReviewNodeIds.delete(id);
      unregisterPendingReview(id);
      const node = getNodeById(id);
      if (node) {
        let complete = false;
        try { complete = JSON.parse(node.dataset.reviewResult || '{}')?.streamComplete === true; } catch (_) {}
        if (complete) delete node.dataset.reviewInterrupted;
        else node.dataset.reviewInterrupted = '1';
      }
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
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
    syncNodeDependencyColors();
  });
  document.addEventListener('workflow:refresh-node-colors', syncNodeDependencyColors);
  document.addEventListener('workflow:score-ground-truth-changed', () => updateEdges());

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
      reviewNode.dataset.reviewResult = JSON.stringify(toWrite);
      if (toWrite.reviewProgress != null) {
        setReviewNodeProgress(reviewNode, toWrite.reviewProgress);
      }
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    } catch (_) {}
  });

  /** Non-default review methods report their id + declared stages once at job start (backend/review_methods.py); stashed on the node dataset for generic stage-progress calc (see the `stage` branch in the review event loop). */
  document.addEventListener('workflow:review-method-info', (e) => {
    const { reviewNodeId, reviewMethodId, reviewStages, supportsSegmentOptimization } = e.detail || {};
    const reviewNode = getNodeById(reviewNodeId);
    if (!reviewNode) return;
    reviewNode.dataset.reviewMethodId = reviewMethodId || '';
    reviewNode.dataset.supportsSegmentOptimization = supportsSegmentOptimization === false ? '0' : '1';
    try {
      reviewNode.dataset.reviewStages = JSON.stringify(Array.isArray(reviewStages) ? reviewStages : []);
    } catch (_) {
      reviewNode.dataset.reviewStages = '[]';
    }
  });

  document.addEventListener('workflow:add-prompt-from-review', (e) => {
    const { sections = [], afterReviewNodeId, afterScoreNodeId } = e.detail || {};
    if (!Array.isArray(sections) || sections.length === 0) return;
    applyReviewSuggestions({
      reviewNodeId: afterReviewNodeId,
      scoreNodeId: afterScoreNodeId,
      sections,
      ensureUniqueName: true,
    }).catch(() => {});
  });

  let canvasHistoryVersion = null;
  let historySession = null;
  let historyAnalysisKeys = new Map();
  let historyAnalysisKeysInitialized = false;
  let historyRevision = 0;
  document.addEventListener('workflow:canvas-changed', () => { historyRevision += 1; });

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
          sourceRunNodeId: node.dataset.sourceRunNodeId || '',
          processOutputName: node.dataset.processOutputName || '',
          resultMissing: node.dataset.resultMissing === '1' || undefined,
          historyEdits: node.dataset.historyEdits ? readHistoryEdits(node.dataset.historyEdits) : undefined,
          colorIndex: node.dataset.datasetColorIndex != null ? parseInt(node.dataset.datasetColorIndex, 10) : undefined,
          datasetContent: content ? cloneDatasetContent(content) : undefined,
          nodeOrigin: (node.dataset.nodeOrigin || '').trim() || undefined,
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
        if ((node.dataset.nodeOrigin || '').trim()) out.nodeOrigin = node.dataset.nodeOrigin.trim();
        if (samplingType === 'specify-rows') {
          out.rowSpec = (node.dataset.samplerRowSpec || '').trim();
        } else {
          out.sampleSizeType = node.dataset.samplerSampleSizeType || 'ratio';
          out.sampleSize = node.dataset.samplerSampleSize != null ? parseInt(node.dataset.samplerSampleSize, 10) : 100;
        }
        return out;
      }
      if (node.classList.contains('workflow-node--process')) {
        const dfCode = resolveDataframeProcessCode({
          dfCode: node.dataset.processDfCode,
          code: node.dataset.processCode,
        });
        const out = {
          type: 'process',
          nodeId,
          left,
          top,
          name: node.dataset.processName || 'Process',
          dfCode: dfCode || undefined,
          activeMode: 'df',
          primaryDatasetId: node.dataset.processPrimaryDatasetId || undefined,
          datasetAliases: node.dataset.processDatasetAliases || undefined,
          dfResults: node.dataset.processDfResults || node.dataset.processResults || undefined,
          processPending: pendingProcesses.has(nodeId),
          processResumable: node.dataset.processResumable === '1' || undefined,
          historyRecordId: node.dataset.historyRecordId || undefined,
        };
        if ((node.dataset.nodeOrigin || '').trim()) out.nodeOrigin = node.dataset.nodeOrigin.trim();
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
          runSettings: runSettingsOverrides(node),
          runResults,
          runOutputFields: node.dataset.runOutputFields || undefined,
          runCompleted: node.dataset.runCompleted || undefined,
          runInputContent: node.dataset.runInputContent || undefined,
          runPending: pendingRuns.has(nodeId),
          runResumable: node.dataset.runResumable === '1' || undefined,
          historyRecordId: node.dataset.historyRecordId || undefined,
        };
        if ((node.dataset.nodeOrigin || '').trim()) out.nodeOrigin = node.dataset.nodeOrigin.trim();
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
        if (node.dataset.runOutputBracketCollapsed === '1') out.runOutputBracketCollapsed = true;
        return out;
      }
      if (node.classList.contains('workflow-node--score')) {
        const scoreName = node.querySelector('.workflow-node__title')?.textContent?.trim() || 'Score';
        const scoreGroundTruthId = (node.dataset.scoreGroundTruthId || '').trim() || undefined;
        let scoreMapping;
        try {
          const raw = node.dataset.scoreMapping || '{}';
          const { inputRoot: irS, outputRoot: orS } = parseScoreMappingBundle(typeof raw === 'string' ? raw : JSON.stringify(raw));
          const rules = [...flattenScoreRules(irS), ...flattenScoreRules(orS)];
          const hasRules = rules.some((r) => (r.outputKey || '').trim() && Array.isArray(r.gtColumns) && r.gtColumns.some((c) => String(c || '').trim()));
          scoreMapping = hasRules ? JSON.parse(serializeScoreMappingBundle(irS, orS)) : undefined;
        } catch (_) {}
        const reviewResult = (node.dataset.reviewResult || '').trim();
        const reviewCredentialId = (node.dataset.reviewCredentialId || '').trim() || undefined;
        const reviewMethod = (node.dataset.reviewMethod || '').trim() || undefined;
        const gepaTargetSectionIndexRaw = parseInt(node.dataset.gepaTargetSectionIndex, 10);
        const gepaTargetSectionIndex = Number.isInteger(gepaTargetSectionIndexRaw) ? gepaTargetSectionIndexRaw : undefined;
        const scoreRowExcludedFromScoring = (node.dataset.scoreRowExcludedFromScoring || '').trim();
        let scoreRowExcludedFromScoringObj;
        try {
          scoreRowExcludedFromScoringObj = scoreRowExcludedFromScoring ? JSON.parse(scoreRowExcludedFromScoring) : undefined;
        } catch (_) {}
        const out = {
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
          reviewMethod,
          gepaTargetSectionIndex,
          reviewSettings: reviewSettingsOverrides(node),
        };
        if ((node.dataset.nodeOrigin || '').trim()) out.nodeOrigin = node.dataset.nodeOrigin.trim();
        if (node.dataset.scoreOutputBracketCollapsed === '1') out.scoreOutputBracketCollapsed = true;
        if (node.dataset.scoreGtBracketCollapsed === '1') out.scoreGtBracketCollapsed = true;
        if (node.dataset.scoreTableRulesColumnFilter === '1') out.scoreTableRulesColumnFilter = true;
        if ((node.dataset.scoreMatchCode || '').trim()) out.scoreMatchCode = node.dataset.scoreMatchCode;
        if (node.dataset.scoreActiveMatchMode === 'code') out.scoreActiveMatchMode = 'code';
        if ((node.dataset.scoreMatchResult || '').trim()) out.scoreMatchResult = node.dataset.scoreMatchResult;
        if (node.dataset.scoreMatchInterrupted === '1') out.scoreMatchInterrupted = true;
        return out;
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
        if ((node.dataset.nodeOrigin || '').trim()) out.nodeOrigin = node.dataset.nodeOrigin.trim();
        if (pct > 0) out.reviewProgress = pct;
        if (pendingReviews.has(nodeId) || pendingReviewNodeIds.has(nodeId)) out.reviewPending = true;
        if (node.dataset.reviewInterrupted === '1') out.reviewInterrupted = true;
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
        colorIndex: normalizeDatasetColorIndex(node.dataset.promptColorIndex) ?? undefined,
        sections: Array.isArray(sections) ? sections : [],
        outputFormat,
        inputTypes: (() => { try { return JSON.parse(node.dataset.promptInputTypes || '{}'); } catch (_) { return {}; } })(),
        nodeOrigin: (node.dataset.nodeOrigin || '').trim() || undefined,
      };
    });
    return { version: 2, ...(canvasHistoryVersion === 1 ? { historyVersion: 1 } : {}), nodes, connections: connections.slice() };
  }

  function loadCanvasState(state) {
    const list = state?.nodes;
    if (!Array.isArray(list)) return;
    historyRevision += 1;
    canvasHistoryVersion = state.historyVersion === 1 ? 1 : null;
    nodesLayer.innerHTML = '';
    nodeCount = 0;
    const createdNodes = [];
    list.forEach((n) => {
      if (n.type === 'dataset' || n.type === 'subset') {
        const content = n.datasetContent || n.subsetContent;
        const node = createDatasetNode({
          name: n.name || '',
          notes: n.note || '',
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
          samplerNodeId: n.samplerNodeId || '',
          sourceRunNodeId: n.sourceRunNodeId || '',
          processOutputName: n.processOutputName || '',
          colorIndex: n.colorIndex,
          headers: content?.headers,
          rows: content?.rows,
          columnTypes: content?.columnTypes,
          rowIds: content?.rowIds,
        });
        if (n.resultMissing) node.dataset.resultMissing = '1';
        const historyEdits = readHistoryEdits(n.historyEdits);
        if (Object.keys(historyEdits).length) node.dataset.historyEdits = JSON.stringify(historyEdits);
        if (n.nodeOrigin === 'agent') markNodeAsAgentCreated(node);
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
          sampleSizeType: n.sampleSizeType || 'ratio',
          sampleSize: n.sampleSize != null ? n.sampleSize : 100,
          rowSpec: (n.rowSpec || '').trim(),
        });
        if (n.nodeOrigin === 'agent') markNodeAsAgentCreated(node);
        createdNodes.push(node);
      } else if (n.type === 'process') {
        const dfCode = resolveDataframeProcessCode({ dfCode: n.dfCode, code: n.code });
        const node = createProcessNode({
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
          title: n.name || 'Process',
          dfCode,
          primaryDatasetId: n.primaryDatasetId,
          datasetAliases: n.datasetAliases,
        });
        if (n.nodeOrigin === 'agent') markNodeAsAgentCreated(node);
        if (n.dfResults || n.results) node.dataset.processDfResults = n.dfResults || n.results;
        if (n.historyRecordId) node.dataset.historyRecordId = n.historyRecordId;
        if (n.processPending === true || n.processResumable === true) node.dataset.processResumable = '1';
        if (n.results || n.dfResults) {
          const bar = node.querySelector('.workflow-node__process-progress');
          if (bar) { bar.style.width = '100%'; bar.setAttribute('aria-valuenow', '100'); }
        }
        createdNodes.push(node);
      } else if (n.type === 'run') {
        const runNode = createRunNode({
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
          title: n.runName || 'Run',
        });
        if (n.nodeOrigin === 'agent') markNodeAsAgentCreated(runNode);
        if (n.runName) runNode.dataset.runName = n.runName;
        if (n.runWorkingSetId) runNode.dataset.runWorkingSetId = n.runWorkingSetId;
        if (n.runCredentialId) runNode.dataset.runCredentialId = n.runCredentialId;
        if (n.runInputToColumn) runNode.dataset.runInputToColumn = n.runInputToColumn;
        if (n.runSettings && typeof n.runSettings === 'object') runNode.dataset.runSettings = JSON.stringify(n.runSettings);
        if (n.runCompleted) runNode.dataset.runCompleted = n.runCompleted;
        if (n.historyRecordId) runNode.dataset.historyRecordId = n.historyRecordId;
        if (n.runResumable === true || n.runPending === true) runNode.dataset.runResumable = '1';
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
        if (n.runOutputBracketCollapsed === true) runNode.dataset.runOutputBracketCollapsed = '1';
        createdNodes.push(runNode);
      } else if (n.type === 'assessment' || n.type === 'score') {
        const scoreNode = createScoreNode({
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
          title: n.scoreName || 'Score',
        });
        if (n.nodeOrigin === 'agent') markNodeAsAgentCreated(scoreNode);
        if (n.scoreGroundTruthId) scoreNode.dataset.scoreGroundTruthId = n.scoreGroundTruthId;
        if (n.scoreMapping != null) {
          try {
            const raw = typeof n.scoreMapping === 'string' ? n.scoreMapping : JSON.stringify(n.scoreMapping);
            const { inputRoot: irL, outputRoot: orL } = parseScoreMappingBundle(raw);
            const rules = [...flattenScoreRules(irL), ...flattenScoreRules(orL)];
            const hasRules = rules.some((r) => (r.outputKey || '').trim() && Array.isArray(r.gtColumns) && r.gtColumns.some((c) => String(c || '').trim()));
            if (hasRules) scoreNode.dataset.scoreMapping = serializeScoreMappingBundle(irL, orL);
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
        if (n.reviewMethod && typeof n.reviewMethod === 'string') {
          scoreNode.dataset.reviewMethod = n.reviewMethod;
        }
        if (Number.isInteger(n.gepaTargetSectionIndex)) {
          scoreNode.dataset.gepaTargetSectionIndex = String(n.gepaTargetSectionIndex);
        }
        if (n.reviewSettings && typeof n.reviewSettings === 'object') scoreNode.dataset.reviewSettings = JSON.stringify(n.reviewSettings);
        if (n.scoreOutputBracketCollapsed === true) scoreNode.dataset.scoreOutputBracketCollapsed = '1';
        if (n.scoreGtBracketCollapsed === true) scoreNode.dataset.scoreGtBracketCollapsed = '1';
        if (n.scoreTableRulesColumnFilter === true) scoreNode.dataset.scoreTableRulesColumnFilter = '1';
        if (n.scoreMatchCode && typeof n.scoreMatchCode === 'string') {
          scoreNode.dataset.scoreMatchCode = n.scoreMatchCode;
        }
        if (n.scoreActiveMatchMode === 'code') scoreNode.dataset.scoreActiveMatchMode = 'code';
        if (n.scoreMatchResult && typeof n.scoreMatchResult === 'string') {
          scoreNode.dataset.scoreMatchResult = n.scoreMatchResult;
        }
        if (n.scoreMatchInterrupted === true) scoreNode.dataset.scoreMatchInterrupted = '1';
        createdNodes.push(scoreNode);
      } else if (n.type === 'promptReview') {
        const promptReviewNode = createPromptReviewNode({
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
          title: n.promptReviewName || 'Review',
        });
        if (n.nodeOrigin === 'agent') markNodeAsAgentCreated(promptReviewNode);
        if (n.reviewResult && typeof n.reviewResult === 'string') {
          promptReviewNode.dataset.reviewResult = n.reviewResult;
        }
        if (n.reviewProgress != null && n.reviewProgress >= 0 && n.reviewProgress <= 100) {
          setReviewNodeProgress(promptReviewNode, n.reviewProgress);
        }
        if (n.reviewPending === true || n.reviewInterrupted === true) promptReviewNode.dataset.reviewInterrupted = '1';
        createdNodes.push(promptReviewNode);
      } else {
        const node = createPromptNode({
          name: n.name || '',
          note: n.note || '',
          colorIndex: n.colorIndex,
          sections: n.sections || n.fields || [],
          outputFormat: n.outputFormat,
          inputTypes: n.inputTypes,
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
        });
        if (n.nodeOrigin === 'agent') markNodeAsAgentCreated(node);
        createdNodes.push(node);
      }
    });
    // Refresh dataset node description: sampler desc or dataset notes (always show body)
    nodesLayer.querySelectorAll('.workflow-node--dataset').forEach((dsNode) => {
      const samplerNodeId = dsNode.dataset.samplerNodeId;
      const samplerNode = samplerNodeId ? getNodeById(samplerNodeId) : null;
      const samplerDesc = formatSamplerDescription(samplerNode);
      const notesTrimmed = (dsNode.dataset.datasetNote || dsNode.dataset.subsetNote || '').trim();
      const bodyText = notesTrimmed || samplerDesc || '';
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
    syncNodeDependencyColors();
    updateEdges();
    root.querySelector('.pipeline-overview-overlay')?.refreshPipelineOverview?.();
  }

  function setOnCanvasChange(fn) {
    document.addEventListener('workflow:canvas-changed', fn);
  }

  function setHistorySession(session) {
    if (session !== historySession) {
      pendingRuns.clear();
      pendingRunHistoryRecords.clear();
      pendingProcesses.clear();
    }
    historySession = session;
    historyAnalysisKeys = new Map();
    historyAnalysisKeysInitialized = false;
  }

  async function recoverHistoryJobs() {
    const session = historySession;
    if (!session?.projectId || canvasHistoryVersion !== 1) return;
    const currentRecordIds = (await session.resolve(getCanvasState())).currentRecordIds;
    const running = session.index.records.filter((entry) => entry.status === 'running' && ['run', 'process'].includes(entry.kind));
    for (const entry of running) {
      if (session !== historySession) return;
      const record = await session.storage.loadRecord(session.projectId, entry.id);
      if (!record || record.status !== 'running') continue;
      const jobId = String(record.backendJobId || '').trim();
      if (!jobId) {
        await session.putRecord({ ...record, status: 'stopped', updatedAt: new Date().toISOString(), error: 'The app closed before the backend job ID was saved. Resume to run it again.' });
        const live = getNodeById(record.nodeId);
        if (live) {
          if (entry.kind === 'run') live.dataset.runResumable = '1';
          else live.dataset.processResumable = '1';
        }
        await reconcileHistory();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
        continue;
      }
      const node = getNodeById(record.nodeId);
      if (!node) {
        await session.putRecord({ ...record, status: 'failed', updatedAt: new Date().toISOString(), error: 'The node for this job no longer exists.' });
        continue;
      }
      const current = currentRecordIds[record.nodeId] === record.id;
      if (entry.kind === 'run') {
        if (!current) {
          await fetch(`${RUN_API_BASE}/api/run/cancel/${jobId}`, { method: 'POST' }).catch(() => {});
          await session.putRecord({ ...record, status: 'stopped', updatedAt: new Date().toISOString(), error: 'Inputs changed before this Run could be restored.' });
          continue;
        }
        pendingRunHistoryRecords.set(record.nodeId, record);
        registerPendingRun(record.nodeId, jobId);
        continue;
      }
      if (current) pendingProcesses.add(record.nodeId);
      void (async () => {
        try {
          const { outputs, cancelled } = await waitForProcessJob(jobId, { timeoutMs: 0 });
          const results = {
            outputs,
            statusText: cancelled ? 'Cancelled.' : `${Object.keys(outputs).length} branches returned.`,
          };
          await session.putRecord({
            ...record, status: cancelled ? 'stopped' : 'completed', updatedAt: new Date().toISOString(),
            summary: { ...record.summary, branchCount: Object.keys(outputs).length }, results: { dfResults: results },
          });
          if (session === historySession) {
            await reconcileHistory();
            document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
          }
        } catch (error) {
          try {
            const unavailable = Number(error?.status) === 404;
            await session.putRecord({
              ...record,
              status: unavailable ? 'stopped' : 'failed',
              updatedAt: new Date().toISOString(),
              error: unavailable
                ? 'The Process was interrupted when the app closed. Resume to run it again.'
                : String(error?.message || error),
            });
            if (unavailable && session === historySession) {
              const live = getNodeById(record.nodeId);
              if (live) live.dataset.processResumable = '1';
              await reconcileHistory();
              document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
            }
          } catch (saveError) { console.error('Could not save recovered Process failure', saveError); }
        } finally {
          if (session === historySession) {
            pendingProcesses.delete(record.nodeId);
            document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
          }
        }
      })();
    }
  }

  async function planHistorySelectionForCanvas(recordId) {
    if (!historySession?.projectId || canvasHistoryVersion !== 1) throw new Error('History is not available for this project.');
    return historySession.select(recordId, getCanvasState(), {
      runningNodeIds: [...pendingRuns.keys(), ...pendingProcesses],
    });
  }

  function getHistoryForNode(nodeId) {
    // No node means no History; a plain Dataset passes no source and must stay editable.
    if (!nodeId || !historySession?.projectId || canvasHistoryVersion !== 1) return null;
    return {
      reconcile: () => getNodeById(nodeId)?.classList.contains('workflow-node--run')
        ? reconcileRunHistory(nodeId) : reconcileHistory(),
      loadEntries: async () => {
        let resolved;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          resolved = await reconcileHistory();
          if (!resolved?.stale) break;
        }
        if (resolved?.stale) throw new Error('Canvas changed while loading History. Try again.');
        return { entries: await historySession.displayEntriesForNode(nodeId, getCanvasState()), currentId: resolved?.currentRecordIds?.[nodeId] || '' };
      },
      select: async (recordId, closeModal) => {
        const otherDetails = [...document.querySelectorAll('.modal-overlay')].filter((el) =>
          el.querySelector('.modal-panel--run-detail, .modal-panel--process'));
        if (otherDetails.length > 1) throw new Error('Close other Run or Process windows before switching History.');
        const staleDetails = [...document.querySelectorAll('.modal-overlay')].some((el) =>
          el.dataset.workingDatasetNodeId || el.querySelector('.modal-panel--score-detail'));
        if (staleDetails) throw new Error('Close open Dataset and Score windows before switching History.');
        const plan = await planHistorySelectionForCanvas(recordId);
        const changed = plan.changedNodeIds.map((id) => {
          const node = getNodeById(id);
          return (node?.dataset?.datasetName || node?.dataset?.promptName || node?.dataset?.runName || node?.dataset?.processName || id);
        });
        if (changed.length) {
          const message = `Switch to this history record and restore inputs on: ${changed.slice(0, 10).join(', ')}${changed.length > 10 ? `, and ${changed.length - 10} more` : ''}?`;
          if (!await showConfirm(message, { title: 'Switch History', confirmText: 'Switch' })) return;
        }
        closeModal?.();
        loadCanvasState(plan.state);
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
        getNodeById(nodeId)?.click();
      },
      delete: async (recordId) => {
        let resolved;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          resolved = await reconcileHistory();
          if (!resolved?.stale) break;
        }
        if (resolved?.stale) throw new Error('Canvas changed while preparing deletion. Try again.');
        const options = { runningNodeIds: [...pendingRuns.keys(), ...pendingProcesses] };
        const plan = await historySession.planDelete(recordId, getCanvasState(), options);
        const count = plan.records.length;
        const descendants = count > 1 ? ` This also deletes ${count - 1} dependent record${count === 2 ? '' : 's'}.` : '';
        const names = [...new Set(plan.records.map((record) => record.nodeId))];
        const affected = ` Affected nodes: ${names.slice(0, 8).join(', ')}${names.length > 8 ? `, and ${names.length - 8} more` : ''}.`;
        const approved = await showConfirm(`Delete this history record?${descendants}${affected} This cannot be undone.`, {
          title: 'Delete History', confirmText: `Delete ${count} record${count === 1 ? '' : 's'}`,
        });
        if (!approved) return false;
        await historySession.delete(recordId, getCanvasState(), options, plan.ids);
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
        return true;
      },
    };
  }

  async function reconcileHistory() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await reconcileHistoryOnce();
      if (!result?.stale) return result;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return { stale: true };
  }

  function runHistoryInputKey(state, nodeId) {
    const run = state.nodes.find((item) => item.nodeId === nodeId);
    const promptEdge = state.connections.find((edge) => edge.type === EDGE_TYPE_PROMPT_TO_RUN && edge.toId === nodeId);
    const prompt = state.nodes.find((item) => item.nodeId === promptEdge?.fromId);
    const dataset = state.nodes.find((item) => item.nodeId === run?.runWorkingSetId);
    return JSON.stringify({
      runWorkingSetId: run?.runWorkingSetId, mapping: run?.runInputToColumn,
      settings: run?.runSettings, credential: run?.runCredentialId,
      historyRecordId: run?.historyRecordId,
      promptId: promptEdge?.fromId, prompt,
      dataset, datasetProducer: state.connections.find((edge) => edge.type === EDGE_TYPE_PROCESS_TO_DATASET && edge.toId === dataset?.nodeId),
    });
  }

  async function reconcileRunHistory(nodeId) {
    const session = historySession;
    if (!session?.projectId || canvasHistoryVersion !== 1) return null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const before = getCanvasState();
      const inputKey = runHistoryInputKey(before, nodeId);
      const resolved = await session.resolve(before);
      if (session !== historySession) return null;
      if (inputKey !== runHistoryInputKey(getCanvasState(), nodeId)) continue;
      const item = resolved.state.nodes.find((entry) => entry.nodeId === nodeId && entry.type === 'run');
      const live = getNodeById(nodeId);
      if (!item || !live) return null;
      const inputDataset = resolved.state.nodes.find((entry) => entry.nodeId === item.runWorkingSetId && entry.type === 'dataset');
      if (inputDataset) {
        const datasetNode = getNodeById(inputDataset.nodeId);
        if (inputDataset.sourceRunNodeId || connections.some((edge) => edge.type === EDGE_TYPE_PROCESS_TO_DATASET && edge.toId === inputDataset.nodeId)) {
          datasetContentByNodeId.set(inputDataset.nodeId, cloneDatasetContent(inputDataset.datasetContent));
        }
        if (datasetNode) {
          if (inputDataset.resultMissing) datasetNode.dataset.resultMissing = '1';
          else delete datasetNode.dataset.resultMissing;
          if (inputDataset.historyEdited) datasetNode.dataset.historyEdited = '1';
          else delete datasetNode.dataset.historyEdited;
        }
      }
      for (const key of ['runResults', 'runInputContent', 'runOutputFields', 'runCompleted']) {
        if (item[key] == null) delete live.dataset[key];
        else live.dataset[key] = item[key];
      }
      if (item.runResumable) live.dataset.runResumable = '1';
      else delete live.dataset.runResumable;
      if (item.historyRecordId) live.dataset.historyRecordId = item.historyRecordId;
      else delete live.dataset.historyRecordId;
      const progress = Number(item.runProgress || 0);
      const bar = live.querySelector('.workflow-node__run-progress');
      if (bar) { bar.style.width = `${progress}%`; bar.setAttribute('aria-valuenow', String(progress)); }
      document.dispatchEvent(new CustomEvent('workflow:history-resolved', { detail: resolved }));
      return resolved;
    }
    throw new Error('Run inputs changed while preparing history. Try again.');
  }

  async function reconcileHistoryOnce() {
    if (!historySession?.projectId || canvasHistoryVersion !== 1) return null;
    const session = historySession;
    const revision = historyRevision;
    const before = getCanvasState();
    const resolved = await session.resolve(before);
    const initialKeys = await analysisInputKeys(resolved.state, resolved.currentRecordIds);
    const priorKeys = historyAnalysisKeys;
    for (const node of before.nodes) {
      if (node.type !== 'score' && node.type !== 'promptReview') continue;
      const scoreKey = analysisKeyForSave(priorKeys, initialKeys, 'score', node.nodeId, historyAnalysisKeysInitialized);
      if (node.type === 'score' && scoreKey && (
        node.scoreMatchResult || node.scoreRowExcludedFromScoring
        || await session.analysisRecord(node.nodeId, 'score', scoreKey.signature)
      )) {
        await session.saveAnalysis(node.nodeId, 'score', scoreKey, {
          scoreMatchResult: node.scoreMatchResult || null,
          scoreRowExcludedFromScoring: node.scoreRowExcludedFromScoring || {},
        });
      }
      const reviewKey = analysisKeyForSave(priorKeys, initialKeys, 'review', node.nodeId, historyAnalysisKeysInitialized);
      if (reviewKey && (node.reviewResult || node.reviewProgress
        || await session.analysisRecord(node.nodeId, 'review', reviewKey.signature))) {
        await session.saveAnalysis(node.nodeId, 'review', reviewKey, {
          reviewResult: node.reviewResult || null, reviewProgress: node.reviewProgress || 0,
        });
      }
    }
    for (const node of resolved.state.nodes) {
      if (node.type !== 'score') continue;
      const key = initialKeys.score.get(node.nodeId);
      const saved = key ? await session.analysisRecord(node.nodeId, 'score', key.signature) : null;
      if (saved) {
        node.scoreMatchResult = saved.results?.scoreMatchResult || undefined;
        node.scoreRowExcludedFromScoring = saved.results?.scoreRowExcludedFromScoring || {};
      } else {
        delete node.scoreMatchResult;
        delete node.scoreRowExcludedFromScoring;
      }
    }
    const reviewKeys = (await analysisInputKeys(resolved.state, resolved.currentRecordIds)).review;
    for (const node of resolved.state.nodes) {
      if (node.type !== 'score' && node.type !== 'promptReview') continue;
      const key = reviewKeys.get(node.nodeId);
      const saved = key ? await session.analysisRecord(node.nodeId, 'review', key.signature) : null;
      if (saved) {
        node.reviewResult = saved.results?.reviewResult || undefined;
        if (node.type === 'promptReview') node.reviewProgress = saved.results?.reviewProgress || 0;
      } else {
        delete node.reviewResult;
        if (node.type === 'promptReview') delete node.reviewProgress;
      }
    }
    if (revision !== historyRevision || session !== historySession) return { stale: true };
    for (const item of resolved.state.nodes) {
      const live = getNodeById(item.nodeId);
      if (!live) continue;
      if (item.type === 'dataset' && (item.sourceRunNodeId || connections.some((edge) => edge.type === EDGE_TYPE_PROCESS_TO_DATASET && edge.toId === item.nodeId))) {
        const current = datasetContentByNodeId.get(item.nodeId);
        if (JSON.stringify(current) !== JSON.stringify(cloneDatasetContent(item.datasetContent))) {
          datasetContentByNodeId.set(item.nodeId, item.datasetContent);
        }
        if (item.resultMissing) live.dataset.resultMissing = '1';
        else delete live.dataset.resultMissing;
        if (item.historyEdited) live.dataset.historyEdited = '1';
        else delete live.dataset.historyEdited;
      } else if (item.type === 'run') {
        for (const key of ['runResults', 'runInputContent', 'runOutputFields', 'runCompleted']) {
          if (item[key] == null) delete live.dataset[key];
          else live.dataset[key] = item[key];
        }
        const progress = Number(item.runProgress || 0);
        if (item.runResumable) live.dataset.runResumable = '1';
        else delete live.dataset.runResumable;
        if (item.historyRecordId) live.dataset.historyRecordId = item.historyRecordId;
        else delete live.dataset.historyRecordId;
        const bar = live.querySelector('.workflow-node__run-progress');
        if (bar) { bar.style.width = `${progress}%`; bar.setAttribute('aria-valuenow', String(progress)); }
      } else if (item.type === 'process') {
        if (item.dfResults == null) delete live.dataset.processDfResults;
        else live.dataset.processDfResults = item.dfResults;
        const progress = item.dfResults ? 100 : 0;
        if (item.processResumable) live.dataset.processResumable = '1';
        else delete live.dataset.processResumable;
        if (item.historyRecordId) live.dataset.historyRecordId = item.historyRecordId;
        else delete live.dataset.historyRecordId;
        const bar = live.querySelector('.workflow-node__process-progress');
        if (bar) { bar.style.width = `${progress}%`; bar.setAttribute('aria-valuenow', String(progress)); }
      } else if (item.type === 'score') {
        if (item.scoreMatchResult == null) delete live.dataset.scoreMatchResult;
        else live.dataset.scoreMatchResult = item.scoreMatchResult;
        if (item.scoreRowExcludedFromScoring == null) delete live.dataset.scoreRowExcludedFromScoring;
        else live.dataset.scoreRowExcludedFromScoring = JSON.stringify(item.scoreRowExcludedFromScoring);
        if (item.reviewResult == null) delete live.dataset.reviewResult;
        else live.dataset.reviewResult = item.reviewResult;
        syncScoreNodeProgressFromUpstreamRun(live);
      } else if (item.type === 'promptReview') {
        if (item.reviewResult == null) delete live.dataset.reviewResult;
        else live.dataset.reviewResult = item.reviewResult;
        setReviewNodeProgress(live, Number(item.reviewProgress || 0));
        if (item.reviewInterrupted || item.reviewPending) live.dataset.reviewInterrupted = '1';
        else {
          let incomplete = false;
          try { incomplete = JSON.parse(item.reviewResult || '{}')?.streamComplete === false; } catch (_) {}
          if (incomplete) live.dataset.reviewInterrupted = '1';
          else delete live.dataset.reviewInterrupted;
        }
      }
    }
    historyAnalysisKeys = new Map([
      ...[...initialKeys.score].map(([id, key]) => [`score:${id}`, key]),
      ...[...reviewKeys].map(([id, key]) => [`review:${id}`, key]),
    ]);
    historyAnalysisKeysInitialized = true;
    document.dispatchEvent(new CustomEvent('workflow:history-resolved', { detail: resolved }));
    return resolved;
  }

  /**
   * Replace the canvas with a state the Agent computed (agent/operations/changeSet.js) and the user
   * approved. One canvas-changed event follows the load, so the whole proposal is one undo step.
   */
  function applyAgentCanvasState(nextState, { highlightNodeIds = [] } = {}) {
    // A node's detail window keeps a reference to its element; rebuilding the canvas under it
    // would leave its edits writing to a detached node.
    const openWindows = Array.from(document.querySelectorAll('.modal-overlay')).filter((el) => (
      !el.classList.contains('agent-window-overlay') && !el.classList.contains('pipeline-overview-overlay')
    ));
    if (openWindows.length) {
      throw new Error('A node window is open on the canvas. Close it, then apply the proposal again.');
    }
    // Runs and reviews in flight keep job bookkeeping on their elements that saved state leaves out
    // (resume offsets, stage lists); carry it over to the rebuilt elements.
    const carried = new Map();
    for (const id of new Set([...pendingRuns.keys(), ...pendingReviews.keys(), ...pendingReviewNodeIds])) {
      const el = getNodeById(id);
      if (el) carried.set(id, { ...el.dataset });
    }
    loadCanvasState(nextState);
    for (const [id, data] of carried) {
      const el = getNodeById(id);
      if (!el) continue;
      for (const [key, value] of Object.entries(data)) {
        if (!(key in el.dataset)) el.dataset[key] = value;
      }
    }
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    highlightPipelineNodes(highlightNodeIds);
    if (highlightNodeIds.length) setTimeout(() => highlightPipelineNodes([]), 2500);
  }

  /**
   * Run a Process node's saved code (the Agent's run_nodes) and store its output on the node the way
   * its detail view does, so the node shows 100% and its branches can be saved as Datasets.
   */
  async function runProcessNode(nodeId, { signal, onStarted, timeoutMs } = {}) {
    if (historySession?.projectId && canvasHistoryVersion === 1) {
      let sync;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        sync = await reconcileHistory();
        if (!sync?.stale) break;
      }
      if (sync?.stale) throw new Error('Canvas inputs changed while preparing Process history. Try again.');
    }
    const processNode = getNodeById(nodeId);
    if (!processNode?.classList.contains('workflow-node--process')) throw new Error('Process node was not found.');
    const code = resolveDataframeProcessCode({ dfCode: processNode.dataset.processDfCode, code: processNode.dataset.processCode });
    if (!code) throw new Error('The Process has no code.');
    const { datasets, primaryDatasetId } = getProcessDatasets(processNode);
    const bindings = buildProcessDatasetBindings(datasets, primaryDatasetId);
    const required = new Set([
      primaryDatasetId,
      ...connections.filter((edge) => edge.type === EDGE_TYPE_DATASET_TO_PROCESS && edge.toId === nodeId).map((edge) => edge.fromId),
      ...referencedDatasetAliases(code, bindings),
    ]);
    const executionBindings = bindings.filter((binding) => required.has(binding.nodeId));
    const missingInput = executionBindings.find((binding) => binding.missingResult);
    if (missingInput) throw new Error(`Input Dataset "${missingInput.name}" has no current result.`);
    const session = historySession?.projectId && canvasHistoryVersion === 1 ? historySession : null;
    let record = session ? (await session.reserve(getCanvasState(), nodeId)).record : null;
    if (record) {
      processNode.dataset.historyRecordId = record.id;
      delete processNode.dataset.processDfResults;
      delete processNode.dataset.processResults;
      await reconcileHistory();
    }
    if (session) pendingProcesses.add(nodeId);
    delete processNode.dataset.processResumable;
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    const setProgress = (el, percent) => {
      const bar = el?.querySelector('.workflow-node__process-progress');
      if (!bar) return;
      bar.style.width = `${percent}%`;
      bar.setAttribute('aria-valuenow', String(percent));
    };
    setProgress(processNode, 0);
    let execution;
    try {
      execution = await runProcessCode({
        code, bindings: session ? executionBindings : bindings, signal, timeoutMs,
        onStarted: async (jobId) => {
          if (record) {
            record = { ...record, backendJobId: jobId, updatedAt: new Date().toISOString() };
            await session.putRecord(record);
          }
          onStarted?.(jobId);
        },
      });
    } catch (error) {
      pendingProcesses.delete(nodeId);
      if (record) {
        record = { ...record, status: 'failed', updatedAt: new Date().toISOString(), error: String(error?.message || error) };
        await session.putRecord(record);
      }
      throw error;
    }
    const { outputs, cancelled } = execution;
    // The canvas may have been rebuilt while the job ran (an applied proposal); write to the live node.
    const liveNode = getNodeById(nodeId);
    if (!liveNode) {
      pendingProcesses.delete(nodeId);
      if (record) await session.putRecord({ ...record, status: 'failed', updatedAt: new Date().toISOString(), error: 'The Process node was removed while it ran.' });
      throw new Error('The Process node was removed while it ran.');
    }
    const branchCount = Object.keys(outputs).length;
    const branchesText = `${branchCount} branch${branchCount === 1 ? '' : 'es'}`;
    liveNode.dataset.processDfResults = JSON.stringify({
      outputs,
      statusText: cancelled ? `Cancelled. ${branchesText} returned before stopping.` : `${branchesText} returned.`,
    });
    if (record) {
      record = {
        ...record, status: cancelled ? 'stopped' : 'completed', updatedAt: new Date().toISOString(),
        summary: { ...record.summary, branchCount },
        results: { dfResults: JSON.parse(liveNode.dataset.processDfResults) },
      };
      await session.putRecord(record);
    }
    if (cancelled) liveNode.dataset.processResumable = '1';
    else delete liveNode.dataset.processResumable;
    pendingProcesses.delete(nodeId);
    delete liveNode.dataset.processResults;
    setProgress(liveNode, 100);
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    return { outputs, cancelled };
  }

  /** Ask the backend to stop a Run in flight; the run poll picks up the cancelled status. */
  async function stopRunNode(nodeId) {
    const runId = pendingRuns.get(nodeId);
    if (!runId) return;
    await fetch(`${RUN_API_BASE}/api/run/cancel/${runId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => {});
  }

  /** Ask the backend to stop a Review in flight. */
  async function stopReviewNode(nodeId) {
    await fetch(`${RUN_API_BASE}/api/review/cancel/by-node/${encodeURIComponent(nodeId)}`, { method: 'POST' }).catch(() => {});
  }

  /** A Score's comparison rows: the saved ones, or rebuilt from its live Run and ground truth. */
  async function getScoreComparisonRows(nodeId) {
    const canvasState = getCanvasState();
    const nid = canvasNormalizeNodeId(nodeId);
    const raw = canvasState.nodes.find((n) => canvasNormalizeNodeId(n?.nodeId) === nid);
    if (!raw || raw.type !== 'score') return [];
    try {
      const saved = raw.reviewResult ? JSON.parse(raw.reviewResult)?.comparison_rows : null;
      if (Array.isArray(saved) && saved.length) return saved;
    } catch (_) {}
    const ctx = resolveLiveScoreComparisonContext(canvasState, raw);
    if (!ctx) return [];
    try {
      const rows = await buildReviewComparisonRows(ctx.scoreEl, ctx.runEl, ctx.datasetMap, ctx.promptSections);
      return Array.isArray(rows) ? rows : [];
    } catch (_) {
      return [];
    }
  }

  /** The Agent's view of one node (agent/canvas/workflowNodeInspector.js) with live Score metrics. */
  async function inspectNode(nodeId, options = {}) {
    const history = historySession?.projectId && canvasHistoryVersion === 1
      ? await reconcileHistory() : null;
    const result = inspectWorkflowNode(getCanvasState(), nodeId, {
      ...options,
      extractInputFields: extractInputFieldsFromSections,
    });
    if (result?.found && (result.type === 'run' || result.type === 'process') && history && !history.stale) {
      result.history = await historySession.displayEntriesForNode(nodeId, getCanvasState());
      result.currentHistoryRecordId = history.currentRecordIds?.[nodeId] || null;
    }
    if (!result?.found || result.type !== 'score') return result;
    return enrichInspectScoreResultWithComparisonRows(result, await getScoreComparisonRows(nodeId));
  }

  // Web-only empty-canvas guidance: nothing here before pointed a new user at the top bar's
  // icons or the User Guide, so a brand-new (or freshly-opened, still-empty) project just looked
  // like a blank grid with no indication of what to do next. Desktop is untouched — its users
  // are assumed to already know the app. Driven by a MutationObserver on nodesLayer rather than
  // hooking every node-add/remove/load code path individually, so it stays correct regardless of
  // which of those (there are many: toolbar buttons, the agent, merge, project load) changed it.
  if (!isElectron) {
    const emptyState = document.createElement('div');
    emptyState.className = 'workflow-empty-state';
    emptyState.innerHTML = `
      <div class="workflow-empty-state__box">
        <p class="workflow-empty-state__title">Nothing here yet</p>
        <p class="workflow-empty-state__body">
          Use the icons in the top bar to create a prompt or dataset, connect them on the canvas, then run.
        </p>
        <p class="workflow-empty-state__link">
          <a href="/guide" target="_blank" rel="noopener">Read the full walkthrough &rarr;</a>
        </p>
      </div>
    `;
    canvas.appendChild(emptyState);

    function updateEmptyState() {
      emptyState.hidden = nodesLayer.children.length > 0;
    }
    updateEmptyState();
    new MutationObserver(updateEmptyState).observe(nodesLayer, { childList: true });
  }

  let panelVisibility = { pipeline: false, agent: false };
  let appErrorCount = 0;
  function syncPanelButtons() {
    for (const [button, visible, label] of [
      [currentPipelineBtn, panelVisibility.pipeline, isElectron ? 'Toggle Panel' : 'Current Pipeline'],
      [agentAssistantBtn, panelVisibility.agent, isElectron ? 'Toggle Agent Side Bar' : 'Agent Assistant'],
    ]) {
      button.classList.toggle('is-open', visible);
      button.setAttribute('aria-expanded', String(visible));
      button.setAttribute('aria-label', label);
      button.title = label;
    }
    panelErrorBadge.hidden = !appErrorCount;
    panelErrorBadge.textContent = appErrorCount > 99 ? '99+' : String(appErrorCount);
    if (isElectron) {
      pipelineToggleIcon.replaceChildren(iconLayoutPanel(panelVisibility.pipeline));
      agentToggleIcon.replaceChildren(iconLayoutSidebarRight(panelVisibility.agent));
    }
  }
  const workspacePanels = createWorkspacePanels(root, canvas, ({ pipeline, agent, tab }) => {
    panelVisibility = { pipeline, agent };
    syncPanelButtons();
    if (pipeline) {
      showPipelineOverviewModal(() => detectPipelines(getCanvasState()), {
        host: workspacePanels.pipelineHost,
        getCanvasState,
        getPipelineProjectId,
        getAssetProjectId: getCurrentProjectId,
        saveArtifactAsDataset: ({ name, notes, headers, rows, columnTypes, rowIds }) => addDatasetNode({
          name, notes, headers, rows, columnTypes, rowIds,
        }),
        highlightCanvasNodes: highlightPipelineNodes,
        focusCanvasNodes: focusPipelineNodes,
      });
    }
    if (agent) mountAgentPanel();
    if (!pipeline || tab !== 'pipeline') highlightPipelineNodes([]);
  }, {
    bottomTabs: [
      { id: 'pipeline', label: 'Current Pipeline' },
      ...(isElectron ? [{ id: 'log', label: 'Log' }, { id: 'errors', label: 'Errors' }] : []),
    ],
    onCollapse: () => currentPipelineBtn.focus(),
  });
  if (isElectron) {
    mountBackendLogPanel(workspacePanels.tabHost('log'));
    mountErrorsPanel(workspacePanels.tabHost('errors'));
    subscribeAppErrors((list) => {
      appErrorCount = list.length;
      workspacePanels.setTabBadge('errors', list.length);
      syncPanelButtons();
    });
  }
  new ResizeObserver(() => updateContentSize()).observe(canvas);
  return {
    getCanvasState,
    inspectNode,
    addPromptVersion,
    addRunNode,
    addScoreNode,
    updateScoreNode,
    updateScoreRowSelection,
    createAndRunReviewNode,
    verifyReviewSuggestions,
    acceptReviewSuggestions,
    applyReviewSuggestions,
    startRunNode,
    stopRunNode,
    runProcessNode,
    stopReviewNode,
    saveRunResultsToWorkspace,
    saveScoreResultsToWorkspace,
    addSamplerNode,
    addSampledDatasetNode,
    addPromptNode,
    addDatasetNode,
    addProcessNode,
    importPubmedDataset,
    importClinicaltrialsDataset,
    importPreprintDataset,
    importChemblDataset,
    loadCanvasState,
    setHistorySession,
    recoverHistoryJobs,
    reconcileHistory,
    setOnCanvasChange,
    setAgentWindowVisible,
    panelToggles,
    isPromptNameAlreadyUsed,
    isDatasetNameAlreadyUsed,
    shutdownRunPoll,
    clearSelection,
    deleteSelectedNodes,
    getUsedAssetIds,
  };
}
