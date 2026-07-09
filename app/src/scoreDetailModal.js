/**
 * Score detail modal: left = Dataset as ground truth picker + field mapping table; right = results.
 * @param {{ node: HTMLElement, getWorkingSets?: () => Array<...>, getRunResultColumns?: () => Array<...>, getGroundTruthHeaders?: (wsNodeId: string) => string[], getReviewPayload?: () => { prompt_sections, run_results, output_fields, comparison_rows } | null }} options
 */

import { EditorView, basicSetup } from 'codemirror';
import { python } from '@codemirror/lang-python';
import { showAlert } from './alertModal.js';
import { selectPlaceholderLabel, formatResultOutputColumnLabel } from './displayTextNormalize.js';
import { attachModalPaneCycle } from './paneToggleButton.js';
import { extractInputFieldsFromSections } from './promptDetailModal.js';
import { computeGreedyRunToGtPairing, flattenScoreRules, isScoreInputSideRuleKey } from './scoreRunGtPairing.js';
import {
  parseScoreMappingBundle,
  serializeScoreMappingBundle,
  emptyScoreRuleGroup,
  scoreBundleRootsForEmbeddingWalk,
} from './scoreMappingBundle.js';
import { BACKEND_API_BASE } from './backendConfig.js';

const API_BASE = BACKEND_API_BASE;
const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

const MATCH_CODE_MAX_COMMENT_LINE_CHARS = 70;
const MATCH_CODE_POLL_INTERVAL_MS = 1200;

const MATCH_CODE_FALLBACK = `def match(input_row, output_row, gt_row):
    # input_row: this run row's input columns, keyed by column name.
    # output_row: this run row's model output fields, keyed by field name.
    # gt_row: a candidate ground-truth row's columns, keyed by column name.
    # Return a truthy value if this run row and ground-truth row should be paired
    # and counted as a match; falsy otherwise.
    return True
`;

/** Wraps a comma-separated list into comment-prefixed lines no longer than MATCH_CODE_MAX_COMMENT_LINE_CHARS. */
function wrapMatchCommentList(prefix, continuationPrefix, items) {
  const lines = [];
  let current = prefix;
  items.forEach((item, i) => {
    const piece = (i === 0 ? '' : ', ') + item;
    if (current !== prefix && current.length + piece.length > MATCH_CODE_MAX_COMMENT_LINE_CHARS) {
      lines.push(current);
      current = continuationPrefix + item;
    } else {
      current += piece;
    }
  });
  lines.push(current);
  return lines.join('\n');
}

/** Builds sample code listing the run/ground-truth's actual columns, so the user can edit in place. */
function buildMatchDefaultCode(inputHeaders, outputKeys, gtHeaders) {
  const inCols = (Array.isArray(inputHeaders) ? inputHeaders : []).map((h) => String(h ?? ''));
  const outCols = (Array.isArray(outputKeys) ? outputKeys : []).map((h) => String(h ?? ''));
  const gtCols = (Array.isArray(gtHeaders) ? gtHeaders : []).map((h) => String(h ?? ''));
  if (inCols.length === 0 && outCols.length === 0 && gtCols.length === 0) return MATCH_CODE_FALLBACK;
  const commentLines = [];
  if (inCols.length) commentLines.push(wrapMatchCommentList('    # input_row columns: ', '    #   ', inCols));
  if (outCols.length) commentLines.push(wrapMatchCommentList('    # output_row fields: ', '    #   ', outCols));
  if (gtCols.length) commentLines.push(wrapMatchCommentList('    # gt_row columns: ', '    #   ', gtCols));
  return `def match(input_row, output_row, gt_row):
${commentLines.join('\n')}
    # Return a truthy value if this run row and ground-truth row should be paired
    # and counted as a match; falsy otherwise -- edit the comparison below to fit your task.
    # return output_row.get("col name") == gt_row.get("col name")
    return True
`;
}

/** input_row for the "Match by code" run: this run row's input dataset columns, keyed by column name. */
function buildMatchRunRowInputDict(runResult, runWs) {
  const headers = runWs?.headers || [];
  const rows = runWs?.rows || [];
  const inputRowIdx = runResult?.input_row_index;
  const rowValues = (typeof inputRowIdx === 'number' && rows[inputRowIdx]) ? rows[inputRowIdx] : [];
  const dict = {};
  headers.forEach((h, i) => { dict[String(h ?? '')] = rowValues[i] != null ? String(rowValues[i]) : ''; });
  return dict;
}

/** output_row for the "Match by code" run: this run row's model output fields, keyed by field name. */
function buildMatchRunRowOutputDict(runResult) {
  const out = runResult && runResult.output && typeof runResult.output === 'object' ? runResult.output : {};
  const dict = {};
  Object.keys(out).forEach((k) => { dict[k] = out[k] != null ? String(out[k]) : ''; });
  return dict;
}

/** gt_row for the "Match by code" run: one candidate ground-truth row's columns, keyed by column name. */
function buildMatchGtRowDict(gtContent, rowIndex) {
  const headers = gtContent?.headers || [];
  const rows = gtContent?.rows || [];
  const rowValues = rows[rowIndex] || [];
  const dict = {};
  headers.forEach((h, i) => { dict[String(h ?? '')] = rowValues[i] != null ? String(rowValues[i]) : ''; });
  return dict;
}

/**
 * Builds a `runToGt` array (run row_index -> matched GT row index, or -1) from a completed "Match by
 * code" run (the shape persisted at `node.dataset.scoreMatchResult`), in the same shape
 * `computeGreedyRunToGtPairing` returns -- lets code mode feed the same results-table/metrics pipeline
 * as rule mode in {@link renderResults}, and lets Review's comparison-row builder (workflowCanvas.js)
 * number rows the same way the modal does.
 */
export function buildCodeMatchRunToGt(result, gtRowsLength) {
  const { runRowIndices, outcomes } = result;
  const maxRunRow = runRowIndices.length ? Math.max(...runRowIndices) : -1;
  const dim = Math.max(maxRunRow + 1, gtRowsLength);
  const runToGt = new Array(dim).fill(-1);
  outcomes.forEach((outcome, k) => {
    const i = runRowIndices[k];
    if (typeof i !== 'number' || i < 0) return;
    if (outcome.ok && typeof outcome.matched_gt_index === 'number') runToGt[i] = outcome.matched_gt_index;
  });
  return runToGt;
}

/** Stored in rule.gtColumns; UI label {@link SCORE_GT_ROW_INDEX_LABEL}. Value is 0-based GT row index (aligned with run `#` in getRunValue). */
export const SCORE_GT_ROW_INDEX_COLUMN = '__score_gt_row_index__';
export const SCORE_GT_ROW_INDEX_LABEL = 'Ground truth: #';

/** UI label for a stored GT column (sheet header or {@link SCORE_GT_ROW_INDEX_COLUMN}). Persistence keeps raw names. */
export function formatScoreGroundTruthColumnLabel(columnName) {
  const s = String(columnName ?? '').trim();
  if (!s) return '';
  if (s === SCORE_GT_ROW_INDEX_COLUMN) return SCORE_GT_ROW_INDEX_LABEL;
  return `Ground truth: ${s}`;
}

/**
 * Normalize row match for logic and API. Accepts boolean, legacy 1/0, or string "true"/"false".
 * Persist as JSON boolean (true/false); never rely on string "false" with !matched (non-empty string is truthy).
 */
export function comparisonRowIsMatched(row) {
  const m = row && row.matched;
  if (m === true || m === 'true' || m === 1 || m === '1') return true;
  if (m === false || m === 'false' || m === 0 || m === '0') return false;
  return false;
}

/**
 * True when this run row should participate in Score / Review pairing and tables.
 * Includes API/runtime errors and empty model output (still comparable via input-column rules and shown in UI).
 */
export function isValidRunOutputForScoreRow(r, outputFields) {
  void outputFields;
  if (!r) return false;
  return typeof r.row_index === 'number' && !Number.isNaN(r.row_index);
}

/**
 * Score / Review / export 表格行顺序：按 run 的 row_index 升序，每一行对应一条 run 结果（已配对则 `{ type: 'gt', j }`，
 * 未配对且不与任一 GT 规则匹配则为 `{ type: 'runOnly', i }`），最后附上「无对应 run」的 GT 行。
 * 避免「先列全部 GT、再把无 GT 的 run 摞在底部」从而打乱 Run 结果的自然顺序。
 *
 * @param {{ runRowIndices: number[], runToGt: number[], gtToRun: number[], gtRowsLength: number, evaluateRunMatchesAnyGt: (i: number) => boolean }} p
 * @returns {Array<{ type: 'gt', j: number, displayRunRowIndex?: number } | { type: 'runOnly', i: number }>}
 */
export function buildScoreResultDescriptorsInRunOrder(p) {
  const { runRowIndices, runToGt, gtToRun, gtRowsLength, evaluateRunMatchesAnyGt } = p;
  const sortedRunIndices = [...runRowIndices].sort((a, b) => a - b);
  const descriptors = [];
  const gtLen = Math.max(0, Number(gtRowsLength) || 0);
  const r2g = runToGt || [];
  for (const i of sortedRunIndices) {
    const paired = i < r2g.length && r2g[i] >= 0;
    if (paired) {
      descriptors.push({ type: 'gt', j: r2g[i] });
      continue;
    }
    if (!evaluateRunMatchesAnyGt(i)) {
      descriptors.push({ type: 'runOnly', i });
    }
  }
  for (let j = 0; j < gtLen; j++) {
    if (gtToRun[j] < 0) descriptors.push({ type: 'gt', j });
  }
  return descriptors;
}

/**
 * 贪心配对后仍留在列表末尾、且 `gtToRun[j] < 0` 的 GT 中，若仅 input 规则已与某 run 行一致，则将该行插到该 run 在表中的「块」末尾，
 * 并设置 `displayRunRowIndex`（用于斑马纹、Match 与未配对行的 **输入列/#**对齐；**输出列**不占用第二条 run，显示为 —）。无任何 input 匹配的 GT 仍留在末尾。
 *
 * @param {Array<{ type: 'gt', j: number, displayRunRowIndex?: number } | { type: 'runOnly', i: number }>} descriptors
 * @param {{ runRowIndices: number[], runToGt: number[], gtToRun: number[], inputMatchesPairForRow: (iRun: number, jGt: number) => boolean }} p
 */
export function attachInputMatchedUnpairedGtDescriptors(descriptors, p) {
  const { runRowIndices, runToGt = [], gtToRun = [], inputMatchesPairForRow } = p;
  if (!Array.isArray(descriptors) || descriptors.length === 0) return descriptors;
  if (typeof inputMatchesPairForRow !== 'function') return descriptors;

  const floating = descriptors.filter((d) => d.type === 'gt' && gtToRun[d.j] < 0);
  if (floating.length === 0) return descriptors;

  const base = descriptors.filter((d) => !(d.type === 'gt' && gtToRun[d.j] < 0));
  const sortedRuns = [...new Set(runRowIndices || [])].sort((a, b) => a - b);
  const r2g = runToGt;

  function anchoredRunIndex(d) {
    if (d.type === 'runOnly') return d.i;
    if (d.type === 'gt') {
      const pr = gtToRun[d.j];
      if (typeof pr === 'number' && pr >= 0) return pr;
      const dr = d.displayRunRowIndex;
      if (typeof dr === 'number' && dr >= 0) return dr;
    }
    return -1;
  }

  function findInsertAfterIndex(anchor) {
    for (let k = base.length - 1; k >= 0; k--) {
      if (anchoredRunIndex(base[k]) === anchor) return k + 1;
    }
    return -1;
  }

  const sortedFloat = [...floating].sort((a, b) => a.j - b.j);
  for (const d0 of sortedFloat) {
    const j = d0.j;
    const matchedRuns = sortedRuns.filter((i) => inputMatchesPairForRow(i, j));
    if (matchedRuns.length === 0) {
      base.push({ type: 'gt', j });
      continue;
    }
    const anchor = matchedRuns.find((i) => i < r2g.length && r2g[i] >= 0) ?? matchedRuns[0];
    const insertAt = findInsertAfterIndex(anchor);
    /** @type {{ type: 'gt', j: number, displayRunRowIndex?: number }} */
    const row = { type: 'gt', j };
    if (typeof anchor === 'number' && anchor >= 0) row.displayRunRowIndex = anchor;
    if (insertAt < 0) base.push(row);
    else base.splice(insertAt, 0, row);
  }
  return base;
}

/**
 * Ground truth 列在 Score 表中的顺序：与数据表表头一致，不因 rule 树遍历顺序重排。
 * 规则里引用但表中不存在的列按在规则中首次出现的顺序接在后面。
 */
export function orderScoreGtColsBySheetHeaders(colsUsedFirstPass, sheetHeaders) {
  const used = colsUsedFirstPass || [];
  const headers = sheetHeaders || [];
  const want = new Set(used.filter(Boolean).map((c) => String(c).trim()));
  if (want.size === 0) return [];
  const out = [];
  const taken = new Set();
  for (const h of headers) {
    const name = String(h ?? '').trim();
    if (!name || !want.has(name) || taken.has(name)) continue;
    out.push(h);
    taken.add(name);
  }
  for (const c of used) {
    if (!c) continue;
    const name = String(c).trim();
    if (!name || taken.has(name)) continue;
    out.push(c);
    taken.add(name);
  }
  return out;
}

/**
 * 参与去重的 output key 顺序：与 Run 的 outputFields（schema）一致，不因 rule 顺序重排。
 */
export function orderScoreOutputKeysByOutputFields(keysUsedFirstPass, outputFields) {
  const used = keysUsedFirstPass || [];
  const fields = outputFields || [];
  const want = new Set(used.map((k) => String(k).trim()).filter(Boolean));
  if (want.size === 0) return [];
  const out = [];
  const taken = new Set();
  for (const f of fields) {
    const k = String(f.key || '').trim();
    if (!k || !want.has(k) || taken.has(k)) continue;
    out.push(f.key);
    taken.add(k);
  }
  for (const k of used) {
    const ks = String(k).trim();
    if (!ks || taken.has(ks)) continue;
    out.push(k);
    taken.add(ks);
  }
  return out;
}

/**
 * GT columns in Score / export / Review comparison: **all** ground-truth sheet headers (sheet order),
 * then any rule-only columns (e.g. synthetic row index) not present in the sheet.
 */
export function buildScoreTableGtColumns(rulesFlat, rawGtContent) {
  const sheetHeaders = (rawGtContent && Array.isArray(rawGtContent.headers)) ? rawGtContent.headers.slice() : [];
  const fromRules = [];
  for (const r of rulesFlat || []) {
    for (const c of (r.gtColumns || [])) {
      if (c && !fromRules.includes(c)) fromRules.push(c);
    }
  }
  if (sheetHeaders.length === 0) {
    return orderScoreGtColsBySheetHeaders(fromRules, []);
  }
  const out = sheetHeaders.slice();
  const seen = new Set(sheetHeaders.map((h) => String(h ?? '').trim()).filter(Boolean));
  for (const c of fromRules) {
    const name = String(c ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(c);
  }
  return out;
}

/**
 * GT columns referenced by rules only (sheet order + rule-only columns), for the “only columns used in rules” table filter.
 */
export function buildScoreTableGtColumnsRulesOnly(rulesFlat, rawGtContent) {
  const fromRules = [];
  for (const r of rulesFlat || []) {
    for (const c of (r.gtColumns || [])) {
      if (c && !fromRules.includes(c)) fromRules.push(c);
    }
  }
  const sheetHeaders = (rawGtContent && Array.isArray(rawGtContent.headers)) ? rawGtContent.headers.slice() : [];
  return orderScoreGtColsBySheetHeaders(fromRules, sheetHeaders);
}

function filterScoreInputHeadersByRules(rulesFlat, inputHeaders) {
  const hs = inputHeaders || [];
  return hs.filter((h) => {
    const label = String(h ?? '').trim();
    if (!label) return false;
    const bracket = `[${label}]`;
    return (rulesFlat || []).some((r) => String(r.outputKey || '').trim() === bracket);
  });
}

function filterScoreOutputFieldsByRules(rulesFlat, outputFields) {
  const keysFirst = [];
  for (const r of rulesFlat || []) {
    const k = String(r.outputKey || '').trim();
    if (!keysFirst.includes(k)) keysFirst.push(k);
  }
  const orderedKeys = orderScoreOutputKeysByOutputFields(keysFirst, outputFields || []);
  const fields = outputFields || [];
  return orderedKeys.map((k) => fields.find((f) => String(f.key || '').trim() === String(k).trim())).filter(Boolean);
}

/** Rule 的 run 侧键是否对应「输出行号」列（# / [#]，与 getRunValue 一致）。 */
function scoreRulesReferenceRunOutputRowIndex(rulesFlat) {
  return (rulesFlat || []).some((r) => {
    const k = String(r.outputKey || '').trim();
    return k === '#' || k === '[#]';
  });
}

const SCORE_ZEBRA_NO_RUN = '__no_run__';

/**
 * 斑马带键：仅由 input-side 规则在 **run 行**上的取值构成（不含 GT 单元格），同一 run / 同一输入带同色。
 * 未配对 GT 且无 run 索引时：若当前结果集只有一条 run，则用该 run 取 input，使「1 条 run + 多条 GT」同属一条斑马带。
 */
function buildScoreInputBandKey(iRun, jGt, inputLeaves, resultsByIndex, runWs, outputFields, gtContent, getRunValue, getGtValue) {
  void jGt;
  void gtContent;
  void getGtValue;
  let effectiveIRun = iRun;
  if (typeof effectiveIRun !== 'number' || effectiveIRun < 0) {
    if (resultsByIndex.size === 1) {
      effectiveIRun = resultsByIndex.keys().next().value;
    }
  }
  const rr = typeof effectiveIRun === 'number' && effectiveIRun >= 0 ? resultsByIndex.get(effectiveIRun) : null;
  const parts = [];
  for (const rule of inputLeaves) {
    const rv = rr ? getRunValue(rr, rule.outputKey, effectiveIRun, runWs, outputFields) : '';
    parts.push(`${String(rule.outputKey || '')}\0${rv}`);
  }
  return parts.join('\u0002');
}

/**
 * 斑马纹：input 规则树定义带键；无 input 叶子时回退为 input_row_index。
 */
function buildScoreZebraStripes(
  displayDescriptors,
  resultsByIndex,
  gtToRun,
  inputRoot,
  runWs,
  outputFields,
  gtContent,
  getRunValue,
  getGtValue,
) {
  const inputLeaves = flattenScoreRules(inputRoot || emptyScoreRuleGroup());
  const g2r = gtToRun || [];
  const keyToStripe = new Map();
  let ord = 0;
  const stripes = [];
  const list = displayDescriptors || [];

  function effectiveGtRunRowIndex(d) {
    if (d.type !== 'gt') return -1;
    let runRowIndex = g2r[d.j];
    if (typeof runRowIndex !== 'number' || runRowIndex < 0) {
      const dr = d.displayRunRowIndex;
      if (typeof dr === 'number' && dr >= 0) runRowIndex = dr;
    }
    return typeof runRowIndex === 'number' && runRowIndex >= 0 ? runRowIndex : -1;
  }

  function stripeKeyFor(d) {
    if (inputLeaves.length === 0) {
      if (d.type === 'gt') {
        const iRun = effectiveGtRunRowIndex(d);
        if (iRun < 0) return SCORE_ZEBRA_NO_RUN;
        const rr = resultsByIndex.get(iRun) || null;
        return rr ? (rr.input_row_index ?? iRun) : SCORE_ZEBRA_NO_RUN;
      }
      const rr = resultsByIndex.get(d.i) || null;
      return rr ? (rr.input_row_index ?? d.i) : d.i;
    }
    if (d.type === 'gt') {
      const i = effectiveGtRunRowIndex(d);
      return buildScoreInputBandKey(i, d.j, inputLeaves, resultsByIndex, runWs, outputFields, gtContent, getRunValue, getGtValue);
    }
    return buildScoreInputBandKey(d.i, -1, inputLeaves, resultsByIndex, runWs, outputFields, gtContent, getRunValue, getGtValue);
  }

  for (let idx = 0; idx < list.length; idx++) {
    const k = stripeKeyFor(list[idx]);
    if (!keyToStripe.has(k)) {
      keyToStripe.set(k, ord % 2);
      ord++;
    }
    stripes.push(keyToStripe.get(k));
  }
  return stripes;
}

/** Comparison type (single choice). Legacy `contains` / `gt-contains-run` become String match + matchFlags.contains. */
const MATCH_TYPES = [
  { value: 'exact', label: 'String match' },
  { value: 'numeric', label: 'Numeric equality' },
];

/** String match option flags (multi-select; ignored when comparison type is numeric) */
const MATCH_FLAGS = [
  { key: 'contains', label: 'Contains' },
  { key: 'ignoreCase', label: 'Ignore case' },
  { key: 'ignoreSymbols', label: 'Ignore symbols' },
  { key: 'ignoreWhitespace', label: 'Ignore whitespace' },
];

const DEFAULT_MATCH_FLAGS = {
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

/** Numeric compare mode (only when matchType === 'numeric'); single choice in the rule editor. */
const NUMERIC_COMPARE_MODES = [
  { value: 'exact', label: 'Exact: values must be numerically equal' },
  { value: 'abs', label: 'Absolute margin: |value − ground truth| ≤ ε' },
  { value: 'rel', label: 'Relative margin: proportional difference (r)' },
  { value: 'decimals', label: 'Decimal rounding: equal after rounding to N places' },
];

/** Session-only: (outputKey + '\t' + gtColumn) -> { matchType, matchFlags }. Not persisted. */
const ruleEditorMemory = {};
/** Session-only: ordered list of top-level items { type: 'rule', ... } | { type: 'group', ops, children }. Preserves original order. */
const ruleEditorMemoryOrdered = [];

export function canonicalizeMatchFlags(f) {
  const merged = { ...DEFAULT_MATCH_FLAGS, ...(f && typeof f === 'object' ? f : {}) };
  const mode = ['exact', 'abs', 'rel', 'decimals'].includes(merged.numericMode) ? merged.numericMode : 'exact';
  let absE = Number(merged.numericAbsEpsilon);
  if (!Number.isFinite(absE) || absE < 0) absE = 0;
  let relE = Number(merged.numericRelEpsilon);
  if (!Number.isFinite(relE) || relE < 0) relE = 0;
  let dec = Math.floor(Number(merged.numericDecimalPlaces));
  if (!Number.isFinite(dec)) dec = 2;
  dec = Math.max(0, Math.min(20, dec));
  let embeddingSimilarity = !!merged.embeddingSimilarity;
  let semanticAlign = !!merged.semanticAlign;
  if (embeddingSimilarity && semanticAlign) semanticAlign = false;
  const softString = embeddingSimilarity || semanticAlign;
  return {
    semanticAlign,
    embeddingSimilarity,
    contains: softString ? false : !!merged.contains,
    ignoreCase: softString ? false : !!merged.ignoreCase,
    ignoreSymbols: softString ? false : !!merged.ignoreSymbols,
    ignoreWhitespace: softString ? false : !!merged.ignoreWhitespace,
    numericMode: mode,
    numericAbsEpsilon: absE,
    numericRelEpsilon: relE,
    numericDecimalPlaces: dec,
  };
}

function getMatchFlags(rule) {
  const f = rule && rule.matchFlags;
  return canonicalizeMatchFlags(f);
}

/** Round half-up to `places` decimal places (0-20). */
function roundToDecimals(n, places) {
  const p = Math.max(0, Math.min(20, Math.floor(places)));
  const m = 10 ** p;
  return Math.round(n * m) / m;
}

/**
 * Compare two trimmed string forms of numbers per numericMode (and parameters) on flags.
 * If either side is not a finite number, falls back to string equality.
 */
export function numericPairMatches(runTrimmedStr, gtTrimmedStr, flags) {
  const runNorm = runTrimmedStr == null ? '' : String(runTrimmedStr).trim();
  const gtNorm = gtTrimmedStr == null ? '' : String(gtTrimmedStr).trim();
  const runNum = parseFloat(runNorm);
  const gtNum = parseFloat(gtNorm);
  if (!Number.isFinite(runNum) || !Number.isFinite(gtNum)) {
    return runNorm === gtNorm;
  }
  const mode = flags.numericMode || 'exact';
  if (mode === 'abs') {
    const eps = Number(flags.numericAbsEpsilon);
    const e = Number.isFinite(eps) && eps >= 0 ? eps : 0;
    return Math.abs(runNum - gtNum) <= e;
  }
  if (mode === 'rel') {
    const rel = Number(flags.numericRelEpsilon);
    const r = Number.isFinite(rel) && rel >= 0 ? rel : 0;
    const denom = Math.max(Math.abs(runNum), Math.abs(gtNum), 1e-15);
    return Math.abs(runNum - gtNum) / denom <= r;
  }
  if (mode === 'decimals') {
    let p = Math.floor(Number(flags.numericDecimalPlaces));
    if (!Number.isFinite(p)) p = 2;
    p = Math.max(0, Math.min(20, p));
    return roundToDecimals(runNum, p) === roundToDecimals(gtNum, p);
  }
  return runNum === gtNum;
}

/** 对字符串应用规范化（用于比较前）；numeric 时不使用 flags，仅 trim 后按数值比较。 */
function normalizeForMatch(str, flags, isNumeric) {
  let s = str == null ? '' : String(str).trim();
  if (isNumeric) return s;
  if (flags.ignoreWhitespace) s = s.replace(/\s+/g, ' ').trim();
  if (flags.ignoreCase) s = s.toLowerCase();
  if (flags.ignoreSymbols) s = s.replace(/[^\w\s]/gu, '').replace(/\s+/g, ' ').trim();
  return s;
}

/** Map deprecated comparison types to current values (`contains` / `gt-contains-run` → `exact` + flag). */
export function migrateLegacyMatchType(matchType) {
  if (matchType === 'contains' || matchType === 'gt-contains-run') return 'exact';
  return matchType || 'exact';
}

/** True if legacy matchType used substring rules (now matchFlags.contains). */
export function legacyMatchTypeWasContains(matchType) {
  return matchType === 'contains' || matchType === 'gt-contains-run';
}

/**
 * Mutual substring match after normalization (replaces "result contains GT" OR "GT contains result").
 * Empty vs empty matches; one empty vs non-empty does not.
 */
export function stringsMatchContains(runVal, gtVal) {
  const r = runVal == null ? '' : String(runVal);
  const g = gtVal == null ? '' : String(gtVal);
  if (r.length === 0 && g.length === 0) return true;
  if (r.length === 0 || g.length === 0) return false;
  return r.includes(g) || g.includes(r);
}

/** Sørensen–Dice on character bigrams; internal normalize: trim, lower case, collapse whitespace. Not a true embedding model. */
const SEMANTIC_ALIGN_DICE_THRESHOLD = 0.65;

function normalizeSemanticAlignInput(v) {
  return String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
}

function stringCharBigrams(s) {
  if (s.length < 2) return [];
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

export function stringsMatchSemanticAlign(runVal, gtVal) {
  const a = normalizeSemanticAlignInput(runVal);
  const b = normalizeSemanticAlignInput(gtVal);
  if (a.length === 0 && b.length === 0) return true;
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  if (a.length < 2 || b.length < 2) return a === b;
  const ba = stringCharBigrams(a);
  const bb = stringCharBigrams(b);
  const counts = new Map();
  for (const x of ba) counts.set(x, (counts.get(x) || 0) + 1);
  let inter = 0;
  for (const x of bb) {
    const c = counts.get(x) || 0;
    if (c > 0) {
      inter++;
      counts.set(x, c - 1);
    }
  }
  const dice = (2 * inter) / (ba.length + bb.length);
  return dice >= SEMANTIC_ALIGN_DICE_THRESHOLD;
}

/** Cosine threshold for backend FastEmbed (MiniLM) pair similarities; tuned for “close enough” paraphrases. */
export const EMBEDDING_COSINE_THRESHOLD = 0.76;

export function embeddingPairMatches(runValRaw, gtValRaw, embeddingCosineMap) {
  const a = runValRaw == null ? '' : String(runValRaw);
  const b = gtValRaw == null ? '' : String(gtValRaw);
  if (a.length === 0 && b.length === 0) return true;
  if (a.length === 0 || b.length === 0) return false;
  const key = JSON.stringify([a, b]);
  const c = embeddingCosineMap.get(key);
  if (typeof c !== 'number' || !Number.isFinite(c)) return false;
  return c >= EMBEDDING_COSINE_THRESHOLD;
}

/**
 * Collect unique (result, GT) string pairs for rules that use embedding similarity, then call the backend once per chunk.
 * @param {string} apiBase e.g. BACKEND_API_BASE
 */
export async function prefetchEmbeddingCosineMap(apiBase, { root, roots, results, outputFields, runWs, gtContent, getRunValue, getGtValue }) {
  const rootsToWalk = Array.isArray(roots) && roots.length > 0 ? roots.filter(Boolean) : (root != null ? [root] : []);
  const leafRules = [];
  for (const rt of rootsToWalk) {
    (function walk(n) {
      if (!n) return;
      if (n.type === 'rule') leafRules.push(n);
      if (n.type === 'group' && Array.isArray(n.children)) n.children.forEach(walk);
    })(rt);
  }
  const embeddingRules = leafRules.filter((rule) => {
    const f = getMatchFlags(rule);
    return migrateLegacyMatchType(rule.matchType) === 'exact' && f.embeddingSimilarity;
  });
  if (embeddingRules.length === 0) return new Map();

  const resultsByIndex = new Map();
  (results || []).forEach((r) => { resultsByIndex.set(r.row_index, r); });
  const runRowIndices = [...new Set((results || []).map((r) => r.row_index))];
  const gtCount = (gtContent.rows || []).length;
  const seen = new Set();
  const pairs = [];
  for (const i of runRowIndices) {
    const runResult = resultsByIndex.get(i) || null;
    for (let j = 0; j < gtCount; j++) {
      for (const rule of embeddingRules) {
        const runValRaw = getRunValue(runResult, rule.outputKey, i, runWs, outputFields);
        const gtValsRaw = (rule.gtColumns || []).map((col) => getGtValue(gtContent, j, col));
        for (const gt of gtValsRaw) {
          const a = runValRaw == null ? '' : String(runValRaw);
          const b = gt == null ? '' : String(gt);
          const key = JSON.stringify([a, b]);
          if (seen.has(key)) continue;
          seen.add(key);
          pairs.push([a, b]);
        }
      }
    }
  }
  if (pairs.length === 0) return new Map();

  const map = new Map();
  const base = String(apiBase || BACKEND_API_BASE).replace(/\/$/, '');
  const CHUNK = 320;
  for (let off = 0; off < pairs.length; off += CHUNK) {
    const chunk = pairs.slice(off, off + CHUNK);
    const res = await fetch(`${base}/api/embeddings/pair-similarities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairs: chunk }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(t || `Embedding API HTTP ${res.status}`);
    }
    const data = await res.json();
    const cosines = data.cosines;
    if (!Array.isArray(cosines) || cosines.length !== chunk.length) {
      throw new Error('Invalid embedding API response');
    }
    chunk.forEach((p, idx) => {
      map.set(JSON.stringify(p), cosines[idx]);
    });
  }
  return map;
}

export { getMatchFlags, normalizeForMatch };

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  const s = String(str ?? '');
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Parse a non-negative number from rule-editor text (decimals, optional single comma as decimal separator). */
function parseFlexibleNonNegativeNumber(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/\s+/g, '');
  if (s === '') return NaN;
  if (/^\d+,\d+$/.test(s)) s = s.replace(',', '.');
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return NaN;
  return n;
}

/**
 * Create Review node and start review API (job-based, like Run). Polling is handled by workflowCanvas.
 * @param {{ scoreNodeId: string, getReviewPayload: () => { prompt_sections, prompt_full_text?, run_results, output_fields, comparison_rows } | null, credentialId: string }} options
 * @returns {Promise<{ reviewNodeId: string } | null>} reviewNodeId after node is created; null if payload/credential invalid
 */
export async function runReviewFromScore({ scoreNodeId, getReviewPayload, credentialId }) {
  const payload = await Promise.resolve(getReviewPayload && getReviewPayload());
  if (!credentialId || !payload || !payload.prompt_sections || !payload.prompt_sections.length) return Promise.resolve(null);
  const addEvent = new CustomEvent('workflow:add-prompt-review-node', { detail: { scoreNodeId } });
  document.dispatchEvent(addEvent);
  const reviewNodeId = addEvent.detail?.reviewNodeId || '';
  if (!reviewNodeId) return Promise.resolve(null);
  return runReviewStart({ reviewNodeId, payload, credentialId, registerPendingReview: addEvent.detail?.registerPendingReview }).then(() => ({ reviewNodeId }));
}

/** @param {unknown} raw */
function reviewPreviewCellHtml(raw) {
  if (raw == null || raw === '') return '<span class="review-selection-preview-empty">—</span>';
  let s;
  if (typeof raw === 'object') s = JSON.stringify(raw);
  else s = String(raw);
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '<span class="review-selection-preview-empty">—</span>';
  const max = 480;
  if (s.length <= max) return escapeHtml(s);
  const short = `${s.slice(0, max)}…`;
  return `<span class="review-selection-preview-clip" title="${escapeAttr(s)}">${escapeHtml(short)}</span>`;
}

function buildReviewPreviewInputBlock(rowInput, promptSections) {
  const obj = rowInput && typeof rowInput === 'object' ? rowInput : {};
  const ordered = extractInputFieldsFromSections(Array.isArray(promptSections) ? promptSections : []);
  const seen = new Set();
  /** @type {{ k: string, raw: unknown }[]} */
  const pairs = [];
  for (const k of ordered) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      pairs.push({ k, raw: obj[k] });
      seen.add(k);
    }
  }
  for (const k of Object.keys(obj).sort()) {
    if (!seen.has(k)) pairs.push({ k, raw: obj[k] });
  }
  if (pairs.length === 0) {
    return '<p class="review-selection-preview-empty">No prompt placeholders / inputs for this worksheet row.</p>';
  }
  return `<dl class="review-selection-preview-kv">${pairs.map(({ k, raw }) => `
    <div class="review-selection-preview-kv-pair">
      <dt>${escapeHtml(k)}</dt>
      <dd>${reviewPreviewCellHtml(raw)}</dd>
    </div>`).join('')}</dl>`;
}

/**
 * Group key + sort order for Review preview: primary = worksheet input index; GT-only = GT row; else run row fallback.
 * @param {any} r
 */
function reviewPreviewInputGroupMeta(r) {
  if (typeof r.input_row_index === 'number' && !Number.isNaN(r.input_row_index)) {
    const i = r.input_row_index;
    return {
      key: `in:${i}`,
      sortKey: i,
      title: `Input #${i + 1}`,
      hint: 'Worksheet row mapped into the prompt',
    };
  }
  if (r.gt_only === true && typeof r.source_gt_row_index === 'number' && !Number.isNaN(r.source_gt_row_index)) {
    const j = r.source_gt_row_index;
    return {
      key: `gtonly:${j}`,
      sortKey: 1_000_000 + j,
      title: `Ground truth #${j + 1}`,
      hint: 'GT-only line in Score — no paired model output',
    };
  }
  const ri = typeof r.row_index === 'number' && !Number.isNaN(r.row_index) ? r.row_index : 0;
  return {
    key: `run:${ri}`,
    sortKey: 1_500_000 + ri,
    title: `${formatResultOutputColumnLabel('#')} ${ri + 1}`,
    hint: 'No worksheet input index on this payload — grouped by run output row',
  };
}

/** True when there is nothing to show as model output (GT-only or empty run_output). */
function reviewPreviewRowHasNoModelOutput(r) {
  if (r.gt_only === true) return true;
  const ro = r?.run_output && typeof r.run_output === 'object' ? r.run_output : {};
  const keys = Object.keys(ro);
  if (keys.length === 0) return true;
  return keys.every((k) => {
    const v = ro[k];
    if (v == null) return true;
    if (typeof v === 'string' && !String(v).trim()) return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  });
}

/** True when ground_truth_output is all empty and expected is empty or placeholder em dash. */
function reviewPreviewRowHasNoGroundTruth(r) {
  const gto = r.ground_truth_output && typeof r.ground_truth_output === 'object' ? r.ground_truth_output : {};
  const keys = Object.keys(gto);
  const gtoAllEmpty =
    keys.length === 0 ||
    keys.every((k) => {
      const v = gto[k];
      if (v == null) return true;
      if (typeof v === 'string' && !String(v).trim()) return true;
      if (Array.isArray(v) && v.length === 0) return true;
      return false;
    });
  const exp = r.expected == null ? '' : String(r.expected).replace(/\s+/g, ' ').trim();
  const expEmpty = exp === '' || exp === '—';
  return gtoAllEmpty && expEmpty;
}

/**
 * Output / GT column keys for the Review preview tables (payload order when configured, else union of row keys).
 * @param {any[]} outputFields
 * @param {any[]} rows
 * @returns {{ key: string, label: string }[]}
 */
function collectReviewPreviewOutputColumnDefs(outputFields, rows) {
  const fields = Array.isArray(outputFields) ? outputFields : [];
  if (fields.length > 0) {
    return fields
      .map((f) => {
        const key = String(f.key || '').trim();
        const label = formatResultOutputColumnLabel((f.display || f.key || '').trim() || key || '—');
        return { key, label };
      })
      .filter((c) => c.key);
  }
  const keySet = new Set();
  for (const r of rows) {
    const ro = r?.run_output && typeof r.run_output === 'object' ? r.run_output : {};
    for (const k of Object.keys(ro)) keySet.add(k);
    const gto = r?.ground_truth_output && typeof r.ground_truth_output === 'object' ? r.ground_truth_output : {};
    for (const k of Object.keys(gto)) keySet.add(k);
  }
  return [...keySet].sort().map((key) => ({ key, label: formatResultOutputColumnLabel(key) }));
}

/** Match / mismatch + GT-only chips for one score line (table cell). */
function reviewPreviewResultChipsHtml(r) {
  const matched = comparisonRowIsMatched(r);
  const gtOnly = r.gt_only === true;
  const chipMatch = matched
    ? '<span class="review-selection-preview-chip review-selection-preview-chip--ok">Match</span>'
    : '<span class="review-selection-preview-chip review-selection-preview-chip--bad">Mismatch</span>';
  const chipGt = gtOnly ? '<span class="review-selection-preview-chip review-selection-preview-chip--info">GT only</span>' : '';
  return `<span class="review-selection-preview-table-chips">${chipMatch}${chipGt}</span>`;
}

/** One table: every checked score line × all model output fields (same order as Score table). */
function buildReviewPreviewModelOutputTable(rows, outputFields) {
  if (!rows.length) return '<p class="review-selection-preview-empty">—</p>';
  const cols = collectReviewPreviewOutputColumnDefs(outputFields, rows);
  const runHashLabel = formatResultOutputColumnLabel('#');
  const thFields = cols.map((c) => `<th scope="col">${escapeHtml(c.label)}</th>`).join('');
  const thead = `<thead><tr>
    <th scope="col">Score #</th>
    <th scope="col" title="Run result row (1-based)">${escapeHtml(runHashLabel)}</th>
    <th scope="col">Result</th>
    ${thFields}
  </tr></thead>`;
  const tbody = `<tbody>${rows
    .map((r) => {
      const scoreTableRow = r.score_table_row != null && r.score_table_row !== '' ? String(r.score_table_row) : '—';
      const runNum =
        typeof r.row_index === 'number' && !Number.isNaN(r.row_index) ? String(r.row_index + 1) : '—';
      const ro =
        r.gt_only === true ? {} : r.run_output && typeof r.run_output === 'object' ? r.run_output : {};
      const cells = cols.map((c) => `<td>${reviewPreviewCellHtml(ro[c.key])}</td>`).join('');
      return `<tr>
      <td>${escapeHtml(scoreTableRow)}</td>
      <td>${escapeHtml(runNum)}</td>
      <td>${reviewPreviewResultChipsHtml(r)}</td>
      ${cells}
    </tr>`;
    })
    .join('')}</tbody>`;
  return `<div class="review-selection-preview-table-scroll"><table class="review-selection-preview-big-table">${thead}${tbody}</table></div>`;
}

/** One table: every checked score line × expected per field + full rule-target text. */
function buildReviewPreviewGroundTruthTable(rows, outputFields) {
  if (!rows.length) return '<p class="review-selection-preview-empty">—</p>';
  const cols = collectReviewPreviewOutputColumnDefs(outputFields, rows);
  const runHashLabel = formatResultOutputColumnLabel('#');
  const thFields = cols
    .map(
      (c) =>
        `<th scope="col">${escapeHtml(c.label)} <span class="review-selection-preview-th-hint">(expected)</span></th>`,
    )
    .join('');
  const thead = `<thead><tr>
    <th scope="col">Score #</th>
    <th scope="col" title="Run result row (1-based)">${escapeHtml(runHashLabel)}</th>
    <th scope="col">Result</th>
    ${thFields}
    <th scope="col">Rule targets <span class="review-selection-preview-th-hint">(all text)</span></th>
  </tr></thead>`;
  const tbody = `<tbody>${rows
    .map((r) => {
      const scoreTableRow = r.score_table_row != null && r.score_table_row !== '' ? String(r.score_table_row) : '—';
      const runNum =
        typeof r.row_index === 'number' && !Number.isNaN(r.row_index) ? String(r.row_index + 1) : '—';
      const gto = r.ground_truth_output && typeof r.ground_truth_output === 'object' ? r.ground_truth_output : {};
      const cells = cols.map((c) => `<td>${reviewPreviewCellHtml(gto[c.key])}</td>`).join('');
      const expRaw = r.expected == null ? '' : String(r.expected).replace(/\s+/g, ' ').trim();
      const expDisp = expRaw === '—' ? '' : expRaw;
      return `<tr>
      <td>${escapeHtml(scoreTableRow)}</td>
      <td>${escapeHtml(runNum)}</td>
      <td>${reviewPreviewResultChipsHtml(r)}</td>
      ${cells}
      <td>${reviewPreviewCellHtml(expDisp)}</td>
    </tr>`;
    })
    .join('')}</tbody>`;
  return `<div class="review-selection-preview-table-scroll"><table class="review-selection-preview-big-table">${thead}${tbody}</table></div>`;
}

/**
 * Debug modal: Review-checked rows shown as Input # key-value blocks and Ground truth # key-value blocks.
 * Does not add a Review node or call the analyze API.
 * @param {{ getReviewPayload: () => unknown }} options
 */
export async function openReviewSelectionPreviewModal({ getReviewPayload }) {
  if (typeof getReviewPayload !== 'function') return;
  const payload = await Promise.resolve(getReviewPayload());
  if (!payload || !payload.prompt_sections || !payload.prompt_sections.length) {
    showAlert('Cannot build Review data. Ensure the Score node is connected to a Run with a prompt that has sections.', { title: 'Debug: Review rows' });
    return;
  }
  const comparisonRows = Array.isArray(payload.comparison_rows) ? payload.comparison_rows : [];
  if (comparisonRows.length === 0) {
    showAlert('No rows selected for Review. Turn on the Review checkboxes in the Score results table for the rows you want.', { title: 'Debug: Review rows' });
    return;
  }

  /** Render a key-value object as a definition list. */
  function kvHtml(obj) {
    if (!obj || typeof obj !== 'object') return '<span class="review-diagnosis-detail-empty">—</span>';
    const pairs = Object.entries(obj);
    if (pairs.length === 0) return '<span class="review-diagnosis-detail-empty">—</span>';
    const MAX = 480;
    const cell = (raw) => {
      if (raw == null || raw === '') return '<span class="review-diagnosis-detail-empty">—</span>';
      let s = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
      s = s.replace(/\s+/g, ' ').trim();
      if (!s) return '<span class="review-diagnosis-detail-empty">—</span>';
      if (s.length > MAX) return `<span title="${escapeAttr(s)}">${escapeHtml(s.slice(0, MAX))}\u2026</span>`;
      return escapeHtml(s);
    };
    return `<dl class="review-suggestion-debug-kv">${pairs.map(([k, v]) =>
      `<div class="review-suggestion-debug-kv-pair"><dt>${escapeHtml(k)}</dt><dd>${cell(v)}</dd></div>`
    ).join('')}</dl>`;
  }

  // Collect unique inputs (by input_row_index) and GT rows (by source_gt_row_index + 1)
  const inputMap = new Map();      // input_row_index → { rowInput, total, failed, gtNums: Set<gt_row_1based> }
  const gtMap = new Map();         // source_gt_row_index + 1 → ground_truth_output
  for (const r of comparisonRows) {
    const inpKey = r.input_row_index != null ? r.input_row_index : null;
    const gtKey = r.source_gt_row_index != null ? r.source_gt_row_index + 1 : null;
    if (inpKey !== null) {
      if (!inputMap.has(inpKey)) inputMap.set(inpKey, { rowInput: null, total: 0, failed: 0, gtNums: new Set() });
      const entry = inputMap.get(inpKey);
      entry.total += 1;
      if (!comparisonRowIsMatched(r)) entry.failed += 1;
      if (entry.rowInput == null && r.row_input && typeof r.row_input === 'object') entry.rowInput = r.row_input;
      if (gtKey !== null) entry.gtNums.add(gtKey);
    }
    if (gtKey !== null && !gtMap.has(gtKey)) {
      const raw = r.ground_truth_output && typeof r.ground_truth_output === 'object' ? r.ground_truth_output : null;
      if (raw) {
        const gto = Object.fromEntries(
          Object.entries(raw).filter(([k]) => {
            const key = String(k || '').trim();
            if (!key || key === '#' || key === '[#]') return false;
            if (key.length >= 2 && key.startsWith('[') && key.endsWith(']')) return false;
            return true;
          }),
        );
        if (Object.keys(gto).length > 0) gtMap.set(gtKey, gto);
      }
    }
  }

  const inputBlocksHtml = inputMap.size > 0
    ? [...inputMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([idx, { rowInput, total, failed, gtNums }]) => {
          const failBadge = failed > 0
            ? ` <span class="review-debug-fail-badge">${escapeHtml(String(failed))}/${escapeHtml(String(total))} failed</span>`
            : ` <span class="review-debug-pass-badge">passed</span>`;
          const gtLabel = gtNums.size > 0
            ? [...gtNums].sort((a, b) => a - b).map((n) => `Ground truth #${n}`).join(', ')
            : null;
          const gtLine = gtLabel
            ? `<p class="review-suggestion-debug-gt-link">${escapeHtml(gtLabel)}</p>`
            : '';
          return `<section class="review-suggestion-debug-section">
            <h3 class="review-suggestion-debug-section-title">Input #${escapeHtml(String(idx + 1))}${failBadge}</h3>
            ${gtLine}
            ${kvHtml(rowInput)}
          </section>`;
        })
        .join('')
    : '<p class="review-diagnosis-detail-prose review-diagnosis-detail-empty">No input data.</p>';

  const gtBlocksHtml = gtMap.size > 0
    ? [...gtMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([scoreNum, gto]) =>
          `<section class="review-suggestion-debug-section">
            <h3 class="review-suggestion-debug-section-title">Ground truth #${escapeHtml(String(scoreNum))}</h3>
            ${kvHtml(gto)}
          </section>`)
        .join('')
    : '<p class="review-diagnosis-detail-prose review-diagnosis-detail-empty">No ground truth data.</p>';

  const totalFailed = comparisonRows.filter((r) => !comparisonRowIsMatched(r)).length;
  const inputsFailed = [...inputMap.values()].filter((e) => e.failed > 0).length;

  const summaryHtml = `
    <table class="review-suggestion-debug-table">
      <tbody>
        <tr><th scope="row">Score lines</th><td>${escapeHtml(String(comparisonRows.length))}${totalFailed > 0 ? ` <span class="review-debug-fail-badge">${escapeHtml(String(totalFailed))} failed</span>` : ''}</td></tr>
        <tr><th scope="row">Inputs</th><td>${escapeHtml(String(inputMap.size))}${inputsFailed > 0 ? ` <span class="review-debug-fail-badge">${escapeHtml(String(inputsFailed))} with failures</span>` : ''}</td></tr>
        <tr><th scope="row">Ground truth rows</th><td>${escapeHtml(String(gtMap.size))}</td></tr>
      </tbody>
    </table>`;

  const bodyHtml = summaryHtml +
    `<h2 class="review-suggestion-debug-group-title">Input</h2>${inputBlocksHtml}` +
    `<h2 class="review-suggestion-debug-group-title">Ground truth</h2>${gtBlocksHtml}`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'review-selection-preview-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--review-diagnosis-detail" role="dialog">
      <div class="modal-header">
        <h2 id="review-selection-preview-title" class="modal-title">Debug: Review rows</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body review-diagnosis-detail-body review-suggestion-debug-body">
        ${bodyHtml}
      </div>
    </div>
  `;

  function close() {
    overlay.remove();
    if (!document.querySelector('.modal-overlay')) document.body.style.overflow = '';
  }

  overlay.querySelector('.modal-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}

/**
 * Start review API (POST 202). Polling and event processing done by workflowCanvas.
 * @param {{ reviewNodeId: string, payload: object, credentialId: string, registerPendingReview?: (nodeId: string, reviewId: string) => void }} options
 */
export async function runReviewStart({ reviewNodeId, payload, credentialId, registerPendingReview }) {
  const comparisonRows = payload.comparison_rows || [];
  const allRowsMatched = comparisonRows.length === 0 || comparisonRows.every((r) => comparisonRowIsMatched(r));
  const body = {
    credential_id: credentialId,
    review_session_id: reviewNodeId,
    prompt_sections: payload.prompt_sections,
    run_results: payload.run_results || [],
    output_fields: payload.output_fields || [],
    output_schema: payload.output_schema || undefined,
    ...(payload.output_schema ? {} : { output_return_shape: payload.output_return_shape || 'single' }),
    all_rows_matched: allRowsMatched,
    comparison_rows: comparisonRows.map((r) => ({
      row_index: r.row_index,
      input_row_index: typeof r.input_row_index === 'number' && !Number.isNaN(r.input_row_index) ? r.input_row_index : null,
      matched: comparisonRowIsMatched(r),
      run_output: r.run_output || {},
      expected: r.expected || '',
      ground_truth_output: r.ground_truth_output && typeof r.ground_truth_output === 'object' ? r.ground_truth_output : {},
      comparison_types: r.comparison_types ?? null,
      row_input: r.row_input ?? null,
      gt_only: r.gt_only === true,
      source_gt_row_index: typeof r.source_gt_row_index === 'number' && !Number.isNaN(r.source_gt_row_index) ? r.source_gt_row_index : null,
      score_table_row: typeof r.score_table_row === 'number' && !Number.isNaN(r.score_table_row) ? r.score_table_row : null,
    })),
  };
  const promptFullText = payload.prompt_full_text || (payload.prompt_sections || []).map((s) => `## ${(s.name || '').trim() || '(unnamed)'}\n\n${(s.content || '').trim()}`).join('\n\n');
  const sectionsCopy = (Array.isArray(payload.prompt_sections) && payload.prompt_sections.length > 0)
    ? payload.prompt_sections.map((s) => ({ name: String(s?.name ?? ''), content: String(s?.content ?? '').slice() }))
    : [];
  const workingSectionsInitial = sectionsCopy.map((s) => ({ name: s.name || '', content: (s.content || '').slice() }));
  document.dispatchEvent(new CustomEvent('workflow:review-progress', { detail: { reviewNodeId, percent: 0 } }));
  document.dispatchEvent(new CustomEvent('workflow:save-review-result', {
    detail: {
      reviewNodeId,
      data: {
        summary: '',
        suggestions: [],
        data_refinement: [],
        row_diagnostics: [],
        promptSections: sectionsCopy,
        promptFullText: promptFullText || '',
        workingSections: workingSectionsInitial,
        reviewProgress: 0,
        run_results: body.run_results || [],
        comparison_rows: body.comparison_rows || [],
      },
    },
  }));
  document.dispatchEvent(new CustomEvent('workflow:review-stream-started', { detail: { reviewNodeId } }));
  try {
    const res = await fetch(`${API_BASE}/api/review/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      document.dispatchEvent(new CustomEvent('workflow:review-stream-ended', { detail: { reviewNodeId } }));
      alert(res.statusText || 'Review request failed.');
      return;
    }
    const data = await res.json().catch(() => ({}));
    const reviewId = data.review_id;
    if (reviewId && typeof registerPendingReview === 'function') {
      registerPendingReview(reviewNodeId, reviewId);
    }
  } catch (e) {
    document.dispatchEvent(new CustomEvent('workflow:review-stream-ended', { detail: { reviewNodeId } }));
    alert(e?.message || 'Review request failed.');
  }
}

export function openScoreDetailModal({ node, getWorkingSets, getRunResultColumns, getGroundTruthHeaders, getRunResults, getRunWorkingSetContent, getGroundTruthContent, getReviewPayload, autoTriggerReview, getScoreMappingsFromCanvas, getRunInputColsCollapsed, setRunInputColsCollapsed, getScoreOutputColsCollapsed, setScoreOutputColsCollapsed, getScoreGtColsCollapsed, setScoreGtColsCollapsed }) {
  getWorkingSets = getWorkingSets || (() => []);
  getRunResultColumns = getRunResultColumns || (() => []);
  getGroundTruthHeaders = getGroundTruthHeaders || (() => []);
  getRunResults = getRunResults || (() => ({ results: [], outputFields: [] }));
  getRunWorkingSetContent = getRunWorkingSetContent || (() => ({ headers: [], rows: [] }));
  getGroundTruthContent = getGroundTruthContent || (() => ({ headers: [], rows: [] }));
  getReviewPayload = getReviewPayload || (() => null);
  autoTriggerReview = !!autoTriggerReview;

  const workingSets = getWorkingSets();

  const name = (node?.querySelector?.('.workflow-node__title')?.textContent?.trim()) || 'Score';
  const title = `Score: ${name}`;

  /** Populated before pairing when any rule uses embedding similarity (local backend FastEmbed). */
  let scoreEmbeddingCosineMap = new Map();

  let selectedNodeId = (node?.dataset?.scoreGroundTruthId || '').trim();

  /** Tree node: { type: 'group', ops: string[], children: Node[] } | { type: 'rule', ... }. ops[i] = operator between children[i] and children[i+1]. */
  function normalizeToRules(arr) {
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
            ...DEFAULT_MATCH_FLAGS,
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
        matchFlags: { ...DEFAULT_MATCH_FLAGS, contains: r.anyContains },
      }));
  }

  /** Parse stored value: array (legacy) -> tree root; keep tree (groups allowed). */
  function ensureGroupOps(data, children) {
    const n = (children || []).length;
    const len = Math.max(0, n - 1);
    if (Array.isArray(data.ops) && data.ops.length >= len) {
      return data.ops.slice(0, len).map((o) => o === 'OR' ? 'OR' : 'AND');
    }
    const defaultOp = data.op === 'OR' ? 'OR' : 'AND';
    return Array(len).fill(defaultOp);
  }

  function normalizeGroupChild(c) {
    const children = (c.children || []).map((ch) => (ch && ch.type === 'group') ? normalizeGroupChild(ch) : normalizeChild(ch));
    const ops = ensureGroupOps(c, children);
    const out = { type: 'group', ops, children };
    if (typeof c.groupId === 'number' && Number.isInteger(c.groupId) && c.groupId > 0) out.groupId = c.groupId;
    return out;
  }

  function normalizeChild(c) {
    if (!c || c.type === 'rule') {
      const rawMt = (c && c.matchType) || 'exact';
      const f = { ...DEFAULT_MATCH_FLAGS, ...((c && c.matchFlags && typeof c.matchFlags === 'object') ? c.matchFlags : {}) };
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
    return normalizeGroupChild(c);
  }

  /**
   * Which top-level rules panel is active: 'rules' (Input/Output → Ground truth) | 'code' (custom code).
   * Persisted on `node.dataset.scoreActiveMatchMode` so Review (built outside this modal, in
   * workflowCanvas.js's buildReviewComparisonRows) knows which results to send.
   */
  let activePanelMode = (node?.dataset?.scoreActiveMatchMode === 'code') ? 'code' : 'rules';

  function loadBundle() {
    return parseScoreMappingBundle(node?.dataset?.scoreMapping || '{}');
  }

  /**
   * @param {{ clearOutputOnInputShrink?: boolean }} [opts] - If true (user edited Input tree): when input leaf count
   *   decreases, clear all Output → GT rules. GT header filter / open-modal sanitize must not pass this.
   */
  function persistBundle(inputRoot, outputRoot, opts) {
    if (!node) return;
    const clearOutputOnInputShrink = opts && opts.clearOutputOnInputShrink === true;
    let out = outputRoot;
    const nextInCount = flattenScoreRules(inputRoot || emptyScoreRuleGroup()).length;
    if (nextInCount === 0) {
      out = emptyScoreRuleGroup();
    } else if (clearOutputOnInputShrink) {
      const prev = parseScoreMappingBundle(node.dataset.scoreMapping || '{}');
      const prevInCount = flattenScoreRules(prev.inputRoot || emptyScoreRuleGroup()).length;
      if (prevInCount > nextInCount) {
        out = emptyScoreRuleGroup();
      }
    }
    node.dataset.scoreMapping = serializeScoreMappingBundle(inputRoot, out);
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  }

  /** At least one Input → GT leaf rule (required before editing Output → GT). */
  function hasScoreInputRules() {
    const { inputRoot } = loadBundle();
    return flattenScoreRules(inputRoot || emptyScoreRuleGroup()).length > 0;
  }

  /** @param {'input'|'output'} side */
  function getRootForSide(side) {
    const { inputRoot, outputRoot } = loadBundle();
    return side === 'input' ? inputRoot : outputRoot;
  }

  /** @param {'input'|'output'} side */
  function setRootForSide(side, newRoot) {
    const { inputRoot, outputRoot } = loadBundle();
    if (side === 'input') {
      persistBundle(newRoot, outputRoot, { clearOutputOnInputShrink: true });
    } else {
      persistBundle(inputRoot, newRoot);
    }
  }

  /** Flatten tree to array of rules (depth-first) for results table and rule cards by path. */
  function collectRulesFlat(root, path = []) {
    if (!root) return [];
    if (root.type === 'rule') return [{ rule: root, path: path.slice() }];
    if (root.type === 'group' && Array.isArray(root.children)) {
      const out = [];
      root.children.forEach((ch, i) => {
        out.push(...collectRulesFlat(ch, path.concat(i)));
      });
      return out;
    }
    return [];
  }

  /** Get flat list of rules from both input and output trees (results table columns, dedupe). */
  function getRulesFlat() {
    const { inputRoot, outputRoot } = loadBundle();
    return [
      ...collectRulesFlat(inputRoot).map((x) => x.rule),
      ...collectRulesFlat(outputRoot).map((x) => x.rule),
    ];
  }

  /** Collect group subtree for memory (preserves ops + nested rules/groups). */
  function collectGroupForMemory(group) {
    if (!group || group.type !== 'group' || !Array.isArray(group.children)) return null;
    const children = group.children.map((ch) => {
      if (ch.type === 'rule') {
        const leaf = {
          type: 'rule',
          outputKey: (ch.outputKey || '').trim(),
          gtColumns: (ch.gtColumns || []).slice(),
          matchType: migrateLegacyMatchType(ch.matchType || 'exact'),
          matchFlags: getMatchFlags(ch),
        };
        return leaf;
      }
      return collectGroupForMemory(ch);
    }).filter(Boolean);
    if (children.length === 0) return null;
    return { ops: (group.ops || []).slice(0, Math.max(0, children.length - 1)), children };
  }

  if (getScoreMappingsFromCanvas) {
    ruleEditorMemoryOrdered.length = 0;
    Object.keys(ruleEditorMemory).forEach((k) => delete ruleEditorMemory[k]);
    (getScoreMappingsFromCanvas() || []).forEach((raw) => {
      try {
        const rawStr = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
        const { inputRoot, outputRoot } = parseScoreMappingBundle(rawStr);
        [inputRoot, outputRoot].forEach((root, treeIdx) => {
          const scoreMemorySide = treeIdx === 0 ? 'input' : 'output';
          if (!root || root.type !== 'group' || !Array.isArray(root.children)) return;
          root.children.forEach((ch) => {
            if (ch.type === 'rule') {
              const outputKey = (ch.outputKey || '').trim();
              const flags = getMatchFlags(ch);
              const gtCols = (ch.gtColumns || []).map((c) => String(c || '').trim()).filter(Boolean);
              if (outputKey && gtCols.length > 0) {
                ruleEditorMemoryOrdered.push({ type: 'rule', scoreMemorySide, outputKey, gtColumns: gtCols, matchType: migrateLegacyMatchType(ch.matchType || 'exact'), matchFlags: { ...flags } });
                gtCols.forEach((g) => { ruleEditorMemory[outputKey + '\t' + g] = { matchType: migrateLegacyMatchType(ch.matchType || 'exact'), matchFlags: { ...flags } }; });
              }
            } else if (ch.type === 'group') {
              const collected = collectGroupForMemory(ch);
              if (collected) ruleEditorMemoryOrdered.push({ type: 'group', scoreMemorySide, ...collected });
            }
          });
        });
      } catch (_) {}
    });
  }

  /** Stringify value for strict comparison. */
  function toCompareStr(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) return v.map((x) => toCompareStr(x)).join(', ').trim();
    return String(v).trim();
  }

  /**
   * 取 run 某行的值。rowIndex = row_index（结果行号）。
   * Bracket [col] 用 input_row_index 取输入行，1 input → 多 output 时多行共享同一 input。
   */
  function getRunValue(runResult, outputKey, rowIndex, runWs, outputFields) {
    if (outputKey === '#' || outputKey === '[#]') return toCompareStr(rowIndex);
    const keyStr = String(outputKey || '').trim();
    if (!keyStr) return '';
    const isBracket = keyStr.startsWith('[') && keyStr.endsWith(']');
    if (isBracket) {
      const header = keyStr.slice(1, -1).trim();
      const rows = runWs.rows || [];
      const headers = runWs.headers || [];
      const colIdx = headers.findIndex((h) => String(h).trim() === header);
      const inputRowIdx = runResult?.input_row_index ?? rowIndex;
      if (colIdx >= 0 && rows[inputRowIdx]) return toCompareStr(rows[inputRowIdx][colIdx]);
      return '';
    }
    if (runResult && runResult.output && typeof runResult.output === 'object' && keyStr in runResult.output) {
      return toCompareStr(runResult.output[keyStr]);
    }
    if (runResult && runResult.error) return toCompareStr(runResult.error);
    return '';
  }

  /** Get GT cell value for row i and column name. */
  function getGtValue(gtContent, rowIndex, columnName) {
    if (String(columnName).trim() === SCORE_GT_ROW_INDEX_COLUMN) {
      if (typeof rowIndex !== 'number' || rowIndex < 0) return '';
      return toCompareStr(rowIndex);
    }
    const headers = gtContent.headers || [];
    const rows = gtContent.rows || [];
    const colIdx = headers.findIndex((h) => String(h).trim() === String(columnName).trim());
    if (colIdx >= 0 && rows[rowIndex]) return toCompareStr(rows[rowIndex][colIdx]);
    return '';
  }

  /** Table/search display: synthetic GT row column shows 1-based index (same as fixed “Ground truth: #” column). */
  function getGtValueForDisplay(gtContent, rowIndex, columnName) {
    if (String(columnName).trim() === SCORE_GT_ROW_INDEX_COLUMN) {
      if (typeof rowIndex !== 'number' || rowIndex < 0) return '';
      return String(rowIndex + 1);
    }
    return getGtValue(gtContent, rowIndex, columnName);
  }

  /**
   * Evaluate a single rule: run value vs GT column value(s) by matchType and matchFlags.
   */
  function ruleMatchesRow(rule, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent) {
    const runResult = resultsByIndex.get(runRowIndex) || null;
    const runValRaw = getRunValue(runResult, rule.outputKey, runRowIndex, runWs, outputFields);
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
      return gtValsRaw.some((g) => embeddingPairMatches(runValRaw, g, scoreEmbeddingCosineMap));
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

  /**
   * Evaluate tree node for run row i vs GT row j.
   */
  function evaluateNode(node, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent) {
    if (!node) return false;
    if (node.type === 'rule') {
      return ruleMatchesRow(node, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent);
    }
    if (node.type === 'group' && Array.isArray(node.children)) {
      if (node.children.length === 0) return false;
      const ops = node.ops || Array(Math.max(0, node.children.length - 1)).fill('AND');
      let r = evaluateNode(node.children[0], runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent);
      for (let i = 1; i < node.children.length; i++) {
        const next = evaluateNode(node.children[i], runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent);
        r = (ops[i - 1] === 'OR') ? (r || next) : (r && next);
      }
      return r;
    }
    return false;
  }

  /**
   * 贪心配对 run 与 GT（实现见 scoreRunGtPairing.js）。
   */
  function computeMatchPerRow(inputRoot, outputRoot, results, outputFields, runWs, gtContent) {
    return computeGreedyRunToGtPairing({
      inputRoot,
      outputRoot,
      results,
      runWs,
      gtContent,
      outputFields,
      ruleMatchesRow,
      getRunValue,
    });
  }

  /** Get node at path (array of child indices from root). Root = []. */
  function getNodeAtPath(root, path) {
    let cur = root;
    for (const i of path) {
      if (!cur || cur.type !== 'group' || !Array.isArray(cur.children)) return null;
      cur = cur.children[i];
    }
    return cur;
  }

  /** Clone tree and set node at path; returns new root. */
  function setNodeAtPath(root, path, newNode) {
    if (path.length === 0) return newNode;
    const [i, ...rest] = path;
    const group = root.type === 'group' && root.children ? { ...root, children: root.children.slice() } : root;
    group.children[i] = setNodeAtPath(group.children[i], rest, newNode);
    return group;
  }

  /** Clone tree and remove node at path (remove child at path's last index). Returns new root. */
  function removeNodeAtPath(root, path) {
    if (path.length === 0) return root;
    if (path.length === 1) {
      const k = path[0];
      const group = root.type === 'group' && root.children ? { ...root, children: root.children.filter((_, idx) => idx !== k) } : root;
      const ops = (root.ops || []).slice();
      if (ops.length > 0) ops.splice(k === 0 ? 0 : k - 1, 1);
      return { ...group, ops };
    }
    const [i, ...rest] = path;
    const group = root.type === 'group' && root.children ? { ...root, children: root.children.slice() } : root;
    group.children[i] = removeNodeAtPath(group.children[i], rest);
    return group;
  }

  /** Remove rules whose gtColumns include any column not in the selected GT headers. Returns new root. */
  function filterRootByGtHeaders(root, gtSet) {
    if (!root) return null;
    if (root.type === 'rule') {
      const cols = root.gtColumns || [];
      const allIn = cols.length > 0 && cols.every((c) => {
        const s = String(c || '').trim();
        return s === SCORE_GT_ROW_INDEX_COLUMN || gtSet.has(s);
      });
      return allIn ? root : null;
    }
    if (root.type === 'group' && Array.isArray(root.children)) {
      const filtered = root.children.map((ch) => filterRootByGtHeaders(ch, gtSet)).filter((x) => x != null);
      const ops = (root.ops || []).slice(0, Math.max(0, filtered.length - 1));
      const out = { type: 'group', ops, children: filtered };
      if (typeof root.groupId === 'number' && Number.isInteger(root.groupId) && root.groupId > 0) {
        out.groupId = root.groupId;
      }
      return out;
    }
    return null;
  }

  /** Insert child at path (path points to parent group). Returns new root. */
  function insertChildAtPath(root, path, newChild, index) {
    if (path.length === 0) {
      const group = root.type === 'group' ? { ...root, children: (root.children || []).slice(), ops: (root.ops || []).slice() } : { type: 'group', ops: [], children: [] };
      group.children.splice(index, 0, newChild);
      group.ops.splice(index, 0, 'AND');
      return group;
    }
    const [i, ...rest] = path;
    const group = root.type === 'group' && root.children ? { ...root, children: root.children.slice() } : root;
    group.children[i] = insertChildAtPath(group.children[i], rest, newChild, index);
    return group;
  }

  /** Keys: GT row `String(j)` or run-only `run:${rowIndex}`. Value true = excluded from Review + metrics. */
  function getScoreRowExcludedFromScoring() {
    try {
      const raw = node?.dataset?.scoreRowExcludedFromScoring || '{}';
      const o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : {};
    } catch (_) {
      return {};
    }
  }

  function setScoreRowExcludedFromScoring(excluded) {
    if (!node) return;
    node.dataset.scoreRowExcludedFromScoring = JSON.stringify(excluded);
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  }

  function isScoreRowExcludedFromScoring(rowKey) {
    return !!(getScoreRowExcludedFromScoring()[rowKey]);
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'score-detail-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--score-detail" id="score-detail-panel">
      <div class="modal-header">
        <h2 id="score-detail-title" class="modal-title">${escapeHtml(title)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body score-detail-body modal-body--score">
        <div class="score-detail-main">
          <p class="run-detail-main-label score-detail-main-label">Scoring setup</p>
          <div class="dataset-meta-wrap score-detail-meta-wrap">
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="score-detail-gt-picker">Ground truth dataset</label>
              <div class="run-detail-ws-picker" id="score-detail-gt-picker" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-label="Select ground truth dataset">
                <div class="run-detail-ws-trigger" tabindex="0">
                  <span class="run-detail-ws-trigger-color" id="score-detail-gt-trigger-color"></span>
                  <span class="run-detail-ws-trigger-text" id="score-detail-gt-trigger-text">${escapeHtml(selectPlaceholderLabel('Select ground truth dataset'))}</span>
                  <span class="run-detail-ws-trigger-arrow" aria-hidden="true">⌵</span>
                </div>
                <div class="run-detail-ws-dropdown" id="score-detail-gt-dropdown" role="listbox" hidden></div>
              </div>
            </div>
            <div class="dataset-meta-field score-detail-rules-section" id="score-detail-rules-section" hidden>
              <span class="dataset-meta-label run-detail-section-label score-detail-rules-label">Set matching method</span>
              <div class="review-detail-view-switch score-detail-rules-view-switch" role="tablist" aria-label="Set rules: matching rules or custom code">
                <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab review-detail-tab--active score-detail-rules-tab" role="tab" aria-selected="true" data-rules-tab="rules">Match by rules</button>
                <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab score-detail-rules-tab" role="tab" aria-selected="false" data-rules-tab="code">Match by code</button>
              </div>
              <div class="score-detail-rules-scroll" id="score-detail-rules-panel-rules">
                <p class="score-detail-rules-hint">A row counts as a match only if every rule below is satisfied.</p>
                <div id="score-detail-rules-list" class="score-detail-rules-list"></div>
              </div>
              <div class="score-detail-rules-scroll score-detail-rules-code-panel" id="score-detail-rules-panel-code" hidden>
                <div class="process-editor-mid">
                  <div class="process-editor-host" id="score-detail-code-host"></div>
                  <p class="process-editor-hint">Runs once per candidate (run row, ground-truth row) pair, using the Python interpreter set in Settings → Python, until each run row finds a match (in order; matched ground-truth rows aren't reused). <code>input_row</code>, <code>output_row</code>, and <code>gt_row</code> are dicts keyed by column name. Return a truthy value to count the pair as a match.</p>
                  <div class="score-detail-code-results" id="score-detail-code-results"></div>
                </div>
                <div class="dataset-meta-field run-detail-model-actions-field">
                  <div class="run-detail-llm-actions-row">
                    <span class="run-detail-llm-actions-lead" aria-hidden="true"></span>
                    <div class="run-detail-llm-actions-right">
                      <button type="button" class="btn btn-secondary run-detail-run-btn score-detail-code-run-btn">Run</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="score-detail-preview-wrap">
          <h3 class="run-detail-preview-title score-detail-preview-title">Results</h3>
          <div class="score-detail-preview-content">
            <div class="score-detail-results-card run-detail-results-card" id="score-detail-results-card">
              <div id="score-detail-results-body" class="score-detail-results-body-inner"></div>
              <div id="score-detail-results-toolbar" class="dataset-detail-preview-toolbar score-detail-results-toolbar" style="display: none;"></div>
              <div class="score-detail-results-footer-row" id="score-detail-results-footer-row" hidden>
                <button type="button" class="btn btn-secondary score-detail-save-to-workspace" id="score-detail-save-to-workspace" title="Save comparison table as a new dataset in workspace">Save to workspace</button>
                <div class="score-detail-results-footer-right">
                  <div class="score-detail-llm-row">
                    <select id="score-detail-llm-select" class="credentials-select score-detail-llm-select" aria-label="Select model"></select>
                  </div>
                  <button type="button" class="btn btn-primary score-detail-add-prompt-review" id="score-detail-add-prompt-review" title="Create a Review node and run analysis with the selected model">Review</button>
                  <button type="button" class="btn btn-secondary score-detail-review-payload-preview" id="score-detail-review-payload-preview" title="Temporary: preview Review payload by input (model output vs ground-truth tables per group). Does not start a Review job.">Debug</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const pickerEl = overlay.querySelector('#score-detail-gt-picker');
  const triggerEl = overlay.querySelector('.run-detail-ws-trigger');
  const triggerColorEl = overlay.querySelector('#score-detail-gt-trigger-color');
  const triggerTextEl = overlay.querySelector('#score-detail-gt-trigger-text');
  const dropdownEl = overlay.querySelector('#score-detail-gt-dropdown');
  const rulesListEl = overlay.querySelector('#score-detail-rules-list');
  const rulesSectionEl = overlay.querySelector('#score-detail-rules-section');
  const rulesTabBar = overlay.querySelector('.score-detail-rules-view-switch');
  const rulesPanelRulesEl = overlay.querySelector('#score-detail-rules-panel-rules');
  const rulesPanelCodeEl = overlay.querySelector('#score-detail-rules-panel-code');
  const codeHostEl = overlay.querySelector('#score-detail-code-host');
  const codeResultsEl = overlay.querySelector('#score-detail-code-results');
  const codeRunBtn = overlay.querySelector('.score-detail-code-run-btn');
  const llmSelect = overlay.querySelector('#score-detail-llm-select');
  const saveToWorkspaceBtn = overlay.querySelector('#score-detail-save-to-workspace');
  const addPromptReviewBtn = overlay.querySelector('#score-detail-add-prompt-review');
  const reviewPayloadPreviewBtn = overlay.querySelector('#score-detail-review-payload-preview');
  const resultsBody = overlay.querySelector('#score-detail-results-body');
  const resultsToolbar = overlay.querySelector('#score-detail-results-toolbar');
  const resultsFooterRowEl = overlay.querySelector('#score-detail-results-footer-row');
  const resultsFooterRightEl = overlay.querySelector('.score-detail-results-footer-right');

  const scoreDetailPagination = {
    rowsPerPage: 25,
    currentPage: 1,
    searchQuery: '',
    rulesColumnFilter: node?.dataset?.scoreTableRulesColumnFilter === '1',
  };

  function syncRulesSectionVisibility() {
    if (!rulesSectionEl) return;
    if (selectedNodeId) rulesSectionEl.removeAttribute('hidden');
    else rulesSectionEl.setAttribute('hidden', '');
  }

  function syncScoreResultsFooterVisibility() {
    if (resultsFooterRightEl) resultsFooterRightEl.hidden = false;
    if (!resultsFooterRowEl) return;
    const show = activePanelMode === 'code'
      ? !!(selectedNodeId && lastCodeMatchResult)
      : !!(selectedNodeId && hasScoreInputRules());
    if (show) resultsFooterRowEl.removeAttribute('hidden');
    else resultsFooterRowEl.setAttribute('hidden', '');
  }

  function syncRulesTabUi() {
    if (rulesTabBar) {
      rulesTabBar.querySelectorAll('[data-rules-tab]').forEach((btn) => {
        const on = btn.getAttribute('data-rules-tab') === activePanelMode;
        btn.classList.toggle('review-detail-tab--active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    if (rulesPanelRulesEl) rulesPanelRulesEl.hidden = activePanelMode !== 'rules';
    if (rulesPanelCodeEl) rulesPanelCodeEl.hidden = activePanelMode !== 'code';
  }

  rulesTabBar?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rules-tab]');
    if (!btn) return;
    const tab = btn.getAttribute('data-rules-tab');
    if (tab !== 'rules' && tab !== 'code') return;
    activePanelMode = tab;
    if (node?.dataset) node.dataset.scoreActiveMatchMode = tab;
    syncRulesTabUi();
    void renderResults();
  });

  const matchCodeSaved = node?.dataset?.scoreMatchCode;
  const matchCodeInitial = (() => {
    if (matchCodeSaved != null && matchCodeSaved !== '') return matchCodeSaved;
    try {
      const runWs0 = getRunWorkingSetContent();
      const { outputFields: outputFields0 } = getRunResults();
      const gtHeaders0 = selectedNodeId ? getGroundTruthHeaders(selectedNodeId) : [];
      const outKeys0 = (outputFields0 || []).map((f) => f?.key || f?.display || '').filter(Boolean);
      return buildMatchDefaultCode(runWs0.headers, outKeys0, gtHeaders0);
    } catch (_) {
      return MATCH_CODE_FALLBACK;
    }
  })();

  const codeEditorView = codeHostEl ? new EditorView({
    doc: matchCodeInitial,
    extensions: [basicSetup, python()],
    parent: codeHostEl,
  }) : null;

  function getMatchCode() {
    return codeEditorView ? codeEditorView.state.doc.toString() : '';
  }

  let codeRunning = false;
  let codeCancelled = false;
  let codeCurrentJobId = null;

  function setCodeRunningUi(isRunning) {
    codeRunning = isRunning;
    if (!codeRunBtn) return;
    codeRunBtn.textContent = isRunning ? 'Running, click to stop' : 'Run';
    codeRunBtn.classList.toggle('btn-danger', isRunning);
  }

  const codeMatchProgressBar = node?.querySelector?.('.workflow-node__score-progress') || null;
  function setCodeMatchNodeProgress(completed, total) {
    if (!codeMatchProgressBar) return;
    const pct = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    codeMatchProgressBar.style.width = pct + '%';
  }

  function showCodeResultsPlaceholder(text) {
    if (!codeResultsEl) return;
    codeResultsEl.innerHTML = text ? `<p class="run-detail-placeholder">${escapeHtml(text)}</p>` : '';
  }

  /** Last completed "Match by code" run; consumed by {@link renderResults} (via {@link buildCodeMatchRunToGt}) and the "Save to workspace" export. */
  let lastCodeMatchResult = (() => {
    try {
      const raw = node?.dataset?.scoreMatchResult;
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  })();

  function persistLastCodeMatchResult() {
    if (!node?.dataset) return;
    if (lastCodeMatchResult) node.dataset.scoreMatchResult = JSON.stringify(lastCodeMatchResult);
    else delete node.dataset.scoreMatchResult;
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  }

  /** Raw {headers, rows} for a code-match run -- shared by the results table and the "Save to workspace" export. */
  function buildCodeMatchTableData(result) {
    const { runRowIndices, outcomes, runRows, gtRows } = result;
    const inputCols = [];
    const outputCols = [];
    runRows.forEach((r) => {
      Object.keys(r.input_row || {}).forEach((k) => { if (!inputCols.includes(k)) inputCols.push(k); });
      Object.keys(r.output_row || {}).forEach((k) => { if (!outputCols.includes(k)) outputCols.push(k); });
    });
    const gtCols = [];
    gtRows.forEach((r) => Object.keys(r.gt_row || {}).forEach((k) => { if (!gtCols.includes(k)) gtCols.push(k); }));

    const headers = [
      'Run row',
      ...inputCols.map((c) => `Input: ${c}`),
      ...outputCols.map((c) => `Output: ${c}`),
      'Matched GT row',
      ...gtCols.map((c) => `GT: ${c}`),
      'Status',
    ];
    const rows = outcomes.map((outcome, i) => {
      const runRowLabel = String((runRowIndices[i] ?? i) + 1);
      const runRow = runRows[i] || { input_row: {}, output_row: {} };
      const inputVals = inputCols.map((c) => runRow.input_row?.[c] ?? '');
      const outputVals = outputCols.map((c) => runRow.output_row?.[c] ?? '');
      if (!outcome.ok) {
        return [runRowLabel, ...inputVals, ...outputVals, '', ...gtCols.map(() => ''), `Error: ${outcome.error || 'Unknown error'}`];
      }
      const matched = typeof outcome.matched_gt_index === 'number';
      const gtRowDict = matched ? (gtRows[outcome.matched_gt_index]?.gt_row || {}) : null;
      const gtVals = gtCols.map((c) => (matched ? (gtRowDict?.[c] ?? '') : ''));
      return [runRowLabel, ...inputVals, ...outputVals, matched ? String(outcome.matched_gt_index + 1) : '', ...gtVals, matched ? 'Matched' : 'No match'];
    });
    return { headers, rows, inputColsCount: inputCols.length, outputColsCount: outputCols.length };
  }


  async function pollCodeMatchJob(jobId, total, runRowIndices, runRows, gtRows) {
    if (codeCurrentJobId !== jobId) return;
    let data;
    try {
      const res = await fetch(`${API_BASE}/api/score/match/run/result/${jobId}`);
      data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) throw new Error(data.detail || 'Failed to fetch results');
    } catch (e) {
      if (codeCurrentJobId !== jobId) return;
      setCodeRunningUi(false);
      showCodeResultsPlaceholder((e && e.message) || 'Network error while checking progress.');
      return;
    }
    if (codeCurrentJobId !== jobId) return;
    const total2 = data.total || total;
    if (data.status === 'running') {
      setCodeMatchNodeProgress(data.completed || 0, total2);
      setTimeout(() => pollCodeMatchJob(jobId, total, runRowIndices, runRows, gtRows), MATCH_CODE_POLL_INTERVAL_MS);
      return;
    }
    setCodeMatchNodeProgress((data.results || []).length, total2);
    setCodeRunningUi(false);
    if (data.error) {
      showCodeResultsPlaceholder(data.error);
      return;
    }
    showCodeResultsPlaceholder('');
    lastCodeMatchResult = {
      runRowIndices,
      outcomes: data.results || [],
      gtRowCount: gtRows.length,
      runRows,
      gtRows,
      wasCancelled: data.status === 'cancelled' || codeCancelled,
    };
    persistLastCodeMatchResult();
    void renderResults();
  }

  async function startCodeMatchRun() {
    if (!selectedNodeId) {
      showCodeResultsPlaceholder('Select a ground truth dataset first.');
      return;
    }
    const runWs = getRunWorkingSetContent();
    const { results: rawResults, outputFields } = getRunResults();
    const gtContent = getGroundTruthContent(selectedNodeId);
    const results = (rawResults || []).filter((r) => isValidRunOutputForScoreRow(r, outputFields));
    if (results.length === 0) {
      showCodeResultsPlaceholder('No run results to match.');
      return;
    }
    if ((gtContent.rows || []).length === 0) {
      showCodeResultsPlaceholder('Ground truth dataset has no rows.');
      return;
    }

    let pythonPath = '';
    try {
      const res = await fetch(`${API_BASE}/api/settings`);
      const settings = res.ok ? await res.json() : null;
      pythonPath = (settings?.python_path || '').trim();
    } catch (_) { /* handled by the empty-path check below */ }
    if (!pythonPath) {
      showCodeResultsPlaceholder('Set a Python interpreter path in Settings → Python first.');
      return;
    }

    const runRowIndices = results.map((r) => r.row_index);
    const runRowsPayload = results.map((r) => ({
      input_row: buildMatchRunRowInputDict(r, runWs),
      output_row: buildMatchRunRowOutputDict(r),
    }));
    const gtRowsPayload = (gtContent.rows || []).map((_, j) => ({ gt_row: buildMatchGtRowDict(gtContent, j) }));

    codeCancelled = false;
    setCodeRunningUi(true);
    setCodeMatchNodeProgress(0, runRowsPayload.length);
    showCodeResultsPlaceholder('');

    try {
      const res = await fetch(`${API_BASE}/api/score/match/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ python_path: pythonPath, code: getMatchCode(), run_rows: runRowsPayload, gt_rows: gtRowsPayload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCodeRunningUi(false);
        showCodeResultsPlaceholder(typeof data.detail === 'string' ? data.detail : 'Failed to start.');
        return;
      }
      codeCurrentJobId = data.job_id;
    } catch (e) {
      setCodeRunningUi(false);
      showCodeResultsPlaceholder((e && e.message) || 'Network error.');
      return;
    }

    pollCodeMatchJob(codeCurrentJobId, runRowsPayload.length, runRowIndices, runRowsPayload, gtRowsPayload);
  }

  codeRunBtn?.addEventListener('click', () => {
    if (codeRunning) {
      codeCancelled = true;
      if (codeCurrentJobId) {
        fetch(`${API_BASE}/api/score/match/run/cancel/${codeCurrentJobId}`, { method: 'POST' }).catch(() => {});
      }
      return;
    }
    startCodeMatchRun();
  });

  function getSelectedWorkingSet() {
    return workingSets.find((ws) => ws.nodeId === selectedNodeId) || null;
  }

  function updateScoreNodeBorder() {
    const ws = getSelectedWorkingSet();
    if (node && node.style) {
      node.style.borderColor = ws && ws.color ? ws.color : '';
      const bar = node.querySelector('.workflow-node__score-progress');
      if (bar) bar.style.background = ws && ws.color ? ws.color : '';
    }
  }

  function updateTriggerDisplay() {
    const ws = getSelectedWorkingSet();
    if (ws) {
      triggerColorEl.style.background = ws.color || 'transparent';
      triggerColorEl.style.display = ws.color ? '' : 'none';
      triggerTextEl.textContent = ws.name || 'Dataset';
    } else {
      triggerColorEl.style.background = '';
      triggerColorEl.style.display = 'none';
      triggerTextEl.textContent = selectPlaceholderLabel('Select ground truth dataset');
    }
  }

  function closeDropdown() {
    dropdownEl.hidden = true;
    pickerEl.setAttribute('aria-expanded', 'false');
  }

  function openDropdown() {
    dropdownEl.hidden = false;
    pickerEl.setAttribute('aria-expanded', 'true');
  }

  /** Open Add rule / Edit rule modal. side = 'input' | 'output': the rule's current tree (or the nominal side for a fresh top-level add). editPath = path to rule (edit), or null for add. When add: parentPath + indexInParent. Top-level rules (editPath.length === 1, or parentPath is empty) may pick a column from either side — the actual tree is derived from the column chosen. */
   function openRuleEditor(side, editPath, parentPath, indexInParent, onDone) {
    const isEdit = Array.isArray(editPath) && editPath.length > 0;
    const isTopLevel = isEdit ? editPath.length === 1 : (!parentPath || parentPath.length === 0);
    const root = getRootForSide(side);
    const defaultRule = { type: 'rule', outputKey: '', gtColumns: [], matchType: 'exact', matchFlags: { ...DEFAULT_MATCH_FLAGS } };
    const rule = isEdit ? getNodeAtPath(root, editPath) : defaultRule;
    let ruleData = rule && rule.type === 'rule' ? rule : defaultRule;
    const runWsEd = getRunWorkingSetContent();
    /** Input row-index uses '[#]' here (distinct from output's bare '#') so a merged top-level list has no key collision. */
    function buildInputColumns() {
      const headers = runWsEd.headers || [];
      return [
        { key: '[#]', label: 'Input: #', side: 'input' },
        ...headers.map((h) => ({ key: `[${String(h).trim()}]`, label: `Input: ${String(h ?? '').trim() || ' '}`, side: 'input' })),
      ];
    }
    function buildOutputColumns() {
      const raw = (getRunResultColumns() || []).filter((c) => !isScoreInputSideRuleKey(c.key));
      return [
        { key: '#', label: formatResultOutputColumnLabel('#'), side: 'output' },
        ...raw.map((c) => ({ ...c, side: 'output' })),
      ];
    }
    let runColumns;
    if (isTopLevel) {
      runColumns = [...buildInputColumns(), ...buildOutputColumns()];
    } else if (side === 'input') {
      const headers = runWsEd.headers || [];
      runColumns = [
        { key: '#', label: 'Input: #', side: 'input' },
        ...headers.map((h) => ({ key: `[${String(h).trim()}]`, label: `Input: ${String(h ?? '').trim() || ' '}`, side: 'input' })),
      ];
    } else {
      runColumns = buildOutputColumns();
    }
    /** Column key → side, used to route a saved rule to the right tree (isScoreInputSideRuleKey('#') is ambiguous by itself). */
    const columnSideByKey = new Map((runColumns || []).map((c) => [c.key, c.side || side]));
    const gtHeaders = getGroundTruthHeaders(selectedNodeId);
    if (!isEdit && (!(ruleData.outputKey || '').trim() || !(ruleData.gtColumns || []).length)) {
      const runKeys = new Set((runColumns || []).map((c) => (c.key || '').trim()).filter(Boolean));
      const gtSet = new Set([...(gtHeaders || []), SCORE_GT_ROW_INDEX_COLUMN]);
      for (const key of Object.keys(ruleEditorMemory)) {
        const idx = key.indexOf('\t');
        if (idx <= 0) continue;
        const outputKey = key.slice(0, idx);
        const gtColumn = key.slice(idx + 1);
        if (!isTopLevel) {
          if (side === 'input' && !isScoreInputSideRuleKey(outputKey)) continue;
          if (side === 'output' && isScoreInputSideRuleKey(outputKey) && outputKey !== '#') continue;
        }
        if (runKeys.has(outputKey) && gtSet.has(gtColumn)) {
          const mem = ruleEditorMemory[key];
          const memMt = (mem && mem.matchType) || 'exact';
          const memFlags = (mem && mem.matchFlags && typeof mem.matchFlags === 'object') ? { ...DEFAULT_MATCH_FLAGS, ...mem.matchFlags } : { ...DEFAULT_MATCH_FLAGS };
          if (legacyMatchTypeWasContains(memMt)) memFlags.contains = true;
          ruleData = {
            type: 'rule',
            outputKey,
            gtColumns: [gtColumn],
            matchType: migrateLegacyMatchType(memMt),
            matchFlags: memFlags,
          };
          break;
        }
      }
    }
    const flags = getMatchFlags(ruleData);
    let resultColumnKeyForSelect = String(ruleData.outputKey || '').trim();
    if (isTopLevel) {
      if (side === 'input' && resultColumnKeyForSelect === '#') resultColumnKeyForSelect = '[#]';
    } else if (side === 'input' && resultColumnKeyForSelect === '[#]') {
      resultColumnKeyForSelect = '#';
    }
    const resultSelectOpts = runColumns.map((c) => {
      const label = (c.label || '').trim() || c.key || '—';
      const key = c.key || '';
      const sel = key === resultColumnKeyForSelect ? ' selected' : '';
      return `<option value="${escapeAttr(key)}"${sel}>${escapeHtml(label)}</option>`;
    }).join('');
    const matchSelectOpts = MATCH_TYPES.map((m) => {
      const sel = (m.value || '') === (ruleData.matchType || '') ? ' selected' : '';
      return `<option value="${escapeAttr(m.value)}"${sel}>${escapeHtml(m.label || m.value)}</option>`;
    }).join('');
    const numericModeOpts = NUMERIC_COMPARE_MODES.map((m) => {
      const sel = (m.value || '') === flags.numericMode ? ' selected' : '';
      return `<option value="${escapeAttr(m.value)}"${sel}>${escapeHtml(m.label || m.value)}</option>`;
    }).join('');
    const currentGtColumn = (ruleData.gtColumns && ruleData.gtColumns[0]) ? ruleData.gtColumns[0] : '';
    const defaultGtColumn = currentGtColumn || SCORE_GT_ROW_INDEX_COLUMN;
    const gtSelectOptsList = [
      { value: SCORE_GT_ROW_INDEX_COLUMN, label: formatScoreGroundTruthColumnLabel(SCORE_GT_ROW_INDEX_COLUMN) },
      ...(gtHeaders || []).map((h) => ({ value: h, label: formatScoreGroundTruthColumnLabel(h) })),
    ];
    const gtSelectOpts = gtSelectOptsList.map((o) => {
      const sel = o.value === defaultGtColumn ? ' selected' : '';
      return `<option value="${escapeAttr(o.value)}"${sel}>${escapeHtml(o.label)}</option>`;
    }).join('');
    const gtSelectEmptyOpt = '';

    const runFieldLabel = isTopLevel ? 'Column' : (side === 'input' ? 'Input column' : 'Model output column');
    const runFieldAria = isTopLevel
      ? 'Column: an input column/row index, or a model output field/row index'
      : (side === 'input'
        ? 'Run input column: row index or a dataset input column'
        : 'Model output column');
    const epsGapLabel = isTopLevel
      ? 'ε: max absolute gap (selected column vs ground truth)'
      : (side === 'input'
        ? 'ε: max absolute gap (run side vs ground truth)'
        : 'ε: max absolute gap (output vs ground truth)');
    const epsHintInequality = isTopLevel
      ? '|selected value − ground truth| ≤ ε'
      : (side === 'input'
        ? '|run side value − ground truth| ≤ ε'
        : '|output − ground truth| ≤ ε');

    const editorOverlay = document.createElement('div');
    editorOverlay.className = 'modal-overlay modal-overlay--section-editor modal-overlay--rule-editor';
    editorOverlay.setAttribute('aria-modal', 'true');
    editorOverlay.innerHTML = `
      <div class="modal-panel modal-panel--section-editor modal-panel--rule-editor">
        <div class="modal-header">
          <h3 class="modal-title">${isEdit ? 'Edit rule' : 'Add rule'}</h3>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <div class="dataset-meta-wrap">
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="rule-editor-result-column">${escapeHtml(runFieldLabel)}</label>
              <select id="rule-editor-result-column" class="dataset-meta-input rule-editor-select" aria-label="${escapeAttr(runFieldAria)}">${resultSelectOpts}</select>
            </div>
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="rule-editor-gt-column">Ground truth column</label>
              <select id="rule-editor-gt-column" class="dataset-meta-input rule-editor-select" aria-label="Ground truth column">
                ${gtSelectEmptyOpt}${gtSelectOpts}
              </select>
            </div>
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="rule-editor-match-type">Comparison type</label>
              <select id="rule-editor-match-type" class="dataset-meta-input rule-editor-select" aria-label="Comparison type">${matchSelectOpts}</select>
            </div>
            <div class="dataset-meta-field rule-editor-flags-wrap" id="rule-editor-flags-wrap">
              <span class="dataset-meta-label">String match options</span>
              <div class="rule-editor-flags" id="rule-editor-flags-inner" role="group" aria-label="String match options">
                ${MATCH_FLAGS.map((f) => `<label class="rule-editor-flag-label"><input type="checkbox" class="rule-editor-flag-cb" data-flag="${escapeAttr(f.key)}" ${flags[f.key] ? 'checked' : ''} aria-label="${escapeAttr(f.label)}" />${escapeHtml(f.label)}</label>`).join('')}
                <label class="rule-editor-flag-label"><input type="checkbox" id="rule-editor-fuzzy-bigram-cb" class="rule-editor-flag-cb rule-editor-fuzzy-bigram-cb" ${flags.semanticAlign ? 'checked' : ''} aria-label="Fuzzy text match using character bigrams (Dice), not embeddings" />Fuzzy text</label>
                <label class="rule-editor-flag-label"><input type="checkbox" id="rule-editor-embedding-similarity-cb" class="rule-editor-flag-cb rule-editor-embedding-similarity-cb" ${flags.embeddingSimilarity ? 'checked' : ''} aria-label="Semantic match using local fast embedding model (MiniLM via backend)" />Semantic</label>
              </div>
            </div>
            <div class="dataset-meta-field rule-editor-numeric-wrap" id="rule-editor-numeric-wrap" style="display:none;">
              <label class="dataset-meta-label" for="rule-editor-numeric-mode">Number comparison</label>
              <select id="rule-editor-numeric-mode" class="dataset-meta-input rule-editor-select" aria-label="How numbers are compared">${numericModeOpts}</select>
              <div class="rule-editor-numeric-param" id="rule-editor-numeric-abs-wrap" style="display:none;margin-top:0.5rem;">
                <label class="dataset-meta-label" for="rule-editor-numeric-abs">${escapeHtml(epsGapLabel)}</label>
                <input type="text" id="rule-editor-numeric-abs" class="dataset-meta-input" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="e.g. 0.01 or 1e-3" value="${escapeAttr(String(flags.numericAbsEpsilon))}" aria-describedby="rule-editor-numeric-abs-hint" aria-label="Absolute tolerance epsilon" />
                <p class="rule-editor-hint" id="rule-editor-numeric-abs-hint">Rows match when <strong>${escapeHtml(epsHintInequality)}</strong>. Use any decimal (e.g. <code>0.05</code>, <code>0.001</code>). ε = 0 means exact numeric equality.</p>
              </div>
              <div class="rule-editor-numeric-param" id="rule-editor-numeric-rel-wrap" style="display:none;margin-top:0.5rem;">
                <label class="dataset-meta-label" for="rule-editor-numeric-rel">r: relative tolerance (e.g. 0.01 ≈ 1%)</label>
                <input type="text" id="rule-editor-numeric-rel" class="dataset-meta-input" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="e.g. 0.01 (1%)" value="${escapeAttr(String(flags.numericRelEpsilon))}" aria-describedby="rule-editor-numeric-rel-hint" aria-label="Relative tolerance" />
                <p class="rule-editor-hint" id="rule-editor-numeric-rel-hint">Rows match when <strong>|a - b| ≤ r × max(|a|, |b|)</strong>. Example: <code>0.01</code> ≈ 1% relative difference.</p>
              </div>
              <div class="rule-editor-numeric-param" id="rule-editor-numeric-dec-wrap" style="display:none;margin-top:0.5rem;">
                <label class="dataset-meta-label" for="rule-editor-numeric-dec">N: round both sides to this many decimals (0-20)</label>
                <input type="number" id="rule-editor-numeric-dec" class="dataset-meta-input" min="0" max="20" step="1" value="${escapeAttr(String(flags.numericDecimalPlaces))}" aria-label="Decimal places" />
              </div>
            </div>
          </div>
          <div class="prompt-form-error section-editor-error rule-editor-error" role="alert" aria-live="polite" hidden></div>
          ${!isEdit ? `
          <div class="modal-footer-actions">
            <button type="button" class="btn btn-secondary section-editor-save rule-editor-save">Add rule</button>
          </div>
          ` : ''}
        </div>
      </div>
    `;

    const resultSelectEl = editorOverlay.querySelector('#rule-editor-result-column');
    const matchSelectEl = editorOverlay.querySelector('#rule-editor-match-type');
    const gtSelectEl = editorOverlay.querySelector('#rule-editor-gt-column');
    const errorEl = editorOverlay.querySelector('.rule-editor-error');

    function closeEditor() {
      editorOverlay.remove();
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

    const numericModeEl = editorOverlay.querySelector('#rule-editor-numeric-mode');
    const numericAbsWrap = editorOverlay.querySelector('#rule-editor-numeric-abs-wrap');
    const numericRelWrap = editorOverlay.querySelector('#rule-editor-numeric-rel-wrap');
    const numericDecWrap = editorOverlay.querySelector('#rule-editor-numeric-dec-wrap');
    const numericAbsEl = editorOverlay.querySelector('#rule-editor-numeric-abs');
    const numericRelEl = editorOverlay.querySelector('#rule-editor-numeric-rel');
    const numericDecEl = editorOverlay.querySelector('#rule-editor-numeric-dec');

    function updateNumericParamVisibility() {
      const mode = (numericModeEl?.value ?? 'exact').trim();
      if (numericAbsWrap) numericAbsWrap.style.display = mode === 'abs' ? '' : 'none';
      if (numericRelWrap) numericRelWrap.style.display = mode === 'rel' ? '' : 'none';
      if (numericDecWrap) numericDecWrap.style.display = mode === 'decimals' ? '' : 'none';
    }

    /** Only disable string options when comparison type is numeric; mutual exclusivity is by unchecking, not by disabling. */
    function syncStringModeFlagInputsDisabled() {
      const showStr = ((matchSelectEl?.value ?? '').trim() || 'exact') === 'exact';
      const fuzzyCb = editorOverlay.querySelector('#rule-editor-fuzzy-bigram-cb');
      const embedCb = editorOverlay.querySelector('#rule-editor-embedding-similarity-cb');
      if (fuzzyCb) fuzzyCb.disabled = !showStr;
      if (embedCb) embedCb.disabled = !showStr;
      editorOverlay.querySelectorAll('.rule-editor-flag-cb[data-flag]').forEach((cb) => {
        cb.disabled = !showStr;
      });
    }
    function updateComparisonTypePanels() {
      const v = (matchSelectEl?.value ?? '').trim() || 'exact';
      const flagsWrap = editorOverlay.querySelector('#rule-editor-flags-wrap');
      const numWrap = editorOverlay.querySelector('#rule-editor-numeric-wrap');
      const showStr = v === 'exact';
      const showNum = v === 'numeric';
      if (flagsWrap) flagsWrap.style.display = showStr ? '' : 'none';
      if (numWrap) numWrap.style.display = showNum ? '' : 'none';
      syncStringModeFlagInputsDisabled();
      if (showNum) updateNumericParamVisibility();
    }
    matchSelectEl.addEventListener('change', () => {
      updateComparisonTypePanels();
      clearError();
      if (isEdit) persistEdit();
    });
    numericModeEl?.addEventListener('change', () => {
      updateNumericParamVisibility();
      clearError();
      if (isEdit) persistEdit();
    });
    updateComparisonTypePanels();
    requestAnimationFrame(() => updateComparisonTypePanels());

    const fuzzyBigramCbEl = editorOverlay.querySelector('#rule-editor-fuzzy-bigram-cb');
    const embeddingSimilarityCbEl = editorOverlay.querySelector('#rule-editor-embedding-similarity-cb');
    fuzzyBigramCbEl?.addEventListener('change', () => {
      if (fuzzyBigramCbEl.checked) {
        if (embeddingSimilarityCbEl) embeddingSimilarityCbEl.checked = false;
        editorOverlay.querySelectorAll('.rule-editor-flag-cb[data-flag]').forEach((fc) => { fc.checked = false; });
      }
      clearError();
      if (isEdit) persistEdit();
    });
    embeddingSimilarityCbEl?.addEventListener('change', () => {
      if (embeddingSimilarityCbEl.checked) {
        if (fuzzyBigramCbEl) fuzzyBigramCbEl.checked = false;
        editorOverlay.querySelectorAll('.rule-editor-flag-cb[data-flag]').forEach((fc) => { fc.checked = false; });
      }
      clearError();
      if (isEdit) persistEdit();
    });
    editorOverlay.querySelectorAll('.rule-editor-flag-cb[data-flag]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (fuzzyBigramCbEl) fuzzyBigramCbEl.checked = false;
          if (embeddingSimilarityCbEl) embeddingSimilarityCbEl.checked = false;
        }
        clearError();
        if (isEdit) persistEdit();
      });
    });

    function buildNewRuleFromForm() {
      const outputKey = (resultSelectEl?.value ?? '').trim();
      if (!outputKey) {
        showError(isTopLevel
          ? 'Please select a column.'
          : (side === 'input' ? 'Please select an input column.' : 'Please select a model output column.'));
        return null;
      }
      const gtColumn = (gtSelectEl?.value ?? '').trim();
      if (!gtColumn) {
        showError('Please select a ground truth column.');
        return null;
      }
      const matchType = (matchSelectEl?.value ?? '').trim() || 'exact';
      const flagCbs = editorOverlay.querySelectorAll('.rule-editor-flag-cb[data-flag]');
      const matchFlags = { ...DEFAULT_MATCH_FLAGS };
      const fuzzyCb = editorOverlay.querySelector('#rule-editor-fuzzy-bigram-cb');
      const embedCb = editorOverlay.querySelector('#rule-editor-embedding-similarity-cb');
      matchFlags.semanticAlign = matchType === 'exact' && !!(fuzzyCb && fuzzyCb.checked);
      matchFlags.embeddingSimilarity = matchType === 'exact' && !!(embedCb && embedCb.checked);
      flagCbs.forEach((cb) => {
        const key = cb.getAttribute('data-flag');
        if (key && (key === 'contains' || key === 'ignoreCase' || key === 'ignoreSymbols' || key === 'ignoreWhitespace')) matchFlags[key] = !!cb.checked;
      });
      if (matchType === 'numeric') {
        const nm = (numericModeEl?.value ?? 'exact').trim();
        matchFlags.numericMode = ['exact', 'abs', 'rel', 'decimals'].includes(nm) ? nm : 'exact';
        const absParsed = parseFlexibleNonNegativeNumber(numericAbsEl?.value);
        const relParsed = parseFlexibleNonNegativeNumber(numericRelEl?.value);
        const decParsed = parseInt(String(numericDecEl?.value ?? '').trim(), 10);
        matchFlags.numericAbsEpsilon = Number.isFinite(absParsed) && absParsed >= 0 ? absParsed : 0;
        matchFlags.numericRelEpsilon = Number.isFinite(relParsed) && relParsed >= 0 ? relParsed : 0;
        if (Number.isFinite(decParsed)) matchFlags.numericDecimalPlaces = Math.max(0, Math.min(20, decParsed));
        else matchFlags.numericDecimalPlaces = 2;
        if (matchFlags.numericMode === 'abs' && (!Number.isFinite(absParsed) || absParsed < 0)) {
          showError('Enter a valid ε (≥ 0). Decimals allowed, e.g. 0.01 or 1e-4.');
          return null;
        }
        if (matchFlags.numericMode === 'rel' && (!Number.isFinite(relParsed) || relParsed < 0)) {
          showError('Enter a valid r (≥ 0). Decimals allowed, e.g. 0.01 for ~1%.');
          return null;
        }
        if (matchFlags.numericMode === 'decimals' && !Number.isFinite(decParsed)) {
          showError('Enter decimal places (0-20).');
          return null;
        }
      } else {
        matchFlags.numericMode = 'exact';
        matchFlags.numericAbsEpsilon = 0;
        matchFlags.numericRelEpsilon = 0;
        matchFlags.numericDecimalPlaces = 2;
      }
      const newRule = { type: 'rule', outputKey, gtColumns: [gtColumn], matchType, matchFlags: canonicalizeMatchFlags(matchFlags) };
      return newRule;
    }

    function persistEdit() {
      if (!isEdit) return;
      const newRule = buildNewRuleFromForm();
      if (!newRule) return;
      clearError();
      const actualSide = columnSideByKey.get(newRule.outputKey) || side;
      if (!isTopLevel || actualSide === side) {
        setRootForSide(side, setNodeAtPath(getRootForSide(side), editPath, newRule));
      } else {
        // Top-level rule's column moved to the other tree: pull it out of `side`'s tree, append to `actualSide`'s.
        const oldRoot = removeNodeAtPath(getRootForSide(side), editPath);
        const newRootTarget = getRootForSide(actualSide);
        const appended = insertChildAtPath(newRootTarget, [], newRule, (newRootTarget.children || []).length);
        if (side === 'input') persistBundle(oldRoot, appended);
        else persistBundle(appended, oldRoot);
        side = actualSide;
        editPath = [(getRootForSide(actualSide).children || []).length - 1];
      }
      onDone();
    }

    function persistAdd() {
      if (isEdit) return;
      const newRule = buildNewRuleFromForm();
      if (!newRule) return;
      clearError();
      const actualSide = columnSideByKey.get(newRule.outputKey) || side;
      const nextRoot = getRootForSide(actualSide);
      const targetIndex = isTopLevel ? (nextRoot.children || []).length : indexInParent;
      setRootForSide(actualSide, insertChildAtPath(nextRoot, parentPath, newRule, targetIndex));
      closeEditor();
      onDone();
    }

    let editApplyTimer = null;
    function schedulePersistEdit() {
      if (!isEdit) return;
      if (editApplyTimer) clearTimeout(editApplyTimer);
      editApplyTimer = setTimeout(() => {
        editApplyTimer = null;
        persistEdit();
      }, 200);
    }

    resultSelectEl.addEventListener('change', () => {
      clearError();
      if (isEdit) persistEdit();
    });
    gtSelectEl.addEventListener('change', () => {
      clearError();
      if (isEdit) persistEdit();
    });

    numericAbsEl?.addEventListener('input', () => { if (isEdit) schedulePersistEdit(); });
    numericRelEl?.addEventListener('input', () => { if (isEdit) schedulePersistEdit(); });
    numericDecEl?.addEventListener('input', () => { if (isEdit) schedulePersistEdit(); });
    numericAbsEl?.addEventListener('blur', () => { if (isEdit) persistEdit(); });
    numericRelEl?.addEventListener('blur', () => { if (isEdit) persistEdit(); });
    numericDecEl?.addEventListener('blur', () => { if (isEdit) persistEdit(); });

    editorOverlay.querySelector('.modal-close').addEventListener('click', closeEditor);
    const ruleEditorSaveBtn = editorOverlay.querySelector('.rule-editor-save');
    if (ruleEditorSaveBtn) ruleEditorSaveBtn.addEventListener('click', persistAdd);
    document.body.appendChild(editorOverlay);
    resultSelectEl?.focus();
  }

  /** Run-side label for rule summary: input rules must not match `getRunResultColumns()`’s first `#` (run row #). */
  function formatScoreRuleRunSideLabel(side, rule) {
    const key = String(rule?.outputKey ?? '').trim();
    if (!key) return '—';
    if (key === '#') {
      return side === 'input' ? 'Input: #' : formatResultOutputColumnLabel('#');
    }
    if (isScoreInputSideRuleKey(key)) {
      if (key === '[#]') return 'Input: #';
      const inner = key.length >= 2 && key.startsWith('[') && key.endsWith(']') ? key.slice(1, -1) : '';
      return `Input: ${String(inner).trim() || ' '}`;
    }
    const runColumns = getRunResultColumns();
    const col = runColumns.find((c) => c.key === key);
    return (col && col.label) ? String(col.label).trim() || key : (formatResultOutputColumnLabel(key) || key);
  }

  /** Rule card: optional static "AND" connector on left (opValue/opIndex), then click to edit, × to delete. */
  function createRuleCard(side, rule, path, opts = {}) {
    const runLabel = formatScoreRuleRunSideLabel(side, rule);
    const gtLabel = (rule.gtColumns || []).length === 0 ? '—' : (rule.gtColumns || []).map((c) => formatScoreGroundTruthColumnLabel(c)).join(', ');
    const mt = migrateLegacyMatchType(rule.matchType);
    const typeLabel = MATCH_TYPES.find((m) => m.value === mt)?.label || 'String match';
    const flags = getMatchFlags(rule);
    let flagPart = '';
    if (mt === 'exact' && flags.embeddingSimilarity) {
      flagPart = ' · Semantic';
    } else if (mt === 'exact' && flags.semanticAlign) {
      flagPart = ' · Fuzzy text';
    } else {
      const flagLabels = MATCH_FLAGS.filter((f) => flags[f.key]).map((f) => f.label);
      flagPart = flagLabels.length > 0 ? ` · ${flagLabels.join(', ')}` : '';
    }
    if (mt === 'numeric' && flags.numericMode && flags.numericMode !== 'exact') {
      if (flags.numericMode === 'abs') flagPart += ` · abs ε≤${flags.numericAbsEpsilon}`;
      else if (flags.numericMode === 'rel') flagPart += ` · rel≤${flags.numericRelEpsilon}`;
      else if (flags.numericMode === 'decimals') flagPart += ` · ${flags.numericDecimalPlaces} decimals`;
    }
    const summary = `${runLabel} → ${gtLabel} ( ${typeLabel}${flagPart} )`;
    const card = document.createElement('div');
    card.className = 'score-rule-card';
    const onRuleSaved = opts.onRuleSaved || (() => renderRules());
    const openEditor = () => openRuleEditor(side, path, [], 0, onRuleSaved);
    card.innerHTML = `
      <div class="score-rule-card-inner" tabindex="0" role="button" title="${escapeAttr(summary)}">
        <span class="score-rule-card-summary" title="${escapeAttr(summary)}">${escapeHtml(summary)}</span>
      </div>
      <button type="button" class="score-rule-card-remove" aria-label="Remove rule">×</button>
    `;
    const inner = card.querySelector('.score-rule-card-inner');
    const removeBtn = card.querySelector('.score-rule-card-remove');
    inner.addEventListener('click', openEditor);
    inner.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEditor();
      }
    });
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setRootForSide(side, removeNodeAtPath(getRootForSide(side), path));
      renderRules();
      if (opts.onAfterChange) opts.onAfterChange();
    });
    return card;
  }

  /** Group card: label uses stable persisted {@link groupId} (order-independent). */
  function createGroupCard(side, path, groupNode, opts = {}) {
    const gid = typeof groupNode.groupId === 'number' && Number.isInteger(groupNode.groupId) && groupNode.groupId > 0
      ? groupNode.groupId
      : '?';
    const label = `Rule group ${gid}`;
    const card = document.createElement('div');
    card.className = 'score-rule-card score-rule-card--group';
    const openGroupEditor = () => openGroupEditorModal(side, path, () => renderRules());
    card.innerHTML = `
      <div class="score-rule-card-inner" tabindex="0" role="button">
        <span class="score-rule-card-summary">${escapeHtml(label)}</span>
      </div>
      <button type="button" class="score-rule-card-remove" aria-label="Remove group">×</button>
    `;
    const inner = card.querySelector('.score-rule-card-inner');
    const removeBtn = card.querySelector('.score-rule-card-remove');
    inner.addEventListener('click', openGroupEditor);
    inner.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openGroupEditor();
      }
    });
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setRootForSide(side, removeNodeAtPath(getRootForSide(side), path));
      renderRules();
    });
    return card;
  }

  /** Modal to edit a group's rules (same UI as score rules list). */
  function openGroupEditorModal(side, groupPath, onDone) {
    const root = getRootForSide(side);
    const group = getNodeAtPath(root, groupPath);
    if (!group || group.type !== 'group') return;
    const gid = typeof group.groupId === 'number' && Number.isInteger(group.groupId) && group.groupId > 0
      ? group.groupId
      : '?';
    const title = `Edit Rule group ${gid}`;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay modal-overlay--section-editor modal-overlay--rule-editor';
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="modal-panel modal-panel--section-editor modal-panel--rule-editor modal-panel--group-editor">
        <div class="modal-header">
          <h3 class="modal-title">${escapeHtml(title)}</h3>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body modal-body--group-editor">
          <div class="score-group-editor-list" id="score-group-editor-list"></div>
          <div class="score-group-editor-actions">
            <button type="button" class="score-tree-add-rule-box" id="score-group-editor-add-rule">+ Add rule</button>
          </div>
        </div>
      </div>
    `;
    const listEl = overlay.querySelector('#score-group-editor-list');
    const addBtn = overlay.querySelector('#score-group-editor-add-rule');

    function getGroup() {
      return getNodeAtPath(getRootForSide(side), groupPath) || { type: 'group', ops: [], children: [] };
    }

    function setGroup(newGroup) {
      setRootForSide(side, setNodeAtPath(getRootForSide(side), groupPath, newGroup));
      renderGroupEditorList();
    }

    function renderGroupEditorList() {
      listEl.innerHTML = '';
      const g = getGroup();
      const children = (g.children || []).slice();
      children.forEach((node, i) => {
        if (node.type === 'rule') {
          const row = document.createElement('div');
          row.className = 'score-tree-row score-tree-row--flat';
          const cardWrap = document.createElement('div');
          cardWrap.className = 'score-tree-row-card';
          const pathI = groupPath.concat(i);
          const cardOpts = {
            onAfterChange: () => {
              renderGroupEditorList();
              document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
            },
            onRuleSaved: () => {
              renderGroupEditorList();
              renderRules();
              document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
            },
          };
          cardWrap.appendChild(createRuleCard(side, node, pathI, cardOpts));
          row.appendChild(cardWrap);
          listEl.appendChild(row);
        }
      });
    }

    addBtn.addEventListener('click', () => {
      openRuleEditor(side, null, groupPath, (getGroup().children || []).length, () => {
        renderGroupEditorList();
        renderRules();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      });
    });

    overlay.querySelector('.modal-close').addEventListener('click', () => {
      overlay.remove();
      onDone();
    });
    renderGroupEditorList();
    document.body.appendChild(overlay);
  }

  function renderRules() {
    syncRulesTabUi();
    syncScoreResultsFooterVisibility();
    rulesListEl.innerHTML = '';

    if (!selectedNodeId) {
      void renderResults();
      return;
    }
    const runColumns = getRunResultColumns();
    const gtHeaders = getGroundTruthHeaders(selectedNodeId);
    if (runColumns.length === 0 || gtHeaders.length === 0) {
      void renderResults();
      return;
    }

    const treeWrap = document.createElement('div');
    treeWrap.className = 'score-rules-tree score-rules-tree--flat';

    ['input', 'output'].forEach((side) => {
      const root = getRootForSide(side);
      const children = (root.type === 'group' && Array.isArray(root.children)) ? root.children : [];
      children.forEach((childNode, i) => {
        const row = document.createElement('div');
        row.className = 'score-tree-row score-tree-row--flat';
        const cardWrap = document.createElement('div');
        cardWrap.className = 'score-tree-row-card';
        const card = childNode.type === 'group'
          ? createGroupCard(side, [i], childNode)
          : createRuleCard(side, childNode, [i]);
        cardWrap.appendChild(card);
        row.appendChild(cardWrap);
        treeWrap.appendChild(row);
      });
    });

    const addRow = document.createElement('div');
    addRow.className = 'score-tree-add-row score-tree-row--flat';
    const addBox = document.createElement('button');
    addBox.type = 'button';
    addBox.className = 'score-tree-add-rule-box';
    addBox.setAttribute('aria-label', 'Add rule');
    addBox.textContent = '+ Add rule';
    addBox.addEventListener('click', () => {
      const r = getRootForSide('input');
      openRuleEditor('input', null, [], (r.children || []).length, () => renderRules());
    });
    const addCardWrap = document.createElement('div');
    addCardWrap.className = 'score-tree-row-card';
    addCardWrap.appendChild(addBox);
    addRow.appendChild(addCardWrap);
    treeWrap.appendChild(addRow);

    rulesListEl.appendChild(treeWrap);
    void renderResults();
  }

  async function renderResults() {
    if (!resultsBody) return;
    const isCodeMode = activePanelMode === 'code';
    syncScoreResultsFooterVisibility();
    const prevScrollEl = resultsBody.querySelector('.score-detail-results-table-scroll');
    const savedScrollTop = prevScrollEl?.scrollTop ?? 0;
    const savedScrollLeft = prevScrollEl?.scrollLeft ?? 0;
    resultsBody.innerHTML = '';
    const { inputRoot, outputRoot } = loadBundle();
    const rulesFlat = isCodeMode ? [] : getRulesFlat();
    if (!selectedNodeId) {
      resultsBody.innerHTML = '<p class="score-detail-placeholder">Select ground truth and add rules to see comparison results.</p>';
      if (resultsToolbar) { resultsToolbar.style.display = 'none'; resultsToolbar.innerHTML = ''; }
      return;
    }
    if (isCodeMode) {
      if (!lastCodeMatchResult) {
        resultsBody.innerHTML = '<p class="score-detail-placeholder">Write match(input_row, output_row, gt_row) code and click Run to see results here.</p>';
        if (resultsToolbar) { resultsToolbar.style.display = 'none'; resultsToolbar.innerHTML = ''; }
        return;
      }
    } else if (rulesFlat.length === 0) {
      resultsBody.innerHTML = '<p class="score-detail-placeholder">Add at least one rule to compare.</p>';
      if (resultsToolbar) { resultsToolbar.style.display = 'none'; resultsToolbar.innerHTML = ''; }
      return;
    }
    const { results: rawResults, outputFields } = getRunResults();
    const runWs = getRunWorkingSetContent();
    const rawGtContent = getGroundTruthContent(selectedNodeId);

    const gtColsUsed = isCodeMode ? (rawGtContent.headers || []).slice() : buildScoreTableGtColumns(rulesFlat, rawGtContent);

    const resultsForScore = (rawResults || []).filter((r) => r);
    const gtContent = rawGtContent;
    const results = resultsForScore.filter((r) => isValidRunOutputForScoreRow(r, outputFields));
    const gtHeaders = gtContent.headers || [];
    const gtRows = gtContent.rows || [];
    const resultsByIndex = new Map();
    (results || []).forEach((r) => { resultsByIndex.set(r.row_index, r); });
    const runRowIndices = [...new Set((results || []).map((r) => r.row_index))];
    const maxRunRow = runRowIndices.length ? Math.max(...runRowIndices) : -1;
    const maxGtRow = gtRows.length ? gtRows.length - 1 : -1;
    const hasAnyRows = maxRunRow >= 0 || maxGtRow >= 0;

    if (!hasAnyRows) {
      resultsBody.innerHTML = '<p class="score-detail-placeholder">No run results and no ground truth rows.</p>';
      if (resultsToolbar) { resultsToolbar.style.display = 'none'; resultsToolbar.innerHTML = ''; }
      return;
    }

    scoreEmbeddingCosineMap = new Map();
    const embeddingWalkRoot = scoreBundleRootsForEmbeddingWalk(inputRoot, outputRoot);
    if (!isCodeMode && rulesFlat.some((r) => getMatchFlags(r).embeddingSimilarity)) {
      try {
        scoreEmbeddingCosineMap = await prefetchEmbeddingCosineMap(API_BASE, {
          root: embeddingWalkRoot,
          results,
          outputFields,
          runWs,
          gtContent,
          getRunValue,
          getGtValue,
        });
      } catch (e) {
        showAlert(String(e?.message || e), { title: 'Embedding comparison failed' });
        scoreEmbeddingCosineMap = new Map();
      }
    }
    let runToGt, runCount;
    if (isCodeMode) {
      runToGt = buildCodeMatchRunToGt(lastCodeMatchResult, gtRows.length);
      runCount = results.length;
    } else {
      ({ runToGt, total: runCount } = computeMatchPerRow(inputRoot, outputRoot, results, outputFields, runWs, gtContent));
    }
    const gtToRun = new Array(gtRows.length).fill(-1);
    for (let i = 0; i < (runToGt || []).length; i++) {
      if (runToGt[i] >= 0) gtToRun[runToGt[i]] = i;
    }

    /** Code mode: pairing IS the match decision (match() already decided), so any assigned pair counts as matched. */
    function treeMatchesPairForRow(rootTree, iRun, jGt) {
      if (isCodeMode) return iRun >= 0 && jGt >= 0 && runToGt[iRun] === jGt;
      const leaves = flattenScoreRules(rootTree || emptyScoreRuleGroup());
      if (leaves.length === 0) return true;
      return evaluateNode(rootTree, iRun, jGt, resultsByIndex, runWs, outputFields, gtContent);
    }
    function isPairMatchForRow(iRun, jGt) {
      if (iRun < 0 || jGt < 0) return false;
      if (isCodeMode) return runToGt[iRun] === jGt;
      if (!treeMatchesPairForRow(inputRoot, iRun, jGt)) return false;
      const outLeaves = flattenScoreRules(outputRoot || emptyScoreRuleGroup());
      if (outLeaves.length === 0) return true;
      return evaluateNode(outputRoot, iRun, jGt, resultsByIndex, runWs, outputFields, gtContent);
    }

    const descriptors = attachInputMatchedUnpairedGtDescriptors(
      buildScoreResultDescriptorsInRunOrder({
        runRowIndices,
        runToGt,
        gtToRun,
        gtRowsLength: gtRows.length,
        evaluateRunMatchesAnyGt: (i) => {
          for (let j = 0; j < gtRows.length; j++) {
            if (treeMatchesPairForRow(inputRoot, i, j) && treeMatchesPairForRow(outputRoot, i, j)) return true;
          }
          return false;
        },
      }),
      {
        runRowIndices,
        runToGt,
        gtToRun,
        inputMatchesPairForRow: (i, jj) => treeMatchesPairForRow(inputRoot, i, jj),
      },
    );

    const q = (scoreDetailPagination.searchQuery || '').trim().toLowerCase();
    const inputHeaders = runWs.headers || [];
    const rulesColumnFilter = !isCodeMode && !!scoreDetailPagination.rulesColumnFilter;
    const inputHeadersForTable = rulesColumnFilter ? filterScoreInputHeadersByRules(rulesFlat, inputHeaders) : inputHeaders;
    const outputFieldsForTable = rulesColumnFilter ? filterScoreOutputFieldsByRules(rulesFlat, outputFields) : outputFields;
    const gtColsDisplayed = rulesColumnFilter ? buildScoreTableGtColumnsRulesOnly(rulesFlat, rawGtContent) : gtColsUsed;
    const hasInputBlock = !rulesColumnFilter || inputHeadersForTable.length > 0;
    const showOutputIndexCol = !rulesColumnFilter || outputFieldsForTable.length > 0 || scoreRulesReferenceRunOutputRowIndex(rulesFlat);
    const hasOutputBlock = !rulesColumnFilter || outputFieldsForTable.length > 0 || scoreRulesReferenceRunOutputRowIndex(rulesFlat);
    const runInputColsCollapsed = typeof getRunInputColsCollapsed === 'function' ? !!getRunInputColsCollapsed() : false;
    const scoreOutputColsCollapsed = typeof getScoreOutputColsCollapsed === 'function' ? !!getScoreOutputColsCollapsed() : false;
    const scoreGtColsCollapsed = typeof getScoreGtColsCollapsed === 'function' ? !!getScoreGtColsCollapsed() : false;
    function pushRunBlockStringsForSearch(parts, runResult, runRowIndex, blankOutputsOnly = false) {
      const ri = runRowIndex;
      if (runInputColsCollapsed) {
        if (hasInputBlock) parts.push('Input ...');
      } else if (hasInputBlock) {
        parts.push(runResult ? String((runResult.input_row_index ?? 0) + 1) : '');
        const inputRow = runResult && Array.isArray(runResult.input_row) ? runResult.input_row : [];
        inputHeadersForTable.forEach((h) => {
          const ci = inputHeaders.findIndex((x) => String(x ?? '').trim() === String(h ?? '').trim());
          parts.push(ci >= 0 && inputRow[ci] != null ? String(inputRow[ci]) : '');
        });
      }
      if (!hasOutputBlock) return;
      if (scoreOutputColsCollapsed) {
        parts.push('Output ...');
        return;
      }
      if (showOutputIndexCol) {
        parts.push(runResult ? String((runResult.row_index ?? ri) + 1) : '—');
      }
      if (blankOutputsOnly) {
        outputFieldsForTable.forEach(() => { parts.push(''); });
      } else if (runResult && runResult.error) {
        outputFieldsForTable.forEach(() => { parts.push(String(runResult.error)); });
      } else {
        outputFieldsForTable.forEach((f) => {
          parts.push(runResult ? getRunValue(runResult, f.key, ri, runWs, outputFields) : '');
        });
      }
    }
    function getRowStringsForSearch(d) {
      const parts = [];
      if (d.type === 'gt') {
        const j = d.j;
        const pairedRun = gtToRun[j];
        const showRunCells = typeof pairedRun === 'number' && pairedRun >= 0;
        const anchorIn = !showRunCells && typeof d.displayRunRowIndex === 'number' && d.displayRunRowIndex >= 0
          ? d.displayRunRowIndex
          : -1;
        const runRowForCells = showRunCells ? pairedRun : anchorIn;
        const runResult = runRowForCells >= 0 ? resultsByIndex.get(runRowForCells) || null : null;
        const blankOutputsOnly = !showRunCells && anchorIn >= 0;
        pushRunBlockStringsForSearch(parts, runResult, runRowForCells, blankOutputsOnly);
        if (scoreGtColsCollapsed) {
          parts.push('Ground truth ...');
        } else {
          parts.push(String(j + 1));
          gtColsDisplayed.forEach((col) => { parts.push(getGtValueForDisplay(gtContent, j, col)); });
        }
        const matchEvalRun = showRunCells
          ? pairedRun
          : (typeof d.displayRunRowIndex === 'number' && d.displayRunRowIndex >= 0 ? d.displayRunRowIndex : -1);
        parts.push(matchEvalRun >= 0 && isPairMatchForRow(matchEvalRun, j) ? 'true' : 'false');
        parts.push(isScoreRowExcludedFromScoring(String(j)) ? 'false' : 'true');
      } else {
        const i = d.i;
        const runResult = resultsByIndex.get(i) || null;
        pushRunBlockStringsForSearch(parts, runResult, i);
        if (scoreGtColsCollapsed) {
          parts.push('Ground truth ...');
        } else {
          parts.push('—');
          gtColsDisplayed.forEach(() => { parts.push('—'); });
        }
        parts.push('false');
        parts.push(isScoreRowExcludedFromScoring(`run:${i}`) ? 'false' : 'true');
      }
      return parts.map((v) => (v === null || v === undefined ? '' : String(v)));
    }
    let filteredDescriptors = descriptors;
    if (q) {
      filteredDescriptors = descriptors.filter((d) => getRowStringsForSearch(d).some((s) => s.toLowerCase().includes(q)));
    }
    const totalUnfiltered = descriptors.length;
    const totalRows = filteredDescriptors.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / scoreDetailPagination.rowsPerPage));
    scoreDetailPagination.currentPage = Math.min(Math.max(1, scoreDetailPagination.currentPage), totalPages);
    const start = (scoreDetailPagination.currentPage - 1) * scoreDetailPagination.rowsPerPage;
    const end = Math.min(start + scoreDetailPagination.rowsPerPage, totalRows);
    const pageDescriptors = filteredDescriptors.slice(start, end);

    const excludedMap = getScoreRowExcludedFromScoring();
    const isGtExcluded = (j) => !!excludedMap[String(j)];
    const isRunOnlyExcluded = (runRowIdx) => !!excludedMap[`run:${runRowIdx}`];
    /** Count run rows with API/runtime errors among rows still included for Review (not excluded from scoring). */
    function errorCountAmongReviewIncluded(excluded) {
      let n = 0;
      for (const r of rawResults || []) {
        if (!r || !r.error) continue;
        const i = r.row_index;
        if (typeof i !== 'number' || Number.isNaN(i) || i < 0) continue;
        const j = i < runToGt.length ? runToGt[i] : -1;
        const rowKey = j >= 0 ? String(j) : `run:${i}`;
        if (!excluded[rowKey]) n++;
      }
      return n;
    }
    const errorRowCount = errorCountAmongReviewIncluded(excludedMap);
    let recallDenom = 0;
    for (let j = 0; j < gtRows.length; j++) {
      if (!isGtExcluded(j)) recallDenom++;
    }
    let tp = 0;
    for (let j = 0; j < gtRows.length; j++) {
      if (isGtExcluded(j)) continue;
      const runRowIndex = gtToRun[j];
      if (runRowIndex >= 0 && isPairMatchForRow(runRowIndex, j)) tp++;
    }
    const allRunRowIndicesForPrec = [...new Set((results || []).map((r) => r.row_index))];
    let precDenom = 0;
    for (const R of allRunRowIndicesForPrec) {
      const j = R >= 0 && R < (runToGt || []).length ? runToGt[R] : -1;
      if (j >= 0) {
        if (!isGtExcluded(j)) precDenom++;
      } else if (!isRunOnlyExcluded(R)) {
        precDenom++;
      }
    }
    const precision = precDenom > 0 ? (tp / precDenom) * 100 : 0;
    const recall = recallDenom > 0 ? (tp / recallDenom) * 100 : 0;
    const f1 = (precision + recall) > 0 ? (2 * (precision / 100) * (recall / 100) / ((precision + recall) / 100)) * 100 : 0;
    const fmt = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');
    const errorNote = errorRowCount > 0 ? ` · ${errorRowCount} row${errorRowCount === 1 ? '' : 's'} with error` : '';
    const metricsText = `Precision ${fmt(precision)}% · Recall ${fmt(recall)}% · F1 ${fmt(f1)}%${errorNote}`;

    const summaryText = `Run result ${runCount} rows · Ground truth ${gtRows.length} rows · ${tp} matched`;

    /** Recompute PR/F1 banner only (Review checkbox toggles); avoids full table rebuild and scroll jump. */
    function refreshScoreMetricsBanner() {
      const excludedMapNow = getScoreRowExcludedFromScoring();
      const isGtEx = (j) => !!excludedMapNow[String(j)];
      const isRunOnlyEx = (runRowIdx) => !!excludedMapNow[`run:${runRowIdx}`];
      let recallD = 0;
      for (let j = 0; j < gtRows.length; j++) {
        if (!isGtEx(j)) recallD++;
      }
      let tpN = 0;
      for (let j = 0; j < gtRows.length; j++) {
        if (isGtEx(j)) continue;
        const runRowIndex = gtToRun[j];
        if (runRowIndex >= 0 && isPairMatchForRow(runRowIndex, j)) tpN++;
      }
      const allRunIdxPrec = [...new Set((results || []).map((r) => r.row_index))];
      let precD = 0;
      for (const R of allRunIdxPrec) {
        const j = R >= 0 && R < (runToGt || []).length ? runToGt[R] : -1;
        if (j >= 0) {
          if (!isGtEx(j)) precD++;
        } else if (!isRunOnlyEx(R)) {
          precD++;
        }
      }
      const prec = precD > 0 ? (tpN / precD) * 100 : 0;
      const rec = recallD > 0 ? (tpN / recallD) * 100 : 0;
      const f1v = (prec + rec) > 0 ? (2 * (prec / 100) * (rec / 100) / ((prec + rec) / 100)) * 100 : 0;
      const errN = errorCountAmongReviewIncluded(excludedMapNow);
      const errNote = errN > 0 ? ` · ${errN} row${errN === 1 ? '' : 's'} with error` : '';
      const mTxt = `Precision ${fmt(prec)}% · Recall ${fmt(rec)}% · F1 ${fmt(f1v)}%${errNote}`;
      const sTxt = `Run result ${runCount} rows · Ground truth ${gtRows.length} rows · ${tpN} matched`;
      const summaryEl = resultsBody.querySelector('.score-detail-results-summary');
      const metricsEl = resultsBody.querySelector('.score-detail-results-metrics');
      if (summaryEl) summaryEl.textContent = sTxt;
      if (metricsEl) metricsEl.textContent = mTxt;
    }

    const topRow = document.createElement('div');
    topRow.className = 'score-detail-results-top-row';
    topRow.innerHTML = `
      <div class="score-detail-results-summary-wrap">
        <span class="score-detail-results-summary">${escapeHtml(summaryText)}</span>
        <span class="score-detail-results-metrics" aria-label="Precision, Recall, F1">${escapeHtml(metricsText)}</span>
      </div>
      <div class="score-detail-results-search-inline">
        ${isCodeMode ? '' : `
        <label class="score-detail-rules-column-filter" title="Hide columns not used in any rule (input, model output, GT). Export still has all columns.">
          Rule columns only
          <input type="checkbox" id="score-detail-rules-column-only" ${scoreDetailPagination.rulesColumnFilter ? 'checked' : ''} aria-label="Table shows only columns referenced in rules" />
        </label>
        `}
        <label class="dataset-detail-search-label" for="score-detail-results-search">Search</label>
        <input type="text" id="score-detail-results-search" class="dataset-detail-input dataset-detail-preview-search-inp" placeholder="Filter rows by cell content..." aria-label="Search in table" value="${escapeAttr(scoreDetailPagination.searchQuery)}" />
      </div>
    `;
    const rulesColumnOnlyCb = topRow.querySelector('#score-detail-rules-column-only');
    if (rulesColumnOnlyCb) {
      rulesColumnOnlyCb.addEventListener('change', () => {
        const on = rulesColumnOnlyCb.checked;
        scoreDetailPagination.rulesColumnFilter = on;
        if (node) node.dataset.scoreTableRulesColumnFilter = on ? '1' : '0';
        scoreDetailPagination.currentPage = 1;
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
        void renderResults();
      });
    }
    const searchInp = topRow.querySelector('#score-detail-results-search');
    if (searchInp) {
      searchInp.addEventListener('input', () => {
        scoreDetailPagination.searchQuery = searchInp.value;
        scoreDetailPagination.currentPage = 1;
        void renderResults();
      });
    }
    resultsBody.appendChild(topRow);

    function cellText(val, maxLen = 32) {
      const s = val === null || val === undefined ? '—' : (typeof val === 'string' ? val : String(val));
      return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
    }

    function runResultCellsHtml(runResult, runRowIndex, scoreTableRowNum, collapsedInputs, collapsedOutputs, blankOutputsOnly = false) {
      const idxDisplay = runResult ? String((runResult.row_index ?? runRowIndex) + 1) : '—';
      const idxTitle = scoreTableRowNum != null
        ? `Score table row ${scoreTableRowNum}${runResult ? `; Run result row ${(runResult.row_index ?? runRowIndex) + 1}` : ''}`
        : (runResult ? `Run result row ${(runResult.row_index ?? runRowIndex) + 1}` : 'No run result');
      const inpDisplay = runResult ? String((runResult.input_row_index ?? 0) + 1) : '—';
      const inpTitle = runResult ? `Dataset input row ${inpDisplay}` : '';
      let html = '';
      if (hasInputBlock) {
        if (collapsedInputs) {
          html += '<td class="score-detail-results-td run-detail-td run-detail-td--dataset-row-col run-detail-td--input-block-start run-detail-bracket-collapsed" title="">Input ...</td>';
        } else {
          html += `<td class="score-detail-results-td run-detail-td run-detail-td--dataset-row-col run-detail-td--input-block-start" title="${escapeAttr(inpTitle)}">${inpDisplay}</td>`;
          const inputRow = runResult && Array.isArray(runResult.input_row) ? runResult.input_row : [];
          inputHeadersForTable.forEach((h) => {
            const ci = inputHeaders.findIndex((x) => String(x ?? '').trim() === String(h ?? '').trim());
            const v = ci >= 0 ? inputRow[ci] : null;
            const disp = v == null ? '—' : cellText(v);
            html += `<td class="score-detail-results-td run-detail-td run-detail-td--dataset-row-col" title="${escapeAttr(v == null ? '' : String(v))}">${v == null ? '—' : escapeHtml(disp)}</td>`;
          });
        }
      }
      if (!hasOutputBlock) return html;
      if (collapsedOutputs) {
        html += '<td class="score-detail-results-td run-detail-td run-detail-td--dataset-row-col run-detail-td--input-block-sep run-detail-bracket-collapsed" title="">Output ...</td>';
        return html;
      }
      if (showOutputIndexCol) {
        html += `<td class="score-detail-results-td run-detail-td run-detail-td--index run-detail-td--input-block-sep" title="${escapeAttr(idxTitle)}">${idxDisplay}</td>`;
      }
      if (blankOutputsOnly) {
        outputFieldsForTable.forEach(() => {
          html += '<td class="score-detail-results-td run-detail-td" title="">—</td>';
        });
        return html;
      }
      const hasErr = !!(runResult && runResult.error);
      outputFieldsForTable.forEach((f) => {
        if (hasErr) {
          const errText = cellText(runResult.error);
          html += `<td class="score-detail-results-td run-detail-td run-detail-td--error" title="${escapeAttr(runResult.error)}">${escapeHtml(errText)}</td>`;
        } else {
          const val = runResult && runResult.output ? runResult.output[f.key] : null;
          const str = val == null ? '—' : (Array.isArray(val) ? cellText(val.join(', ')) : cellText(val));
          const fullTitle = val == null ? '' : (Array.isArray(val) ? val.join(', ') : String(val));
          html += `<td class="score-detail-results-td run-detail-td" title="${escapeAttr(fullTitle)}">${val == null ? '—' : escapeHtml(str)}</td>`;
        }
      });
      return html;
    }
    const tableWrap = document.createElement('div');
    tableWrap.className = 'score-detail-results-table-wrap';
    const tbl = document.createElement('table');
    tbl.className = 'score-detail-results-table run-detail-results-table';
    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    const thListNum = document.createElement('th');
    thListNum.className = 'score-detail-results-th run-detail-th run-detail-th--row-display-num';
    thListNum.textContent = '#';
    thListNum.title = 'Row number in the current list (after sort/filter)';
    trHead.appendChild(thListNum);
    const canToggleInputs = typeof getRunInputColsCollapsed === 'function' && typeof setRunInputColsCollapsed === 'function';
    const onToggleInputs = () => {
      if (!canToggleInputs) return;
      setRunInputColsCollapsed(!getRunInputColsCollapsed());
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      void renderResults();
    };
    const canToggleOutputs = typeof getScoreOutputColsCollapsed === 'function' && typeof setScoreOutputColsCollapsed === 'function';
    const onToggleOutputs = () => {
      if (!canToggleOutputs) return;
      setScoreOutputColsCollapsed(!getScoreOutputColsCollapsed());
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      void renderResults();
    };
    const canToggleGt = typeof getScoreGtColsCollapsed === 'function' && typeof setScoreGtColsCollapsed === 'function';
    const onToggleGt = () => {
      if (!canToggleGt) return;
      setScoreGtColsCollapsed(!getScoreGtColsCollapsed());
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      void renderResults();
    };
    function wireScoreInputHeader(th, title) {
      if (!canToggleInputs) return;
      th.classList.add('run-detail-th--bracket-toggle');
      th.title = title;
      th.setAttribute('role', 'button');
      th.setAttribute('tabindex', '0');
      th.addEventListener('click', onToggleInputs);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggleInputs();
        }
      });
    }
    function wireScoreOutputHeader(th, title) {
      if (!canToggleOutputs) return;
      th.classList.add('run-detail-th--bracket-toggle');
      th.title = title;
      th.setAttribute('role', 'button');
      th.setAttribute('tabindex', '0');
      th.addEventListener('click', onToggleOutputs);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggleOutputs();
        }
      });
    }
    function wireScoreGtHeader(th, title) {
      if (!canToggleGt) return;
      th.classList.add('run-detail-th--bracket-toggle');
      th.title = title;
      th.setAttribute('role', 'button');
      th.setAttribute('tabindex', '0');
      th.addEventListener('click', onToggleGt);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggleGt();
        }
      });
    }
    if (hasInputBlock) {
      const thBracket = document.createElement('th');
      thBracket.className = `score-detail-results-th run-detail-th run-detail-th--dataset-row-col run-detail-th--input-block-start${runInputColsCollapsed ? ' run-detail-bracket-collapsed' : ''}`;
      thBracket.textContent = runInputColsCollapsed ? 'Input ...' : 'Input: #';
      if (canToggleInputs) {
        wireScoreInputHeader(
          thBracket,
          runInputColsCollapsed
            ? 'Click to expand input columns.'
            : 'Input: # — Dataset input row index. Click any input column header to hide input columns.',
        );
      } else {
        thBracket.title = runInputColsCollapsed
          ? 'Input columns hidden. Click a header with toggle to expand.'
          : 'Input: # — Dataset input row index.';
      }
      trHead.appendChild(thBracket);
      if (!runInputColsCollapsed) {
        inputHeadersForTable.forEach((h) => {
          const th = document.createElement('th');
          th.className = 'score-detail-results-th run-detail-th run-detail-th--dataset-row-col';
          const label = `Input: ${String(h ?? '').trim() || ' '}`;
          th.textContent = label;
          wireScoreInputHeader(th, `${label} — Click to hide input columns.`);
          trHead.appendChild(th);
        });
      }
    }
    if (hasOutputBlock) {
      if (scoreOutputColsCollapsed) {
        const thOutBracket = document.createElement('th');
        thOutBracket.className = 'score-detail-results-th run-detail-th run-detail-th--dataset-row-col run-detail-th--input-block-sep run-detail-bracket-collapsed';
        thOutBracket.textContent = 'Output ...';
        if (canToggleOutputs) {
          wireScoreOutputHeader(
            thOutBracket,
            'Click to expand model output columns.',
          );
        } else {
          thOutBracket.title = 'Output columns hidden. Click a header with toggle to expand.';
        }
        trHead.appendChild(thOutBracket);
      } else {
        if (showOutputIndexCol) {
          const thRunIdx = document.createElement('th');
          thRunIdx.className = 'score-detail-results-th run-detail-th run-detail-th--index run-detail-th--input-block-sep';
          const outputRowIdxLabel = formatResultOutputColumnLabel('#');
          thRunIdx.textContent = outputRowIdxLabel;
          if (canToggleOutputs) {
            wireScoreOutputHeader(
              thRunIdx,
              'Output: # — Run output row index. Click any output column header to hide output columns.',
            );
          } else {
            thRunIdx.title = 'Run output row index (row_index + 1)';
          }
          trHead.appendChild(thRunIdx);
        }
        outputFieldsForTable.forEach((f) => {
          const th = document.createElement('th');
          const label = formatResultOutputColumnLabel((f.display || f.key || '').trim() || '—');
          th.className = 'score-detail-results-th run-detail-th';
          th.textContent = label;
          th.title = label;
          wireScoreOutputHeader(th, `${label} — Click to hide output columns.`);
          trHead.appendChild(th);
        });
      }
    }
    if (scoreGtColsCollapsed) {
      const thGtBracket = document.createElement('th');
      thGtBracket.className = 'score-detail-results-th score-detail-results-th--gt score-detail-results-th--gt-block score-detail-results-th--block-sep score-detail-results-th--gt-collapse-bracket run-detail-bracket-collapsed';
      thGtBracket.textContent = 'Ground truth ...';
      if (canToggleGt) {
        wireScoreGtHeader(
          thGtBracket,
          'Click to expand ground truth columns.',
        );
      } else {
        thGtBracket.title = 'Ground truth columns hidden. Click a header with toggle to expand.';
      }
      trHead.appendChild(thGtBracket);
    } else {
      const thGtNum = document.createElement('th');
      thGtNum.className = 'score-detail-results-th score-detail-results-th--idx score-detail-results-th--gt-block score-detail-results-th--block-sep';
      thGtNum.textContent = SCORE_GT_ROW_INDEX_LABEL;
      if (canToggleGt) {
        wireScoreGtHeader(
          thGtNum,
          'Ground truth row index. Click any ground truth column header to hide ground truth columns.',
        );
      } else {
        thGtNum.title = 'Ground truth row index';
      }
      trHead.appendChild(thGtNum);
      if (gtColsDisplayed.length > 0) {
        gtColsDisplayed.forEach((col) => {
          const th = document.createElement('th');
          th.className = 'score-detail-results-th score-detail-results-th--gt score-detail-results-th--gt-block';
          const headLabel = formatScoreGroundTruthColumnLabel(col);
          th.textContent = headLabel;
          th.title = headLabel;
          wireScoreGtHeader(th, `${headLabel} — Click to hide ground truth columns.`);
          trHead.appendChild(th);
        });
      } else {
        const th = document.createElement('th');
        th.className = 'score-detail-results-th score-detail-results-th--gt score-detail-results-th--gt-block';
        th.textContent = 'Ground truth';
        th.title = 'Ground truth';
        wireScoreGtHeader(th, 'Ground truth — Click to hide ground truth columns.');
        trHead.appendChild(th);
      }
    }
    const thMatch = document.createElement('th');
    thMatch.className = 'score-detail-results-th score-detail-results-th--match score-detail-results-th--result-block score-detail-results-th--block-sep';
    thMatch.textContent = 'Match';
    thMatch.title = 'Match';
    trHead.appendChild(thMatch);
    const thReview = document.createElement('th');
    thReview.className = 'score-detail-results-th score-detail-results-th--review score-detail-results-th--result-block';
    thReview.title = 'Include in Review API and in Precision / Recall / F1';
    const reviewLab = document.createElement('label');
    reviewLab.className = 'score-detail-results-review-th-label';
    const reviewSpan = document.createElement('span');
    reviewSpan.textContent = 'Review';
    reviewLab.appendChild(reviewSpan);
    const masterCb = document.createElement('input');
    masterCb.type = 'checkbox';
    masterCb.className = 'score-detail-results-review-master-cb';
    masterCb.setAttribute('aria-label', 'Select or clear all Review checkboxes (all rows)');
    reviewLab.appendChild(masterCb);
    thReview.appendChild(reviewLab);
    trHead.appendChild(thReview);
    thead.appendChild(trHead);
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    tbl.appendChild(tbody);

    function appendGtRowFromDescriptor(d, rowNum, zebraStripe = null) {
      const j = d.j;
      const pairedRun = gtToRun[j];
      const showRunCells = typeof pairedRun === 'number' && pairedRun >= 0;
      const anchorIn = !showRunCells && typeof d.displayRunRowIndex === 'number' && d.displayRunRowIndex >= 0
        ? d.displayRunRowIndex
        : -1;
      const runRowIndexForCells = showRunCells ? pairedRun : anchorIn;
      const runResult = runRowIndexForCells >= 0 ? resultsByIndex.get(runRowIndexForCells) || null : null;
      const blankOutputsOnly = !showRunCells && anchorIn >= 0;
      const matchEvalRun = showRunCells
        ? pairedRun
        : (typeof d.displayRunRowIndex === 'number' && d.displayRunRowIndex >= 0 ? d.displayRunRowIndex : -1);
      const isMatch = matchEvalRun >= 0 && isPairMatchForRow(matchEvalRun, j);
      const rowClass = isMatch ? 'score-detail-results-tr--match' : 'score-detail-results-tr--unmatch';
      const rowKey = String(j);
      const zebraClass = zebraStripe === 0 || zebraStripe === 1 ? ` score-detail-results-tr--input-zebra-${zebraStripe}` : '';
      const trClasses = `score-detail-results-tr ${rowClass}${zebraClass}`;
      let tr = `<tr class="${trClasses}" data-score-row-key="${escapeAttr(rowKey)}">`;
      tr += `<td class="score-detail-results-td run-detail-td run-detail-td--row-display-num">${rowNum}</td>`;
      tr += runResultCellsHtml(runResult, runRowIndexForCells, rowNum, runInputColsCollapsed, scoreOutputColsCollapsed, blankOutputsOnly);
      if (scoreGtColsCollapsed) {
        tr += '<td class="score-detail-results-td score-detail-results-td--gt score-detail-results-td--block-sep score-detail-results-td--gt-collapse-bracket run-detail-bracket-collapsed" title="">Ground truth ...</td>';
      } else {
        tr += `<td class="score-detail-results-td score-detail-results-td--idx score-detail-results-td--block-sep" title="Ground truth row ${j + 1}">${j + 1}</td>`;
        if (gtColsDisplayed.length > 0) {
          gtColsDisplayed.forEach((col) => {
            const val = getGtValueForDisplay(gtContent, j, col);
            tr += `<td class="score-detail-results-td score-detail-results-td--gt" title="${escapeAttr(val)}">${escapeHtml(cellText(val))}</td>`;
          });
        } else {
          tr += '<td class="score-detail-results-td score-detail-results-td--gt">—</td>';
        }
      }
      tr += `<td class="score-detail-results-td score-detail-results-td--match score-detail-results-td--block-sep" aria-label="${isMatch ? 'Matched' : 'Not matched'}">${isMatch ? 'true' : 'false'}</td>`;
      tr += '<td class="score-detail-results-td score-detail-results-td--review"></td></tr>';
      tbody.insertAdjacentHTML('beforeend', tr);
    }

    function appendRunOnlyRow(i, rowNum, zebraStripe = null) {
      const runResult = resultsByIndex.get(i) || null;
      const rowClass = 'score-detail-results-tr--run-only';
      const rowKey = 'run:' + i;
      const zebraClass = zebraStripe === 0 || zebraStripe === 1 ? ` score-detail-results-tr--input-zebra-${zebraStripe}` : '';
      let tr = `<tr class="score-detail-results-tr ${rowClass}${zebraClass}" data-score-row-key="${escapeAttr(rowKey)}">`;
      tr += `<td class="score-detail-results-td run-detail-td run-detail-td--row-display-num">${rowNum}</td>`;
      tr += runResultCellsHtml(runResult, i, rowNum, runInputColsCollapsed, scoreOutputColsCollapsed);
      if (scoreGtColsCollapsed) {
        tr += '<td class="score-detail-results-td score-detail-results-td--gt score-detail-results-td--block-sep score-detail-results-td--gt-collapse-bracket run-detail-bracket-collapsed" title="">Ground truth ...</td>';
      } else {
        tr += '<td class="score-detail-results-td score-detail-results-td--idx score-detail-results-td--block-sep" title="No ground truth row">—</td>';
        if (gtColsDisplayed.length > 0) {
          gtColsDisplayed.forEach(() => { tr += '<td class="score-detail-results-td score-detail-results-td--gt">—</td>'; });
        } else {
          tr += '<td class="score-detail-results-td score-detail-results-td--gt">—</td>';
        }
      }
      tr += '<td class="score-detail-results-td score-detail-results-td--match score-detail-results-td--block-sep" aria-label="Run result row without ground truth match">false</td>';
      tr += '<td class="score-detail-results-td score-detail-results-td--review"></td></tr>';
      tbody.insertAdjacentHTML('beforeend', tr);
    }

    const inputZebraStripes = buildScoreZebraStripes(
      filteredDescriptors,
      resultsByIndex,
      gtToRun,
      inputRoot,
      runWs,
      outputFields,
      gtContent,
      getRunValue,
      getGtValue,
    );
    let rowNum = start + 1;
    for (let idx = 0; idx < pageDescriptors.length; idx++) {
      const d = pageDescriptors[idx];
      const globalIdx = start + idx;
      const zs = inputZebraStripes[globalIdx];
      if (d.type === 'gt') {
        appendGtRowFromDescriptor(d, rowNum++, zs);
      } else {
        appendRunOnlyRow(d.i, rowNum++, zs);
      }
    }

    function descriptorToReviewKey(d) {
      return d.type === 'gt' ? String(d.j) : `run:${d.i}`;
    }
    function allReviewRowKeys() {
      return descriptors.map(descriptorToReviewKey);
    }
    function syncReviewMasterCheckbox() {
      const masterCb = tbl.querySelector('.score-detail-results-review-master-cb');
      if (!masterCb) return;
      const keys = allReviewRowKeys();
      if (keys.length === 0) {
        masterCb.checked = false;
        masterCb.indeterminate = false;
        masterCb.disabled = true;
        return;
      }
      masterCb.disabled = false;
      const ex = getScoreRowExcludedFromScoring();
      let included = 0;
      for (const k of keys) {
        if (!ex[k]) included++;
      }
      masterCb.checked = included === keys.length;
      masterCb.indeterminate = included > 0 && included < keys.length;
    }

    tbody.querySelectorAll('tr').forEach((tr) => {
      const rowKey = tr.getAttribute('data-score-row-key');
      const tdReview = tr.querySelector('.score-detail-results-td--review');
      if (rowKey == null) return;
      if (tdReview) {
        const wrap = document.createElement('label');
        wrap.className = 'score-detail-results-review-label';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !isScoreRowExcludedFromScoring(rowKey);
        cb.setAttribute('aria-label', 'Include in Review and in Precision / Recall / F1');
        cb.addEventListener('change', () => {
          const ex = { ...getScoreRowExcludedFromScoring() };
          if (cb.checked) delete ex[rowKey];
          else ex[rowKey] = true;
          setScoreRowExcludedFromScoring(ex);
          refreshScoreMetricsBanner();
          syncReviewMasterCheckbox();
        });
        wrap.appendChild(cb);
        tdReview.appendChild(wrap);
      }
    });

    const masterReviewCb = tbl.querySelector('.score-detail-results-review-master-cb');
    if (masterReviewCb) {
      masterReviewCb.addEventListener('change', () => {
        const keys = allReviewRowKeys();
        if (keys.length === 0) return;
        const ex = { ...getScoreRowExcludedFromScoring() };
        if (masterReviewCb.checked) {
          for (const k of keys) delete ex[k];
        } else {
          for (const k of keys) ex[k] = true;
        }
        setScoreRowExcludedFromScoring(ex);
        tbody.querySelectorAll('tr[data-score-row-key] .score-detail-results-td--review input[type="checkbox"]').forEach((el) => {
          const row = el.closest('tr');
          const key = row?.getAttribute('data-score-row-key');
          if (key == null) return;
          el.checked = !ex[key];
        });
        masterReviewCb.indeterminate = false;
        refreshScoreMetricsBanner();
      });
      syncReviewMasterCheckbox();
    }

    tableWrap.appendChild(tbl);
    const tableScroll = document.createElement('div');
    tableScroll.className = 'score-detail-results-table-scroll';
    tableScroll.appendChild(tableWrap);
    resultsBody.appendChild(tableScroll);
    if (savedScrollTop || savedScrollLeft) {
      tableScroll.scrollTop = savedScrollTop;
      tableScroll.scrollLeft = savedScrollLeft;
    }

    if (resultsToolbar) {
      resultsToolbar.style.display = '';
      resultsToolbar.innerHTML = `
        <label class="dataset-detail-rows-label" for="score-detail-rows-per-page">Rows per page</label>
        <select id="score-detail-rows-per-page" class="dataset-detail-rows-select" aria-label="Rows per page">
          ${ROWS_PER_PAGE_OPTIONS.map((n) => `<option value="${n}" ${n === scoreDetailPagination.rowsPerPage ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
        <span class="dataset-detail-pagination-info score-detail-pagination-info" aria-live="polite">${totalRows === 0 ? (totalUnfiltered === 0 ? '0 rows' : `0 rows (filtered from ${totalUnfiltered})`) : (totalRows === totalUnfiltered ? `Showing ${start + 1}–${end} of ${totalRows} rows` : `Showing ${start + 1}–${end} of ${totalRows} (filtered from ${totalUnfiltered}) rows`)}</span>
        <label class="dataset-detail-page-label" for="score-detail-page-inp">Page</label>
        <input type="number" id="score-detail-page-inp" class="dataset-detail-page-inp" min="1" max="${totalPages}" value="${scoreDetailPagination.currentPage}" aria-label="Page number" />
        <span class="dataset-detail-page-of score-detail-page-of">/ ${totalPages}</span>
        <div class="dataset-detail-pagination-btns">
          <button type="button" class="btn btn-secondary score-detail-prev-page" aria-label="Previous page">Previous</button>
          <button type="button" class="btn btn-secondary score-detail-next-page" aria-label="Next page">Next</button>
        </div>
      `;
      const rowsPerPageSelect = resultsToolbar.querySelector('#score-detail-rows-per-page');
      const pageInp = resultsToolbar.querySelector('#score-detail-page-inp');
      const prevBtn = resultsToolbar.querySelector('.score-detail-prev-page');
      const nextBtn = resultsToolbar.querySelector('.score-detail-next-page');
      if (rowsPerPageSelect) {
        rowsPerPageSelect.addEventListener('change', () => {
          scoreDetailPagination.rowsPerPage = Number(rowsPerPageSelect.value) || 25;
          scoreDetailPagination.currentPage = 1;
          void renderResults();
        });
      }
      if (pageInp) {
        pageInp.addEventListener('change', () => {
          scoreDetailPagination.currentPage = Math.max(1, Math.min(totalPages, parseInt(pageInp.value, 10) || 1));
          void renderResults();
        });
      }
      if (prevBtn) {
        prevBtn.disabled = scoreDetailPagination.currentPage <= 1;
        prevBtn.addEventListener('click', () => {
          scoreDetailPagination.currentPage = Math.max(1, scoreDetailPagination.currentPage - 1);
          void renderResults();
        });
      }
      if (nextBtn) {
        nextBtn.disabled = scoreDetailPagination.currentPage >= totalPages;
        nextBtn.addEventListener('click', () => {
          scoreDetailPagination.currentPage = Math.min(totalPages, scoreDetailPagination.currentPage + 1);
          void renderResults();
        });
      }
    }
    void updateSaveToWorkspaceButton();
  }

  async function updateReviewButtonState() {
    const payload = await Promise.resolve(getReviewPayload());
    const reviewDisabled =
      !payload || !payload.prompt_sections || payload.prompt_sections.length === 0 || !selectedNodeId;
    if (addPromptReviewBtn) addPromptReviewBtn.disabled = reviewDisabled;
    if (reviewPayloadPreviewBtn) reviewPayloadPreviewBtn.disabled = reviewDisabled;
    await updateSaveToWorkspaceButton();
  }

  async function loadReviewCredentials() {
    try {
      const [list, settings] = await Promise.all([
        fetch(`${API_BASE}/api/credentials`).then((r) => r.ok ? r.json() : []),
        fetch(`${API_BASE}/api/settings`).then((r) => r.ok ? r.json() : null),
      ]);
      llmSelect.innerHTML = `<option value="">${escapeHtml(selectPlaceholderLabel('Select model'))}</option>` + (list || []).map((c) => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.model || c.llm || '')}</option>`).join('');
      let credentialId = (node?.dataset?.reviewCredentialId || '').trim();
      if (!credentialId && settings) {
        const defaultId = (settings.default_review_credential_id || '').trim();
        if (defaultId && (list || []).some((c) => c.id === defaultId)) credentialId = defaultId;
      }
      if (reviewPayloadPreviewBtn) reviewPayloadPreviewBtn.hidden = !(settings?.debug_mode === true);
      if (credentialId) {
        llmSelect.value = credentialId;
        if (node) node.dataset.reviewCredentialId = credentialId;
      }
    } catch (_) {}
    void updateReviewButtonState();
  }

  async function updateSaveToWorkspaceButton() {
    if (!saveToWorkspaceBtn) return;
    if (activePanelMode === 'code') {
      saveToWorkspaceBtn.disabled = !lastCodeMatchResult || (lastCodeMatchResult.outcomes || []).length === 0;
      return;
    }
    try {
      const payload = await getScoreExportData({ node, getRunResults, getRunWorkingSetContent, getGroundTruthContent, getGroundTruthHeaders, getRunResultColumns });
      saveToWorkspaceBtn.disabled = !payload || !payload.headers || !payload.rows.length;
    } catch (_) {
      saveToWorkspaceBtn.disabled = true;
    }
  }

  llmSelect.addEventListener('change', () => {
    const v = (llmSelect.value || '').trim();
    if (node) {
      node.dataset.reviewCredentialId = v;
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
  });

  if (saveToWorkspaceBtn) {
    saveToWorkspaceBtn.addEventListener('click', async () => {
      const scoreName = (node?.querySelector?.('.workflow-node__title')?.textContent || '').trim() || 'Score';
      if (activePanelMode === 'code') {
        if (!lastCodeMatchResult) return;
        const { headers, rows } = buildCodeMatchTableData(lastCodeMatchResult);
        if (!headers || !rows.length) return;
        document.dispatchEvent(new CustomEvent('workflow:score-export-to-workspace', {
          detail: { scoreNodeId: node?.dataset?.nodeId || '', scoreName, headers, rows },
        }));
        return;
      }
      const payload = await getScoreExportData({ node, getRunResults, getRunWorkingSetContent, getGroundTruthContent, getGroundTruthHeaders, getRunResultColumns });
      if (!payload || !payload.headers || !payload.rows) return;
      document.dispatchEvent(new CustomEvent('workflow:score-export-to-workspace', {
        detail: { scoreNodeId: node?.dataset?.nodeId || '', scoreName, headers: payload.headers, rows: payload.rows },
      }));
    });
  }

  addPromptReviewBtn.addEventListener('click', async () => {
    if (!node?.dataset?.nodeId) return;
    const credentialId = (llmSelect?.value || '').trim();
    if (!credentialId) {
      showAlert('Select a model for Review before starting.', { title: 'Review' });
      return;
    }
    await runReviewFromScore({
      scoreNodeId: node.dataset.nodeId,
      getReviewPayload,
      credentialId,
    });
  });

  if (reviewPayloadPreviewBtn) {
    reviewPayloadPreviewBtn.addEventListener('click', async () => {
      if (!node?.dataset?.nodeId) return;
      await openReviewSelectionPreviewModal({ getReviewPayload });
    });
  }

  /** Filter group for memory apply: keep only rules valid for runKeys/gtSet, update existingSet. Returns null if empty. */
  function filterGroupForApply(g, runKeys, gtSet, existingSet) {
    if (!g || !Array.isArray(g.children)) return null;
    const children = g.children.map((ch) => {
      if (ch.type === 'rule') {
        const ok = (ch.outputKey || '').trim();
        const cols = (ch.gtColumns || []).map((c) => String(c || '').trim()).filter((c) => runKeys.has(ok) && gtSet.has(c) && !existingSet.has(ok + '\t' + c));
        if (cols.length === 0) return null;
        cols.forEach((c) => existingSet.add(ok + '\t' + c));
        const rawMt = ch.matchType || 'exact';
        const mf = { ...DEFAULT_MATCH_FLAGS, ...(ch.matchFlags || {}) };
        if (legacyMatchTypeWasContains(rawMt)) mf.contains = true;
        return { type: 'rule', outputKey: ok, gtColumns: cols, matchType: migrateLegacyMatchType(rawMt), matchFlags: mf };
      }
      return filterGroupForApply(ch, runKeys, gtSet, existingSet);
    }).filter(Boolean);
    if (children.length === 0) return null;
    return { type: 'group', ops: (g.ops || []).slice(0, Math.max(0, children.length - 1)), children };
  }

  /** When a GT is selected, add rules from ruleEditorMemory (run column + GT column match). Returns true if any were added. */
  function applyRulesFromMemory() {
    if (!selectedNodeId) return false;
    const runColumns = getRunResultColumns();
    const gtHeaders = getGroundTruthHeaders(selectedNodeId);
    const runWsMem = getRunWorkingSetContent();
    const runKeys = new Set((runColumns || []).map((c) => (c.key || '').trim()).filter(Boolean));
    (runWsMem.headers || []).forEach((h) => {
      const name = String(h ?? '').trim();
      if (name) runKeys.add(`[${name}]`);
    });
    runKeys.add('#');
    runKeys.add('[#]');
    const gtSet = new Set([...(gtHeaders || []), SCORE_GT_ROW_INDEX_COLUMN]);
    const existingSet = new Set();
    const { inputRoot: ir0, outputRoot: or0 } = loadBundle();
    [ir0, or0].forEach((r0) => {
      collectRulesFlat(r0).forEach(({ rule: r }) => {
        const ok = (r.outputKey || '').trim();
        const okNorm = ok === '[#]' ? '#' : ok;
        (r.gtColumns || []).forEach((gc) => {
          const g = String(gc || '').trim();
          if (ok && g) existingSet.add(okNorm + '\t' + g);
        });
      });
    });
    let inputRoot = ir0;
    let outputRoot = or0;
    let added = false;

    for (const item of ruleEditorMemoryOrdered || []) {
      if (item.type === 'group') {
        const filtered = filterGroupForApply(item, runKeys, gtSet, existingSet);
        if (!filtered) continue;
        const memSide = item.scoreMemorySide || 'input';
        if (memSide === 'output' && flattenScoreRules(inputRoot || emptyScoreRuleGroup()).length === 0) {
          continue;
        }
        const target = memSide === 'input' ? inputRoot : outputRoot;
        const next = insertChildAtPath(target, [], filtered, (target.children || []).length);
        if (memSide === 'input') inputRoot = next;
        else outputRoot = next;
        added = true;
      } else if (item.type === 'rule') {
        const outputKeyRaw = (item.outputKey || '').trim();
        const outputKey = outputKeyRaw === '[#]' ? '#' : outputKeyRaw;
        const cols = (item.gtColumns || []).map((c) => String(c || '').trim()).filter((c) => runKeys.has(outputKeyRaw) && gtSet.has(c) && !existingSet.has(outputKey + '\t' + c));
        if (cols.length === 0) continue;
        cols.forEach((c) => existingSet.add(outputKey + '\t' + c));
        const rawMt = item.matchType || 'exact';
        const mf = (item.matchFlags && typeof item.matchFlags === 'object') ? { ...DEFAULT_MATCH_FLAGS, ...item.matchFlags } : { ...DEFAULT_MATCH_FLAGS };
        if (legacyMatchTypeWasContains(rawMt)) mf.contains = true;
        const newRule = {
          type: 'rule',
          outputKey,
          gtColumns: cols,
          matchType: migrateLegacyMatchType(rawMt),
          matchFlags: mf,
        };
        const memSide = item.scoreMemorySide ?? (isScoreInputSideRuleKey(outputKey) ? 'input' : 'output');
        if (memSide === 'output' && flattenScoreRules(inputRoot || emptyScoreRuleGroup()).length === 0) {
          continue;
        }
        const target = memSide === 'input' ? inputRoot : outputRoot;
        const next = insertChildAtPath(target, [], newRule, (target.children || []).length);
        if (memSide === 'input') inputRoot = next;
        else outputRoot = next;
        added = true;
      }
    }
    if (added) persistBundle(inputRoot, outputRoot);
    return added;
  }

  function selectGroundTruth(id) {
    selectedNodeId = id || '';
    if (node) {
      node.dataset.scoreGroundTruthId = selectedNodeId || '';
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
    updateTriggerDisplay();
    updateScoreNodeBorder();
    syncRulesSectionVisibility();
    closeDropdown();
    dropdownEl.querySelectorAll('[role="option"]').forEach((o) => o.setAttribute('aria-selected', o.dataset.nodeId === selectedNodeId ? 'true' : 'false'));
    void updateReviewButtonState();
    if (selectedNodeId) {
      const gtSet = new Set([...(getGroundTruthHeaders(selectedNodeId) || []), SCORE_GT_ROW_INDEX_COLUMN]);
      const { inputRoot: ir1, outputRoot: or1 } = loadBundle();
      const inF = filterRootByGtHeaders(ir1, gtSet) || emptyScoreRuleGroup();
      const outF = filterRootByGtHeaders(or1, gtSet) || emptyScoreRuleGroup();
      if (JSON.stringify(inF) !== JSON.stringify(ir1) || JSON.stringify(outF) !== JSON.stringify(or1)) {
        persistBundle(inF, outF);
      }
      applyRulesFromMemory();
    }
    renderRules();
  }

  function populateDropdown() {
    dropdownEl.innerHTML = '';
    const emptyOption = document.createElement('div');
    emptyOption.className = 'run-detail-ws-option';
    emptyOption.setAttribute('role', 'option');
    emptyOption.setAttribute('aria-selected', !selectedNodeId ? 'true' : 'false');
    emptyOption.innerHTML = `<span class="run-detail-ws-option-color run-detail-ws-option-color--empty"></span><span class="run-detail-ws-option-text">${escapeHtml(selectPlaceholderLabel('Select ground truth dataset'))}</span>`;
    emptyOption.dataset.nodeId = '';
    emptyOption.addEventListener('click', () => selectGroundTruth(''));
    dropdownEl.appendChild(emptyOption);
    workingSets.forEach((ws) => {
      const option = document.createElement('div');
      option.className = 'run-detail-ws-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', ws.nodeId === selectedNodeId ? 'true' : 'false');
      option.innerHTML = `<span class="run-detail-ws-option-color" style="background:${escapeHtml(ws.color || 'transparent')}"></span><span class="run-detail-ws-option-text">${escapeHtml(ws.name || 'Dataset')}</span>`;
      option.dataset.nodeId = ws.nodeId;
      option.addEventListener('click', () => selectGroundTruth(ws.nodeId));
      dropdownEl.appendChild(option);
    });
  }

  triggerEl.addEventListener('click', (e) => {
    e.preventDefault();
    if (dropdownEl.hidden) {
      populateDropdown();
      openDropdown();
    } else {
      closeDropdown();
    }
  });
  triggerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (dropdownEl.hidden) {
        populateDropdown();
        openDropdown();
      } else {
        closeDropdown();
      }
    }
  });
  overlay.addEventListener('click', (e) => {
    if (pickerEl.contains(e.target)) return;
    closeDropdown();
  });

  function close() {
    if (node && node.dataset) node.dataset.scoreMatchCode = getMatchCode();
    overlay.remove();
    document.body.style.overflow = '';
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);
  attachModalPaneCycle({
    overlay,
    bothLabel: 'Show both panels',
    leftOnlyLabel: 'Show scoring setup panel only',
    rightOnlyLabel: 'Show results panel only',
  });

  updateTriggerDisplay();
  updateScoreNodeBorder();
  syncRulesSectionVisibility();
  syncRulesTabUi();
  renderRules();
  loadReviewCredentials();
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  if (selectedNodeId) {
    const gtSet = new Set([...(getGroundTruthHeaders(selectedNodeId) || []), SCORE_GT_ROW_INDEX_COLUMN]);
    const { inputRoot: ir2, outputRoot: or2 } = loadBundle();
    const inF2 = filterRootByGtHeaders(ir2, gtSet) || emptyScoreRuleGroup();
    const outF2 = filterRootByGtHeaders(or2, gtSet) || emptyScoreRuleGroup();
    if (JSON.stringify(inF2) !== JSON.stringify(ir2) || JSON.stringify(outF2) !== JSON.stringify(or2)) {
      persistBundle(inF2, outF2);
    }
    applyRulesFromMemory();
    renderRules();
  }
  if (autoTriggerReview && addPromptReviewBtn) {
    setTimeout(() => {
      if (addPromptReviewBtn.disabled) return;
      addPromptReviewBtn.click();
    }, 200);
  }
}

/**
 * Build score comparison table for export (Save to workspace).
 * Column names and order match the Score table except the leading list «#» column (omitted to avoid duplicate # with Input:/Output: indices).
 * @param {{ node: HTMLElement, getRunResults: () => { results, outputFields }, getRunWorkingSetContent: () => { headers, rows }, getGroundTruthContent: (wsNodeId: string) => { headers, rows }, getGroundTruthHeaders: (wsNodeId: string) => string[], getRunResultColumns?: () => Array<{ key: string, label: string }> }} options
 * @returns {Promise<{ headers: string[], rows: string[][] } | null>}
 */
export async function getScoreExportData({ node, getRunResults, getRunWorkingSetContent, getGroundTruthContent, getGroundTruthHeaders, getRunResultColumns }) {
  if (!node) return null;
  const selectedNodeId = (node.dataset.scoreGroundTruthId || '').trim();
  if (!selectedNodeId) return null;
  const raw = (node.dataset.scoreMapping || '{}').trim();
  const { inputRoot, outputRoot } = parseScoreMappingBundle(raw || '{}');
  function collectRulesFlat(r, path = []) {
    if (!r) return [];
    if (r.type === 'rule') return [{ rule: r, path: path.slice() }];
    if (r.type === 'group' && Array.isArray(r.children)) {
      const out = [];
      (r.children || []).forEach((ch, i) => { out.push(...collectRulesFlat(ch, path.concat(i))); });
      return out;
    }
    return [];
  }
  const rulesFlat = [
    ...collectRulesFlat(inputRoot).map((x) => x.rule),
    ...collectRulesFlat(outputRoot).map((x) => x.rule),
  ];
  if (rulesFlat.length === 0) return null;
  const toCompareStr = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) return v.map((x) => toCompareStr(x)).join(', ').trim();
    return String(v).trim();
  };
  const getRunValue = (runResult, outputKey, rowIndex, runWs, outputFields) => {
    if (outputKey === '#' || outputKey === '[#]') return toCompareStr(rowIndex);
    const keyStr = String(outputKey || '').trim();
    if (!keyStr) return '';
    if (keyStr.startsWith('[') && keyStr.endsWith(']')) {
      const header = keyStr.slice(1, -1).trim();
      const rows = runWs.rows || [];
      const headers = runWs.headers || [];
      const colIdx = headers.findIndex((h) => String(h).trim() === header);
      const inputRowIdx = runResult?.input_row_index ?? rowIndex;
      if (colIdx >= 0 && rows[inputRowIdx]) return toCompareStr(rows[inputRowIdx][colIdx]);
      return '';
    }
    if (runResult && runResult.output && typeof runResult.output === 'object' && keyStr in runResult.output) return toCompareStr(runResult.output[keyStr]);
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
  const getGtValueExportDisplay = (gtContent, rowIndex, columnName) => {
    if (String(columnName).trim() === SCORE_GT_ROW_INDEX_COLUMN) {
      if (typeof rowIndex !== 'number' || rowIndex < 0) return '';
      return String(rowIndex + 1);
    }
    return getGtValue(gtContent, rowIndex, columnName);
  };
  let exportEmbeddingCosineMap = new Map();
  const ruleMatchesRow = (rule, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent) => {
    const runResult = resultsByIndex.get(runRowIndex) || null;
    const runValRaw = getRunValue(runResult, rule.outputKey, runRowIndex, runWs, outputFields);
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
      return gtValsRaw.some((g) => embeddingPairMatches(runValRaw, g, exportEmbeddingCosineMap));
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
  const evaluateNode = (nd, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent) => {
    if (!nd) return false;
    if (nd.type === 'rule') return ruleMatchesRow(nd, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent);
    if (nd.type === 'group' && Array.isArray(nd.children)) {
      if (nd.children.length === 0) return false;
      const ops = nd.ops || Array(Math.max(0, nd.children.length - 1)).fill('AND');
      let r = evaluateNode(nd.children[0], runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent);
      for (let i = 1; i < nd.children.length; i++) {
        const next = evaluateNode(nd.children[i], runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent);
        r = (ops[i - 1] === 'OR') ? (r || next) : (r && next);
      }
      return r;
    }
    return false;
  };
  const computeMatchPerRow = (inR, outR, results, outputFields, runWs, gtContent) => {
    const { runToGt } = computeGreedyRunToGtPairing({
      inputRoot: inR,
      outputRoot: outR,
      results,
      runWs,
      gtContent,
      outputFields,
      ruleMatchesRow,
      getRunValue,
    });
    return { runToGt, total: (results || []).length };
  };

  const { results: rawResults, outputFields } = getRunResults();
  const runWs = getRunWorkingSetContent();
  const rawGtContent = getGroundTruthContent(selectedNodeId);
  const gtColsUsed = buildScoreTableGtColumns(rulesFlat, rawGtContent);

  const resultsForScore = (rawResults || []).filter((r) => r);
  const gtContent = rawGtContent;
  const results = resultsForScore.filter((r) => isValidRunOutputForScoreRow(r, outputFields));
  const gtRows = gtContent.rows || [];
  const gtHeaders = gtContent.headers || [];
  if (!Array.isArray(gtRows)) return null;
  if (gtRows.length === 0 && (!results || results.length === 0)) return null;
  const resultsByIndex = new Map();
  (results || []).forEach((r) => { resultsByIndex.set(r.row_index, r); });
  const runRowIndices = [...new Set((results || []).map((r) => r.row_index))];
  exportEmbeddingCosineMap = new Map();
  if (rulesFlat.some((r) => getMatchFlags(r).embeddingSimilarity)) {
    try {
      exportEmbeddingCosineMap = await prefetchEmbeddingCosineMap(API_BASE, {
        root: scoreBundleRootsForEmbeddingWalk(inputRoot, outputRoot),
        results,
        outputFields,
        runWs,
        gtContent,
        getRunValue,
        getGtValue,
      });
    } catch (_) {
      exportEmbeddingCosineMap = new Map();
    }
  }
  const { runToGt } = computeMatchPerRow(inputRoot, outputRoot, results, outputFields, runWs, gtContent);
  const gtToRun = new Array(gtRows.length).fill(-1);
  for (let i = 0; i < (runToGt || []).length; i++) {
    if (runToGt[i] >= 0) gtToRun[runToGt[i]] = i;
  }
  function treeMatchesPairForRow(rootTree, iRun, jGt) {
    const leaves = flattenScoreRules(rootTree || emptyScoreRuleGroup());
    if (leaves.length === 0) return true;
    return evaluateNode(rootTree, iRun, jGt, resultsByIndex, runWs, outputFields, gtContent);
  }
  function isPairMatchForRow(iRun, jGt) {
    if (iRun < 0 || jGt < 0) return false;
    if (!treeMatchesPairForRow(inputRoot, iRun, jGt)) return false;
    const outLeaves = flattenScoreRules(outputRoot || emptyScoreRuleGroup());
    if (outLeaves.length === 0) return true;
    return evaluateNode(outputRoot, iRun, jGt, resultsByIndex, runWs, outputFields, gtContent);
  }
  const descriptors = attachInputMatchedUnpairedGtDescriptors(
    buildScoreResultDescriptorsInRunOrder({
      runRowIndices,
      runToGt,
      gtToRun,
      gtRowsLength: gtRows.length,
      evaluateRunMatchesAnyGt: (i) => {
        for (let j = 0; j < gtRows.length; j++) {
          if (treeMatchesPairForRow(inputRoot, i, j) && treeMatchesPairForRow(outputRoot, i, j)) return true;
        }
        return false;
      },
    }),
    {
      runRowIndices,
      runToGt,
      gtToRun,
      inputMatchesPairForRow: (i, jj) => treeMatchesPairForRow(inputRoot, i, jj),
    },
  );
  let excludedFromScoring = {};
  try {
    excludedFromScoring = JSON.parse(node.dataset.scoreRowExcludedFromScoring || '{}');
  } catch (_) {}
  const rowIncludedInReview = (key) => !excludedFromScoring[key];
  const inputHeadersExport = runWs.headers || [];
  const runExportHeaders = [
    'Input: #',
    ...inputHeadersExport.map((h) => `Input: ${String(h ?? '').trim() || ' '}`),
    formatResultOutputColumnLabel('#'),
    ...outputFields.map((f) => formatResultOutputColumnLabel((f.display || f.key || '').trim() || '—')),
  ];
  const gtExportColLabels = (gtColsUsed.length > 0
    ? gtColsUsed.map((c) => formatScoreGroundTruthColumnLabel(c))
    : ['Ground truth']);
  const headers = [...runExportHeaders, SCORE_GT_ROW_INDEX_LABEL, ...gtExportColLabels, 'Match', 'Review'];
  function pushRunExportRowCells(parts, runResult, rowIndex, blankOutputsOnly = false) {
    parts.push(runResult ? String((runResult.input_row_index ?? 0) + 1) : '—');
    const inputRow = runResult && Array.isArray(runResult.input_row) ? runResult.input_row : [];
    inputHeadersExport.forEach((_, ci) => {
      parts.push(inputRow[ci] != null ? String(inputRow[ci]) : '');
    });
    parts.push(runResult ? String((runResult.row_index ?? rowIndex) + 1) : '—');
    if (blankOutputsOnly) {
      outputFields.forEach(() => { parts.push(''); });
    } else if (runResult && runResult.error) {
      outputFields.forEach(() => { parts.push(String(runResult.error)); });
    } else {
      outputFields.forEach((f) => {
        parts.push(runResult ? getRunValue(runResult, f.key, rowIndex, runWs, outputFields) : '');
      });
    }
  }
  const rows = descriptors.map((d) => {
    const parts = [];
    if (d.type === 'gt') {
      const j = d.j;
      const pairedRun = gtToRun[j];
      const showRunCells = typeof pairedRun === 'number' && pairedRun >= 0;
      const anchorIn = !showRunCells && typeof d.displayRunRowIndex === 'number' && d.displayRunRowIndex >= 0
        ? d.displayRunRowIndex
        : -1;
      const runRowForCells = showRunCells ? pairedRun : anchorIn;
      const runResult = runRowForCells >= 0 ? resultsByIndex.get(runRowForCells) || null : null;
      const blankOutputsOnly = !showRunCells && anchorIn >= 0;
      pushRunExportRowCells(parts, runResult, runRowForCells, blankOutputsOnly);
      parts.push(String(j + 1));
      if (gtColsUsed.length === 0) parts.push('—');
      gtColsUsed.forEach((col) => { parts.push(getGtValueExportDisplay(gtContent, j, col)); });
      const matchEvalRun = showRunCells
        ? pairedRun
        : (typeof d.displayRunRowIndex === 'number' && d.displayRunRowIndex >= 0 ? d.displayRunRowIndex : -1);
      parts.push(matchEvalRun >= 0 && isPairMatchForRow(matchEvalRun, j) ? 'true' : 'false');
      parts.push(rowIncludedInReview(String(j)) ? 'true' : 'false');
    } else {
      const i = d.i;
      const runResult = resultsByIndex.get(i) || null;
      pushRunExportRowCells(parts, runResult, i);
      parts.push('—');
      if (gtColsUsed.length === 0) parts.push('—');
      gtColsUsed.forEach(() => { parts.push('—'); });
      parts.push('false');
      parts.push(rowIncludedInReview(`run:${i}`) ? 'true' : 'false');
    }
    return parts.map((v) => (v === null || v === undefined ? '' : String(v)));
  });
  return { headers, rows };
}
