/**
 * Score detail modal: left = Dataset as ground truth picker + field mapping table; right = results.
 * @param {{ node: HTMLElement, getWorkingSets?: () => Array<...>, getRunResultColumns?: () => Array<...>, getGroundTruthHeaders?: (wsNodeId: string) => string[], getReviewPayload?: () => { prompt_sections, run_results, output_fields, comparison_rows } | null }} options
 */

import { showAlert } from './alertModal.js';
import { selectPlaceholderLabel } from './displayTextNormalize.js';

const API_BASE = 'http://localhost:8000';
const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

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
  { value: 'abs', label: 'Absolute margin: |result - ground truth| ≤ ε' },
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
 * @param {string} apiBase e.g. http://localhost:8000
 */
export async function prefetchEmbeddingCosineMap(apiBase, { root, results, outputFields, runWs, gtContent, getRunValue, getGtValue }) {
  const leafRules = [];
  (function walk(n) {
    if (!n) return;
    if (n.type === 'rule') leafRules.push(n);
    if (n.type === 'group' && Array.isArray(n.children)) n.children.forEach(walk);
  })(root);
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
  const base = String(apiBase || 'http://localhost:8000').replace(/\/$/, '');
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

export function openScoreDetailModal({ node, getWorkingSets, getRunResultColumns, getGroundTruthHeaders, getRunResults, getRunWorkingSetContent, getGroundTruthContent, getReviewPayload, autoTriggerReview, getScoreMappingsFromCanvas }) {
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
  function parseScoreRoot(raw) {
    let data;
    try {
      data = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
    } catch (_) {
      return { type: 'group', ops: [], children: [] };
    }
    if (data && data.type === 'group' && Array.isArray(data.children)) {
      const children = (data.children || []).map((c) => (c && c.type === 'group')
        ? normalizeGroupChild(c)
        : normalizeChild(c));
      const ops = ensureGroupOps(data, children);
      return { type: 'group', ops, children };
    }
    const rules = normalizeToRules(Array.isArray(data) ? data : []);
    const children = rules.map((r) => ({
      type: 'rule',
      outputKey: r.outputKey || '',
      gtColumns: (r.gtColumns || []).slice(),
      matchType: migrateLegacyMatchType(r.matchType || 'exact'),
      matchFlags: { ...DEFAULT_MATCH_FLAGS, ...(r.matchFlags && typeof r.matchFlags === 'object' ? r.matchFlags : {}) },
    }));
    return { type: 'group', ops: Array(Math.max(0, children.length - 1)).fill('AND'), children };
  }

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
    return { type: 'group', ops, children };
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
      if (c && c.rowGroupKey === true) leaf.rowGroupKey = true;
      return leaf;
    }
    return normalizeGroupChild(c);
  }

  function getRoot() {
    return parseScoreRoot(node?.dataset?.scoreMapping || '[]');
  }

  function setRoot(root) {
    if (!node) return;
    node.dataset.scoreMapping = JSON.stringify(root);
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  }

  /** Remove rowGroupKey from every rule so at most one rule can keep it after save. */
  function stripAllRowGroupKeys(r) {
    if (!r) return r;
    if (r.type === 'rule') {
      const next = { ...r };
      delete next.rowGroupKey;
      return next;
    }
    if (r.type === 'group' && Array.isArray(r.children)) {
      return { ...r, children: r.children.map(stripAllRowGroupKeys) };
    }
    return r;
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

  /** Get flat list of rules for backward-compat APIs (e.g. results table columns). */
  function getRulesFlat() {
    return collectRulesFlat(getRoot()).map((x) => x.rule);
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
        if (ch.rowGroupKey === true) leaf.rowGroupKey = true;
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
        const root = parseScoreRoot(raw);
        if (!root || root.type !== 'group' || !Array.isArray(root.children)) return;
        root.children.forEach((ch) => {
          if (ch.type === 'rule') {
            const outputKey = (ch.outputKey || '').trim();
            const flags = getMatchFlags(ch);
            const gtCols = (ch.gtColumns || []).map((c) => String(c || '').trim()).filter(Boolean);
            if (outputKey && gtCols.length > 0) {
              ruleEditorMemoryOrdered.push({ type: 'rule', outputKey, gtColumns: gtCols, matchType: migrateLegacyMatchType(ch.matchType || 'exact'), matchFlags: { ...flags } });
              gtCols.forEach((g) => { ruleEditorMemory[outputKey + '\t' + g] = { matchType: migrateLegacyMatchType(ch.matchType || 'exact'), matchFlags: { ...flags } }; });
            }
          } else if (ch.type === 'group') {
            const collected = collectGroupForMemory(ch);
            if (collected) ruleEditorMemoryOrdered.push({ type: 'group', ...collected });
          }
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
    const headers = gtContent.headers || [];
    const rows = gtContent.rows || [];
    const colIdx = headers.findIndex((h) => String(h).trim() === String(columnName).trim());
    if (colIdx >= 0 && rows[rowIndex]) return toCompareStr(rows[rowIndex][colIdx]);
    return '';
  }

  /** 按用户选定的 GT 列去重，保留首次出现。 */
  function deduplicateGtRows(gtContent, gtColsUsed) {
    if (!gtColsUsed || gtColsUsed.length === 0) return gtContent;
    const rows = gtContent.rows || [];
    const seen = new Set();
    const dedupRows = [];
    for (let i = 0; i < rows.length; i++) {
      const key = JSON.stringify(gtColsUsed.map((col) => getGtValue(gtContent, i, col)));
      if (seen.has(key)) continue;
      seen.add(key);
      dedupRows.push(rows[i]);
    }
    return { ...gtContent, rows: dedupRows };
  }

  /** 按用户选定的 output 列去重，保留首次出现。 */
  function deduplicateResults(results, outputKeys, runWs, outputFields) {
    if (!outputKeys || outputKeys.length === 0) return results || [];
    const seen = new Set();
    const dedupResults = [];
    for (const r of (results || [])) {
      const key = JSON.stringify([r.row_index, ...outputKeys.map((k) => getRunValue(r, k, r.row_index, runWs, outputFields))]);
      if (seen.has(key)) continue;
      seen.add(key);
      dedupResults.push(r);
    }
    return dedupResults;
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
   * Count how many leaf rules match for (run row i, GT row j). Used for pairing only.
   */
  function countMatchingRules(root, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent) {
    const rules = collectRulesFlat(root).map((x) => x.rule);
    return rules.filter((rule) => ruleMatchesRow(rule, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent)).length;
  }

  /**
   * 贪心配对 run 与 GT。resultsByIndex 用 row_index 做 key（每行唯一）。
   * 1 input → 多 output 时，每行有独立 row_index，不会覆盖。
   */
  function computeMatchPerRow(root, results, outputFields, runWs, gtContent) {
    const gtRows = gtContent.rows || [];
    const resultsByIndex = new Map();
    (results || []).forEach((r) => { resultsByIndex.set(r.row_index, r); });
    const scoringResults = (results || []).filter((r) => r);
    const inputRowCount = runWs?.rows?.length ?? 0;
    const gtCount = gtRows.length;
    const runRowIndices = [...new Set(scoringResults.map((r) => r.row_index))];
    const maxRunRowIndex = runRowIndices.length ? Math.max(...runRowIndices) : -1;
    const runCount = Math.max(inputRowCount, maxRunRowIndex + 1);
    const runToGt = new Array(Math.max(runCount, gtCount)).fill(-1);
    const gtUsed = new Array(gtCount).fill(false);

    const pairs = [];
    for (const i of runRowIndices) {
      for (let j = 0; j < gtCount; j++) {
        const score = countMatchingRules(root, i, j, resultsByIndex, runWs, outputFields, gtContent);
        if (score > 0) pairs.push({ i, j, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    for (const { i, j } of pairs) {
      if (runToGt[i] >= 0 || gtUsed[j]) continue;
      runToGt[i] = j;
      gtUsed[j] = true;
    }

    const matched = [];
    const maxRow = Math.max(runCount, gtCount);
    for (let i = 0; i < maxRow; i++) {
      matched.push(i < runCount && runToGt[i] >= 0);
    }
    const matchedCount = runToGt.slice(0, runCount).filter((j) => j >= 0).length;
    const total = scoringResults.length;
    return {
      matched,
      runToGt,
      total,
      matchedCount,
    };
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
      const allIn = cols.length > 0 && cols.every((c) => gtSet.has(String(c || '').trim()));
      return allIn ? root : null;
    }
    if (root.type === 'group' && Array.isArray(root.children)) {
      const filtered = root.children.map((ch) => filterRootByGtHeaders(ch, gtSet)).filter((x) => x != null);
      const ops = (root.ops || []).slice(0, Math.max(0, filtered.length - 1));
      return { type: 'group', ops, children: filtered };
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
          <p class="run-detail-main-label score-detail-main-label">Score settings</p>
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
            <div class="dataset-meta-field score-detail-rules-section">
              <span class="dataset-meta-label run-detail-section-label score-detail-rules-label">Rules</span>
              <p class="score-detail-rules-hint">Use groups to combine rules with AND or OR. Within each rule, run column matches if it equals any selected ground truth column.</p>
              <div class="score-detail-rules-scroll">
                <div id="score-detail-rules-list" class="score-detail-rules-list"></div>
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
              <div class="score-detail-results-footer-row">
                <button type="button" class="btn btn-secondary score-detail-save-to-workspace" id="score-detail-save-to-workspace" title="Save comparison table as a new dataset in workspace">Save to workspace</button>
                <div class="score-detail-results-footer-right">
                  <div class="score-detail-llm-row">
                    <select id="score-detail-llm-select" class="credentials-select score-detail-llm-select" aria-label="Select model"></select>
                  </div>
                  <button type="button" class="btn btn-primary score-detail-add-prompt-review" id="score-detail-add-prompt-review" title="Add a Review node and run analysis with the selected model">Review</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const scoreDetailPanel = overlay.querySelector('#score-detail-panel');
  const pickerEl = overlay.querySelector('#score-detail-gt-picker');
  const triggerEl = overlay.querySelector('.run-detail-ws-trigger');
  const triggerColorEl = overlay.querySelector('#score-detail-gt-trigger-color');
  const triggerTextEl = overlay.querySelector('#score-detail-gt-trigger-text');
  const dropdownEl = overlay.querySelector('#score-detail-gt-dropdown');
  const rulesListEl = overlay.querySelector('#score-detail-rules-list');
  const llmSelect = overlay.querySelector('#score-detail-llm-select');
  const saveToWorkspaceBtn = overlay.querySelector('#score-detail-save-to-workspace');
  const addPromptReviewBtn = overlay.querySelector('#score-detail-add-prompt-review');
  const resultsBody = overlay.querySelector('#score-detail-results-body');
  const resultsToolbar = overlay.querySelector('#score-detail-results-toolbar');

  /** 有对比结果时展开右半栏（与 Run 页初始状态一致：无结果时只显示左半栏） */
  function updatePanelExpanded(hasResults) {
    if (!scoreDetailPanel) return;
    if (hasResults) scoreDetailPanel.classList.add('score-detail-panel--expanded');
    else scoreDetailPanel.classList.remove('score-detail-panel--expanded');
  }

  const scoreDetailPagination = { rowsPerPage: 25, currentPage: 1, searchQuery: '' };

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
      triggerTextEl.textContent = selectPlaceholderLabel('Select');
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

  /** Open Add rule / Edit rule modal. editPath = path to rule (edit), or null for add. When add: parentPath + indexInParent. */
  function openRuleEditor(editPath, parentPath, indexInParent, onDone) {
    const isEdit = Array.isArray(editPath) && editPath.length > 0;
    /** Same scope as make-group / add-as-group: root list only (not inside a rule group). Use Edit Rule group for groups. */
    const showRowGroupKeyUi = (isEdit && editPath.length <= 1) || (!isEdit && (!parentPath || parentPath.length === 0));
    const root = getRoot();
    const defaultRule = { type: 'rule', outputKey: '', gtColumns: [], matchType: 'exact', matchFlags: { ...DEFAULT_MATCH_FLAGS } };
    const rule = isEdit ? getNodeAtPath(root, editPath) : defaultRule;
    let ruleData = rule && rule.type === 'rule' ? rule : defaultRule;
    const runColumns = getRunResultColumns();
    const gtHeaders = getGroundTruthHeaders(selectedNodeId);
    if (!isEdit && (!(ruleData.outputKey || '').trim() || !(ruleData.gtColumns || []).length)) {
      const runKeys = new Set((runColumns || []).map((c) => (c.key || '').trim()).filter(Boolean));
      const gtSet = new Set(gtHeaders || []);
      for (const key of Object.keys(ruleEditorMemory)) {
        const idx = key.indexOf('\t');
        if (idx <= 0) continue;
        const outputKey = key.slice(0, idx);
        const gtColumn = key.slice(idx + 1);
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
    const resultSelectOpts = runColumns.map((c) => {
      const label = (c.label || '').trim() || c.key || '—';
      const key = c.key || '';
      const sel = key === (ruleData.outputKey || '') ? ' selected' : '';
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
    const defaultGtColumn = currentGtColumn || ((gtHeaders && gtHeaders[0]) ? gtHeaders[0] : '');
    const gtSelectOpts = (gtHeaders || []).map((h) => {
      const sel = h === defaultGtColumn ? ' selected' : '';
      return `<option value="${escapeAttr(h)}"${sel}>${escapeHtml(h)}</option>`;
    }).join('');
    const gtSelectEmptyOpt = (gtHeaders && gtHeaders.length > 0) ? '' : `<option value="">${escapeHtml(selectPlaceholderLabel('Select column'))}</option>`;

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
              <label class="dataset-meta-label" for="rule-editor-result-column">Result column</label>
              <select id="rule-editor-result-column" class="dataset-meta-input rule-editor-select" aria-label="Result column">${resultSelectOpts}</select>
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
                <label class="dataset-meta-label" for="rule-editor-numeric-abs">ε: max absolute gap (result vs ground truth)</label>
                <input type="text" id="rule-editor-numeric-abs" class="dataset-meta-input" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="e.g. 0.01 or 1e-3" value="${escapeAttr(String(flags.numericAbsEpsilon))}" aria-describedby="rule-editor-numeric-abs-hint" aria-label="Absolute tolerance epsilon" />
                <p class="rule-editor-hint" id="rule-editor-numeric-abs-hint">Rows match when <strong>|result - ground truth| ≤ ε</strong>. Use any decimal (e.g. <code>0.05</code>, <code>0.001</code>). ε = 0 means exact numeric equality.</p>
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
            ${isEdit && editPath.length <= 1 ? `
            <div class="dataset-meta-field rule-editor-field-group">
              <label class="dataset-meta-label rule-editor-checkbox-label">
                <input type="checkbox" id="rule-editor-make-group" class="rule-editor-checkbox" aria-label="Make this a rule group">
                Make this a rule group
              </label>
              <p class="rule-editor-hint">Turning this on replaces this rule with a group that contains it (this dialog closes). Open the group to add more rules and choose <strong>AND</strong> or <strong>OR</strong> between them—the same as on the Score panel.</p>
            </div>
            ` : (!isEdit && (!parentPath || parentPath.length === 0) ? `
            <div class="dataset-meta-field rule-editor-field-group">
              <label class="dataset-meta-label rule-editor-checkbox-label">
                <input type="checkbox" id="rule-editor-add-as-group" class="rule-editor-checkbox" aria-label="Add as a new group (starts with this rule)">
                Add as a new group (starts with this rule)
              </label>
              <p class="rule-editor-hint">Adds a group that contains only this rule at first. Open the group afterward to add more rules and set <strong>AND</strong> or <strong>OR</strong>.</p>
            </div>
            ` : '')}
            ${showRowGroupKeyUi ? `
            <div class="dataset-meta-field rule-editor-field-group">
              <label class="dataset-meta-label rule-editor-checkbox-label">
                <input type="checkbox" id="rule-editor-row-group-id" class="rule-editor-checkbox" aria-label="Mark this as a shared input key" ${ruleData.rowGroupKey === true ? 'checked' : ''}>
                Mark this as a shared input key
              </label>
              <p class="rule-editor-hint">Use when <strong>one input</strong> lines up with <strong>several ground truth rows</strong>. The <strong>ground truth column(s)</strong> for this rule are the <strong>shared key</strong>: put the <strong>same value</strong> in those cells on every row from that input so the table can group them. <strong>Only one rule</strong> in this score can be marked this way.</p>
            </div>
            ` : ''}
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
        showError('Please select a result column.');
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
      const rowGroupIdEl = editorOverlay.querySelector('#rule-editor-row-group-id');
      const wantRowGroupId = showRowGroupKeyUi && !!(rowGroupIdEl && rowGroupIdEl.checked);
      const newRule = { type: 'rule', outputKey, gtColumns: [gtColumn], matchType, matchFlags: canonicalizeMatchFlags(matchFlags) };
      if (wantRowGroupId) newRule.rowGroupKey = true;
      return newRule;
    }

    function persistEdit() {
      if (!isEdit) return;
      const newRule = buildNewRuleFromForm();
      if (!newRule) return;
      clearError();
      let nextRoot = stripAllRowGroupKeys(getRoot());
      const makeGroupEl = editorOverlay.querySelector('#rule-editor-make-group');
      const makeGroup = !!(makeGroupEl && makeGroupEl.checked);
      if (makeGroup) {
        setRoot(setNodeAtPath(nextRoot, editPath, { type: 'group', ops: [], children: [newRule] }));
        closeEditor();
        onDone();
        return;
      }
      setRoot(setNodeAtPath(nextRoot, editPath, newRule));
      onDone();
    }

    function persistAdd() {
      if (isEdit) return;
      const newRule = buildNewRuleFromForm();
      if (!newRule) return;
      clearError();
      let nextRoot = stripAllRowGroupKeys(getRoot());
      const addAsGroupEl = editorOverlay.querySelector('#rule-editor-add-as-group');
      const addAsGroup = !!(addAsGroupEl && addAsGroupEl.checked);
      if (addAsGroup) {
        setRoot(insertChildAtPath(nextRoot, parentPath, { type: 'group', ops: [], children: [newRule] }, indexInParent));
      } else {
        setRoot(insertChildAtPath(nextRoot, parentPath, newRule, indexInParent));
      }
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

    editorOverlay.querySelector('#rule-editor-make-group')?.addEventListener('change', () => {
      if (isEdit) persistEdit();
    });
    editorOverlay.querySelector('#rule-editor-row-group-id')?.addEventListener('change', () => {
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

  /** Rule card: optional AND/OR on left (opValue/opIndex), then click to edit, × to delete. */
  function createRuleCard(rule, path, opts = {}) {
    const runColumns = getRunResultColumns();
    const runLabel = runColumns.find((c) => c.key === (rule.outputKey || ''))?.label || rule.outputKey || '—';
    const gtLabel = (rule.gtColumns || []).length === 0 ? '—' : (rule.gtColumns || []).join(', ');
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
    const rowGroupNote = rule.rowGroupKey === true ? ' · Shared input key' : '';
    const summary = `${runLabel} → ${gtLabel} ( ${typeLabel}${flagPart} )${rowGroupNote}`;
    const card = document.createElement('div');
    card.className = 'score-rule-card';
    const onRuleSaved = opts.onRuleSaved || (() => renderRules());
    const openEditor = () => openRuleEditor(path, [], 0, onRuleSaved);
    card.innerHTML = `
      <div class="score-rule-card-inner" tabindex="0" role="button" title="${escapeAttr(summary)}">
        <span class="score-rule-card-summary" title="${escapeAttr(summary)}">${escapeHtml(summary)}</span>
      </div>
      <button type="button" class="score-rule-card-remove" aria-label="Remove rule">×</button>
    `;
    const parentPathForOp = opts.parentPath !== undefined ? opts.parentPath : (path.length > 0 ? path.slice(0, -1) : []);
    if (opts.opValue != null && opts.opIndex != null) {
      const opBtn = document.createElement('button');
      opBtn.type = 'button';
      opBtn.className = 'score-rule-card-op';
      opBtn.setAttribute('aria-label', 'Toggle AND/OR');
      opBtn.textContent = opts.opValue || 'AND';
      opBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = getRoot();
        const parent = parentPathForOp.length > 0 ? getNodeAtPath(r, parentPathForOp) : r;
        if (!parent || parent.type !== 'group') return;
        const nextOps = (parent.ops || []).slice();
        nextOps[opts.opIndex] = nextOps[opts.opIndex] === 'OR' ? 'AND' : 'OR';
        setRoot(setNodeAtPath(r, parentPathForOp, { ...parent, ops: nextOps }));
        renderRules();
        if (opts.onAfterChange) opts.onAfterChange();
      });
      card.insertBefore(opBtn, card.firstChild);
    }
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
      setRoot(removeNodeAtPath(getRoot(), path));
      renderRules();
      if (opts.onAfterChange) opts.onAfterChange();
    });
    return card;
  }

  /** Group card: same look as rule card, shows "Rule group N". Click to edit group. */
  function createGroupCard(path, groupIndex, opts = {}) {
    const label = `Rule group ${groupIndex}`;
    const card = document.createElement('div');
    card.className = 'score-rule-card score-rule-card--group';
    const openGroupEditor = () => openGroupEditorModal(path, () => renderRules());
    card.innerHTML = `
      <div class="score-rule-card-inner" tabindex="0" role="button">
        <span class="score-rule-card-summary">${escapeHtml(label)}</span>
      </div>
      <button type="button" class="score-rule-card-remove" aria-label="Remove group">×</button>
    `;
    if (opts.opValue != null && opts.opIndex != null) {
      const opBtn = document.createElement('button');
      opBtn.type = 'button';
      opBtn.className = 'score-rule-card-op';
      opBtn.setAttribute('aria-label', 'Toggle AND/OR');
      opBtn.textContent = opts.opValue || 'AND';
      opBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = getRoot();
        const nextOps = (r.ops || []).slice();
        nextOps[opts.opIndex] = nextOps[opts.opIndex] === 'OR' ? 'AND' : 'OR';
        setRoot({ ...r, ops: nextOps });
        renderRules();
      });
      card.insertBefore(opBtn, card.firstChild);
    }
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
      setRoot(removeNodeAtPath(getRoot(), path));
      renderRules();
    });
    return card;
  }

  /** Modal to edit a group's rules (same UI as score rules list). */
  function openGroupEditorModal(groupPath, onDone) {
    const root = getRoot();
    const group = getNodeAtPath(root, groupPath);
    if (!group || group.type !== 'group') return;
    const firstIndex = groupPath[0];
    const groupIndex = (root.children || []).slice(0, firstIndex + 1).filter((c) => c && c.type === 'group').length;
    const title = `Edit Rule group ${groupIndex}`;
    const showRowGroupInGroupEditor = groupPath.length === 1;
    const rowGroupInitiallyOn = showRowGroupInGroupEditor && (group.children || []).some((c) => c && c.type === 'rule' && c.rowGroupKey === true);
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
          ${showRowGroupInGroupEditor ? `
          <div class="dataset-meta-field rule-editor-field-group score-group-editor-rowgroup">
            <label class="dataset-meta-label rule-editor-checkbox-label">
              <input type="checkbox" id="score-group-row-group-cb" class="rule-editor-checkbox" aria-label="Mark this as a shared input key" ${rowGroupInitiallyOn ? 'checked' : ''}>
              Mark this as a shared input key
            </label>
            <p class="rule-editor-hint">Use when <strong>one input</strong> lines up with <strong>several ground truth rows</strong>. The <strong>ground truth column(s)</strong> on the rules above are the <strong>shared key</strong>: put the <strong>same value</strong> in those cells on every row from that input so the table can group them. <strong>Only one rule</strong> in this score can be marked this way.</p>
          </div>
          ` : ''}
        </div>
      </div>
    `;
    const listEl = overlay.querySelector('#score-group-editor-list');
    const addBtn = overlay.querySelector('#score-group-editor-add-rule');

    function getGroup() {
      return getNodeAtPath(getRoot(), groupPath) || { type: 'group', ops: [], children: [] };
    }

    function setGroup(newGroup) {
      setRoot(setNodeAtPath(getRoot(), groupPath, newGroup));
      renderGroupEditorList();
    }

    function renderGroupEditorList() {
      listEl.innerHTML = '';
      const g = getGroup();
      const children = (g.children || []).slice();
      const ops = (g.ops || []).slice();
      const onAfterChange = () => {
        renderGroupEditorList();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      };
      children.forEach((node, i) => {
        if (node.type === 'rule') {
          const row = document.createElement('div');
          row.className = 'score-tree-row score-tree-row--flat';
          const cardWrap = document.createElement('div');
          cardWrap.className = 'score-tree-row-card';
          const pathI = groupPath.concat(i);
          const cardOpts = i > 0 ? { opValue: ops[i - 1] || 'AND', opIndex: i - 1 } : {};
          cardOpts.onAfterChange = onAfterChange;
          cardOpts.parentPath = groupPath;
          cardOpts.onRuleSaved = () => {
            renderGroupEditorList();
            renderRules();
            document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
          };
          cardWrap.appendChild(createRuleCard(node, pathI, cardOpts));
          row.appendChild(cardWrap);
          listEl.appendChild(row);
        }
      });
      const rgCb = overlay.querySelector('#score-group-row-group-cb');
      if (rgCb) {
        const g = getGroup();
        rgCb.checked = (g.children || []).some((c) => c && c.type === 'rule' && c.rowGroupKey === true);
      }
    }

    addBtn.addEventListener('click', () => {
      openRuleEditor(null, groupPath, (getGroup().children || []).length, () => {
        renderGroupEditorList();
        renderRules();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      });
    });

    const rowGroupCb = overlay.querySelector('#score-group-row-group-cb');
    if (rowGroupCb) {
      rowGroupCb.addEventListener('change', () => {
        const on = rowGroupCb.checked;
        let nextRoot = getRoot();
        if (on) {
          nextRoot = stripAllRowGroupKeys(nextRoot);
          const g = getNodeAtPath(nextRoot, groupPath);
          if (!g || g.type !== 'group') return;
          const children = (g.children || []).slice();
          const idx = children.findIndex((c) => c && c.type === 'rule');
          if (idx < 0) {
            rowGroupCb.checked = false;
            return;
          }
          children[idx] = { ...children[idx], rowGroupKey: true };
          nextRoot = setNodeAtPath(nextRoot, groupPath, { ...g, children });
        } else {
          const g = getNodeAtPath(nextRoot, groupPath);
          if (!g || g.type !== 'group') return;
          const children = (g.children || []).map((c) => {
            if (c && c.type === 'rule') {
              const nr = { ...c };
              delete nr.rowGroupKey;
              return nr;
            }
            return c;
          });
          nextRoot = setNodeAtPath(nextRoot, groupPath, { ...g, children });
        }
        setRoot(nextRoot);
        renderGroupEditorList();
        renderRules();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      });
    }

    overlay.querySelector('.modal-close').addEventListener('click', () => {
      overlay.remove();
      onDone();
    });
    renderGroupEditorList();
    document.body.appendChild(overlay);
  }

  function renderRules() {
    rulesListEl.innerHTML = '';

    if (!selectedNodeId) {
      const p = document.createElement('p');
      p.className = 'score-detail-placeholder';
      p.textContent = 'Select a dataset as ground truth, then add rules. Click a rule to edit; use AND/OR to combine.';
      rulesListEl.appendChild(p);
      void renderResults();
      return;
    }
    const runColumns = getRunResultColumns();
    const gtHeaders = getGroundTruthHeaders(selectedNodeId);
    if (runColumns.length === 0 || gtHeaders.length === 0) {
      const p = document.createElement('p');
      p.className = 'score-detail-placeholder';
      p.textContent = runColumns.length === 0
        ? 'No run connected or run has no result columns (run once with a dataset to see columns).'
        : 'Ground truth dataset has no columns.';
      rulesListEl.appendChild(p);
      void renderResults();
      return;
    }

    const root = getRoot();
    if (root.type !== 'group' || !Array.isArray(root.children)) {
      void renderResults();
      return;
    }
    const children = root.children || [];
    const ops = root.ops || Array(Math.max(0, children.length - 1)).fill('AND');
    let groupCount = 0;

    const treeWrap = document.createElement('div');
    treeWrap.className = 'score-rules-tree score-rules-tree--flat';
    children.forEach((node, i) => {
      const row = document.createElement('div');
      row.className = 'score-tree-row score-tree-row--flat';
      const cardWrap = document.createElement('div');
      cardWrap.className = 'score-tree-row-card';
      const cardOpts = i > 0 ? { opValue: ops[i - 1] || 'AND', opIndex: i - 1 } : {};
      if (node.type === 'group') {
        groupCount += 1;
        cardWrap.appendChild(createGroupCard([i], groupCount, cardOpts));
      } else {
        cardWrap.appendChild(createRuleCard(node, [i], cardOpts));
      }
      row.appendChild(cardWrap);
      treeWrap.appendChild(row);
    });
    const addRow = document.createElement('div');
    addRow.className = 'score-tree-add-row score-tree-row--flat';
    const addBox = document.createElement('button');
    addBox.type = 'button';
    addBox.className = 'score-tree-add-rule-box';
    addBox.setAttribute('aria-label', 'Add rule');
    addBox.textContent = '+ Add rule';
    addBox.addEventListener('click', () => {
      const r = getRoot();
      const len = (r.children || []).length;
      openRuleEditor(null, [], len, () => renderRules());
    });
    const cardWrap = document.createElement('div');
    cardWrap.className = 'score-tree-row-card';
    cardWrap.appendChild(addBox);
    addRow.appendChild(cardWrap);
    treeWrap.appendChild(addRow);
    rulesListEl.appendChild(treeWrap);
    void renderResults();
  }

  async function renderResults() {
    if (!resultsBody) return;
    const prevScrollEl = resultsBody.querySelector('.score-detail-results-table-scroll');
    const savedScrollTop = prevScrollEl?.scrollTop ?? 0;
    const savedScrollLeft = prevScrollEl?.scrollLeft ?? 0;
    resultsBody.innerHTML = '';
    const root = getRoot();
    const rulesFlat = getRulesFlat();
    if (!selectedNodeId) {
      updatePanelExpanded(false);
      resultsBody.innerHTML = '<p class="score-detail-placeholder">Select ground truth and add rules to see comparison results.</p>';
      if (resultsToolbar) { resultsToolbar.style.display = 'none'; resultsToolbar.innerHTML = ''; }
      return;
    }
    if (rulesFlat.length === 0) {
      updatePanelExpanded(false);
      resultsBody.innerHTML = '<p class="score-detail-placeholder">Add at least one rule to compare.</p>';
      if (resultsToolbar) { resultsToolbar.style.display = 'none'; resultsToolbar.innerHTML = ''; }
      return;
    }
    const { results: rawResults, outputFields } = getRunResults();
    const runWs = getRunWorkingSetContent();
    const rawGtContent = getGroundTruthContent(selectedNodeId);
    const runColumns = getRunResultColumns();

    const gtColsUsed = [];
    const outputKeysUsed = [];
    for (const r of rulesFlat) {
      for (const c of (r.gtColumns || [])) {
        if (c && !gtColsUsed.includes(c)) gtColsUsed.push(c);
      }
      const k = (r.outputKey || '').trim();
      if (k && !outputKeysUsed.includes(k)) outputKeysUsed.push(k);
    }

    const resultsForScore = (rawResults || []).filter((r) => r);
    const gtContent = deduplicateGtRows(rawGtContent, gtColsUsed);
    const results = deduplicateResults(resultsForScore, outputKeysUsed, runWs, outputFields).filter((r) =>
      isValidRunOutputForScoreRow(r, outputFields),
    );
    const gtHeaders = gtContent.headers || [];
    const gtRows = gtContent.rows || [];
    const resultsByIndex = new Map();
    (results || []).forEach((r) => { resultsByIndex.set(r.row_index, r); });
    const runRowIndices = [...new Set((results || []).map((r) => r.row_index))];
    const maxRunRow = runRowIndices.length ? Math.max(...runRowIndices) : -1;
    const maxGtRow = gtRows.length ? gtRows.length - 1 : -1;
    const hasAnyRows = maxRunRow >= 0 || maxGtRow >= 0;

    if (!hasAnyRows) {
      updatePanelExpanded(false);
      resultsBody.innerHTML = '<p class="score-detail-placeholder">No run results and no ground truth rows.</p>';
      if (resultsToolbar) { resultsToolbar.style.display = 'none'; resultsToolbar.innerHTML = ''; }
      return;
    }

    updatePanelExpanded(true);
    scoreEmbeddingCosineMap = new Map();
    if (rulesFlat.some((r) => getMatchFlags(r).embeddingSimilarity)) {
      try {
        scoreEmbeddingCosineMap = await prefetchEmbeddingCosineMap(API_BASE, {
          root, results, outputFields, runWs, gtContent, getRunValue, getGtValue,
        });
      } catch (e) {
        showAlert(String(e?.message || e), { title: 'Embedding comparison failed' });
        scoreEmbeddingCosineMap = new Map();
      }
    }
    const { runToGt, total: runCount, matchedCount } = computeMatchPerRow(root, results, outputFields, runWs, gtContent);
    const gtToRun = new Array(gtRows.length).fill(-1);
    for (let i = 0; i < (runToGt || []).length; i++) {
      if (runToGt[i] >= 0) gtToRun[runToGt[i]] = i;
    }

    const descriptors = [];
    for (let j = 0; j < gtRows.length; j++) {
      if (gtToRun[j] >= 0) descriptors.push({ type: 'gt', j });
    }
    for (let j = 0; j < gtRows.length; j++) {
      if (gtToRun[j] < 0) descriptors.push({ type: 'gt', j });
    }
    for (const i of runRowIndices) {
      const paired = i < (runToGt || []).length && runToGt[i] >= 0;
      if (paired) continue;
      let matchesAnyGt = false;
      for (let j = 0; j < gtRows.length; j++) {
        if (evaluateNode(root, i, j, resultsByIndex, runWs, outputFields, gtContent)) {
          matchesAnyGt = true;
          break;
        }
      }
      if (!matchesAnyGt) descriptors.push({ type: 'runOnly', i });
    }

    const rowGroupRule = rulesFlat.find((r) => r && r.rowGroupKey === true) || null;
    function gtOneToManyGroupKey(j) {
      if (!rowGroupRule) return '';
      const cols = (rowGroupRule.gtColumns || []).filter(Boolean);
      if (cols.length === 0) return `\0${j}`;
      return cols.map((c) => String(getGtValue(gtContent, j, c) ?? '')).join('\u0001');
    }
    if (rowGroupRule) {
      const gtDesc = descriptors.filter((d) => d.type === 'gt');
      const runOnlyDesc = descriptors.filter((d) => d.type === 'runOnly');
      gtDesc.sort((a, b) => {
        const ka = gtOneToManyGroupKey(a.j);
        const kb = gtOneToManyGroupKey(b.j);
        if (ka !== kb) return ka < kb ? -1 : 1;
        return a.j - b.j;
      });
      descriptors.length = 0;
      descriptors.push(...gtDesc, ...runOnlyDesc);
    }

    const q = (scoreDetailPagination.searchQuery || '').trim().toLowerCase();
    function getRowStringsForSearch(d) {
      const parts = [];
      if (d.type === 'gt') {
        const j = d.j;
        const runRowIndex = gtToRun[j];
        const runResult = runRowIndex >= 0 ? resultsByIndex.get(runRowIndex) || null : null;
        parts.push(String(j + 1), runRowIndex >= 0 ? String(runRowIndex + 1) : '—');
        gtColsUsed.forEach((col) => { parts.push(getGtValue(gtContent, j, col)); });
        outputKeysUsed.forEach((outputKey) => {
          parts.push(runResult ? getRunValue(runResult, outputKey, runRowIndex, runWs, outputFields) : '');
        });
        parts.push(runRowIndex >= 0 && evaluateNode(root, runRowIndex, j, resultsByIndex, runWs, outputFields, gtContent) ? 'true' : 'false');
        parts.push(isScoreRowExcludedFromScoring(String(j)) ? 'false' : 'true');
      } else {
        const i = d.i;
        const runResult = resultsByIndex.get(i) || null;
        parts.push('—', String(i + 1));
        gtColsUsed.forEach(() => { parts.push('—'); });
        outputKeysUsed.forEach((outputKey) => { parts.push(runResult ? getRunValue(runResult, outputKey, i, runWs, outputFields) : ''); });
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
      if (runRowIndex >= 0 && evaluateNode(root, runRowIndex, j, resultsByIndex, runWs, outputFields, gtContent)) tp++;
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
        if (runRowIndex >= 0 && evaluateNode(root, runRowIndex, j, resultsByIndex, runWs, outputFields, gtContent)) tpN++;
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
        <label class="dataset-detail-search-label" for="score-detail-results-search">Search</label>
        <input type="text" id="score-detail-results-search" class="dataset-detail-input dataset-detail-preview-search-inp" placeholder="Filter rows by cell content..." aria-label="Search in table" value="${escapeAttr(scoreDetailPagination.searchQuery)}" />
      </div>
    `;
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

    const runColLabels = outputKeysUsed.map((k) => (runColumns.find((c) => c.key === k)?.label || k || '—').trim() || '—');

    let headerRow = '<thead><tr><th class="score-detail-results-th score-detail-results-th--idx score-detail-results-th--row-num" title="Row number">#</th><th class="score-detail-results-th score-detail-results-th--idx score-detail-results-th--gt-block score-detail-results-th--block-sep" title="Ground truth row index">Ground truth #</th>';
    if (gtColsUsed.length > 0) {
      gtColsUsed.forEach((col) => { headerRow += `<th class="score-detail-results-th score-detail-results-th--gt score-detail-results-th--gt-block">${escapeHtml(col)}</th>`; });
    } else {
      headerRow += '<th class="score-detail-results-th score-detail-results-th--gt score-detail-results-th--gt-block">Ground truth</th>';
    }
    headerRow += '<th class="score-detail-results-th score-detail-results-th--idx score-detail-results-th--run-block score-detail-results-th--block-sep" title="Run result row index (matched to this ground truth row)">Run result #</th>';
    runColLabels.forEach((label) => { headerRow += `<th class="score-detail-results-th score-detail-results-th--run score-detail-results-th--run-block">${escapeHtml(label)}</th>`; });
    headerRow += '<th class="score-detail-results-th score-detail-results-th--match score-detail-results-th--result-block score-detail-results-th--block-sep">Match</th><th class="score-detail-results-th score-detail-results-th--review score-detail-results-th--result-block" title="Include in Review API and in Precision / Recall / F1"><label class="score-detail-results-review-th-label"><span>Review</span><input type="checkbox" class="score-detail-results-review-master-cb" aria-label="Select or clear all Review checkboxes (all rows)" /></label></th></tr></thead><tbody>';
    const tableWrap = document.createElement('div');
    tableWrap.className = 'score-detail-results-table-wrap';
    const tbl = document.createElement('table');
    tbl.className = 'score-detail-results-table run-detail-results-table';
    tbl.innerHTML = headerRow;
    const tbody = tbl.querySelector('tbody');

    function appendGtRow(j, rowNum, extraTrClass = '') {
      const runRowIndex = gtToRun[j];
      const runResult = runRowIndex >= 0 ? resultsByIndex.get(runRowIndex) || null : null;
      const isMatch = runRowIndex >= 0 && evaluateNode(root, runRowIndex, j, resultsByIndex, runWs, outputFields, gtContent);
      const rowClass = isMatch ? 'score-detail-results-tr--match' : 'score-detail-results-tr--unmatch';
      const runNum = runRowIndex >= 0 ? String(runRowIndex + 1) : '—';
      const rowKey = String(j);
      const trClasses = `score-detail-results-tr ${rowClass}${extraTrClass ? ` ${extraTrClass}` : ''}`;
      let tr = `<tr class="${trClasses}" data-score-row-key="${escapeAttr(rowKey)}"><td class="score-detail-results-td score-detail-results-td--row-num" title="Row ${rowNum}">${rowNum}</td><td class="score-detail-results-td score-detail-results-td--idx score-detail-results-td--block-sep" title="Ground truth row ${j + 1}">${j + 1}</td>`;
      if (gtColsUsed.length > 0) {
        gtColsUsed.forEach((col) => {
          const val = getGtValue(gtContent, j, col);
          tr += `<td class="score-detail-results-td score-detail-results-td--gt" title="${escapeAttr(val)}">${escapeHtml(cellText(val))}</td>`;
        });
      } else {
        tr += '<td class="score-detail-results-td score-detail-results-td--gt">—</td>';
      }
      tr += `<td class="score-detail-results-td score-detail-results-td--idx score-detail-results-td--block-sep" title="${runRowIndex >= 0 ? 'Run result row ' + (runRowIndex + 1) : 'No match'}">${runNum}</td>`;
      for (const outputKey of outputKeysUsed) {
        const runVal = runResult ? getRunValue(runResult, outputKey, runRowIndex, runWs, outputFields) : null;
        tr += `<td class="score-detail-results-td score-detail-results-td--run" title="${escapeAttr(runVal)}">${escapeHtml(cellText(runVal))}</td>`;
      }
      tr += `<td class="score-detail-results-td score-detail-results-td--match score-detail-results-td--block-sep" aria-label="${isMatch ? 'Matched' : 'Not matched'}">${isMatch ? 'true' : 'false'}</td>`;
      tr += '<td class="score-detail-results-td score-detail-results-td--review"></td></tr>';
      tbody.insertAdjacentHTML('beforeend', tr);
    }

    function appendRunOnlyRow(i, rowNum) {
      const runResult = resultsByIndex.get(i) || null;
      const rowClass = 'score-detail-results-tr--run-only';
      const rowKey = 'run:' + i;
      let tr = `<tr class="score-detail-results-tr ${rowClass}" data-score-row-key="${escapeAttr(rowKey)}"><td class="score-detail-results-td score-detail-results-td--row-num" title="Row ${rowNum}">${rowNum}</td><td class="score-detail-results-td score-detail-results-td--idx score-detail-results-td--block-sep" title="No ground truth row">—</td>`;
      if (gtColsUsed.length > 0) {
        gtColsUsed.forEach(() => { tr += '<td class="score-detail-results-td score-detail-results-td--gt">—</td>'; });
      } else {
        tr += '<td class="score-detail-results-td score-detail-results-td--gt">—</td>';
      }
      tr += `<td class="score-detail-results-td score-detail-results-td--idx score-detail-results-td--block-sep" title="Run result row ${i + 1}">${i + 1}</td>`;
      for (const outputKey of outputKeysUsed) {
        const runVal = runResult ? getRunValue(runResult, outputKey, i, runWs, outputFields) : '';
        tr += `<td class="score-detail-results-td score-detail-results-td--run" title="${escapeAttr(runVal)}">${escapeHtml(cellText(runVal))}</td>`;
      }
      tr += '<td class="score-detail-results-td score-detail-results-td--match score-detail-results-td--block-sep" aria-label="Run result row without ground truth match">false</td>';
      tr += '<td class="score-detail-results-td score-detail-results-td--review"></td></tr>';
      tbody.insertAdjacentHTML('beforeend', tr);
    }

    /** Shared input key: 0-based group index in filtered GT order (rows with same gt key share one index). */
    function oneToManyGroupBand(globalIdx) {
      if (!rowGroupRule) return null;
      const d = filteredDescriptors[globalIdx];
      if (!d || d.type !== 'gt') return null;
      let band = 0;
      let prevGk = null;
      for (let k = 0; k <= globalIdx; k++) {
        const dk = filteredDescriptors[k];
        if (dk.type !== 'gt') continue;
        const gk = gtOneToManyGroupKey(dk.j);
        if (prevGk !== null && gk !== prevGk) band++;
        prevGk = gk;
      }
      return band;
    }

    let rowNum = start + 1;
    for (let idx = 0; idx < pageDescriptors.length; idx++) {
      const d = pageDescriptors[idx];
      if (d.type === 'gt') {
        let extraTrClass = '';
        if (rowGroupRule) {
          const band = oneToManyGroupBand(start + idx);
          if (band !== null) {
            extraTrClass = `score-detail-results-tr--one-to-many-pal-${band % 2}`;
          }
        }
        appendGtRow(d.j, rowNum++, extraTrClass);
      } else {
        appendRunOnlyRow(d.i, rowNum++);
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
    if (!addPromptReviewBtn) return;
    const payload = await Promise.resolve(getReviewPayload());
    addPromptReviewBtn.disabled = !payload || !payload.prompt_sections || payload.prompt_sections.length === 0 || !selectedNodeId;
    await updateSaveToWorkspaceButton();
  }

  async function loadReviewCredentials() {
    try {
      const [list, settings] = await Promise.all([
        fetch(`${API_BASE}/api/credentials`).then((r) => r.ok ? r.json() : []),
        fetch(`${API_BASE}/api/settings`).then((r) => r.ok ? r.json() : null),
      ]);
      llmSelect.innerHTML = `<option value="">${escapeHtml(selectPlaceholderLabel('Select model'))}</option>` + (list || []).map((c) => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.name || c.llm || '')}</option>`).join('');
      let credentialId = (node?.dataset?.reviewCredentialId || '').trim();
      if (!credentialId && settings) {
        const defaultId = (settings.default_review_credential_id || '').trim();
        if (defaultId && (list || []).some((c) => c.id === defaultId)) credentialId = defaultId;
      }
      if (credentialId) {
        llmSelect.value = credentialId;
        if (node) node.dataset.reviewCredentialId = credentialId;
      }
    } catch (_) {}
    void updateReviewButtonState();
  }

  async function updateSaveToWorkspaceButton() {
    if (!saveToWorkspaceBtn) return;
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
      const payload = await getScoreExportData({ node, getRunResults, getRunWorkingSetContent, getGroundTruthContent, getGroundTruthHeaders, getRunResultColumns });
      if (!payload || !payload.headers || !payload.rows) return;
      const scoreName = (node?.querySelector?.('.workflow-node__title')?.textContent || '').trim() || 'Score';
      document.dispatchEvent(new CustomEvent('workflow:score-export-to-workspace', {
        detail: { scoreNodeId: node?.dataset?.nodeId || '', scoreName, headers: payload.headers, rows: payload.rows },
      }));
    });
  }

  addPromptReviewBtn.addEventListener('click', async () => {
    const scoreNodeId = node?.dataset?.nodeId || '';
    if (!scoreNodeId) return;
    const credentialId = (llmSelect?.value || '').trim();
    if (!credentialId) {
      showAlert('Please select a model first.', { title: 'No model selected' });
      return;
    }
    const payload = await Promise.resolve(getReviewPayload());
    if (!payload || !payload.prompt_sections || !payload.prompt_sections.length) return;
    const addEvent = new CustomEvent('workflow:add-prompt-review-node', { detail: { scoreNodeId } });
    document.dispatchEvent(addEvent);
    const reviewNodeId = addEvent.detail?.reviewNodeId || '';
    close();
    if (reviewNodeId) await runReviewStart({ reviewNodeId, payload, credentialId, registerPendingReview: addEvent.detail?.registerPendingReview });
  });

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
    const runKeys = new Set((runColumns || []).map((c) => (c.key || '').trim()).filter(Boolean));
    const gtSet = new Set(gtHeaders || []);
    const existingSet = new Set();
    collectRulesFlat(getRoot()).forEach(({ rule: r }) => {
      const ok = (r.outputKey || '').trim();
      (r.gtColumns || []).forEach((gc) => {
        const g = String(gc || '').trim();
        if (ok && g) existingSet.add(ok + '\t' + g);
      });
    });
    let root = getRoot();
    let added = false;

    for (const item of ruleEditorMemoryOrdered || []) {
      if (item.type === 'group') {
        const filtered = filterGroupForApply(item, runKeys, gtSet, existingSet);
        if (!filtered) continue;
        root = insertChildAtPath(root, [], filtered, (root.children || []).length);
        added = true;
      } else if (item.type === 'rule') {
        const outputKey = (item.outputKey || '').trim();
        const cols = (item.gtColumns || []).map((c) => String(c || '').trim()).filter((c) => runKeys.has(outputKey) && gtSet.has(c) && !existingSet.has(outputKey + '\t' + c));
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
        root = insertChildAtPath(root, [], newRule, (root.children || []).length);
        added = true;
      }
    }
    if (added) setRoot(root);
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
    closeDropdown();
    dropdownEl.querySelectorAll('[role="option"]').forEach((o) => o.setAttribute('aria-selected', o.dataset.nodeId === selectedNodeId ? 'true' : 'false'));
    void updateReviewButtonState();
    if (selectedNodeId) {
      const gtSet = new Set(getGroundTruthHeaders(selectedNodeId) || []);
      let root = getRoot();
      const filtered = filterRootByGtHeaders(root, gtSet);
      if (filtered && JSON.stringify(filtered) !== JSON.stringify(root)) {
        setRoot(filtered);
        root = getRoot();
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
    overlay.remove();
    document.body.style.overflow = '';
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);

  updateTriggerDisplay();
  updateScoreNodeBorder();
  renderRules();
  loadReviewCredentials();
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  if (selectedNodeId) {
    const gtSet = new Set(getGroundTruthHeaders(selectedNodeId) || []);
    let root = getRoot();
    const filtered = filterRootByGtHeaders(root, gtSet);
    if (filtered && JSON.stringify(filtered) !== JSON.stringify(root)) {
      setRoot(filtered);
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
 * Column names and order match the Score page display.
 * @param {{ node: HTMLElement, getRunResults: () => { results, outputFields }, getRunWorkingSetContent: () => { headers, rows }, getGroundTruthContent: (wsNodeId: string) => { headers, rows }, getGroundTruthHeaders: (wsNodeId: string) => string[], getRunResultColumns?: () => Array<{ key: string, label: string }> }} options
 * @returns {Promise<{ headers: string[], rows: string[][] } | null>}
 */
export async function getScoreExportData({ node, getRunResults, getRunWorkingSetContent, getGroundTruthContent, getGroundTruthHeaders, getRunResultColumns }) {
  if (!node) return null;
  const selectedNodeId = (node.dataset.scoreGroundTruthId || '').trim();
  if (!selectedNodeId) return null;
  const raw = (node.dataset.scoreMapping || '[]').trim();
  let data;
  try {
    data = JSON.parse(raw || '[]');
  } catch (_) {
    return null;
  }
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
      arr.forEach((r) => { pairs.push({ outputKey: r.outputKey || '', gtColumn: r.gtColumn || '', matchType: r.matchType || 'exact' }); });
    } else if (first && first.rules) {
      arr.forEach((g) => { (g.rules || []).forEach((r) => { pairs.push({ outputKey: r.outputKey || '', gtColumn: r.gtColumn || '', matchType: r.matchType || 'exact' }); }); });
    } else return [];
    const byKey = {};
    pairs.forEach((p) => {
      const raw = p.matchType || 'exact';
      if (!byKey[p.outputKey]) {
        byKey[p.outputKey] = { outputKey: p.outputKey, gtColumns: [], matchType: migrateLegacyMatchType(raw), anyContains: false };
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
  function ensureGroupOps(data, children) {
    const n = (children || []).length;
    const len = Math.max(0, n - 1);
    if (Array.isArray(data.ops) && data.ops.length >= len) return data.ops.slice(0, len).map((o) => (o === 'OR' ? 'OR' : 'AND'));
    return Array(len).fill(data && data.op === 'OR' ? 'OR' : 'AND');
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
      if (c && c.rowGroupKey === true) leaf.rowGroupKey = true;
      return leaf;
    }
    return normalizeGroupChild(c);
  }
  function normalizeGroupChild(c) {
    const children = (c.children || []).map((ch) => (ch && ch.type === 'group') ? normalizeGroupChild(ch) : normalizeChild(ch));
    return { type: 'group', ops: ensureGroupOps(c, children), children };
  }
  function parseRoot() {
    if (data && data.type === 'group' && Array.isArray(data.children)) {
      const children = (data.children || []).map((c) => (c && c.type === 'group') ? normalizeGroupChild(c) : normalizeChild(c));
      return { type: 'group', ops: ensureGroupOps(data, children), children };
    }
    const rules = normalizeToRules(Array.isArray(data) ? data : []);
    const children = rules.map((r) => ({
      type: 'rule',
      outputKey: r.outputKey || '',
      gtColumns: (r.gtColumns || []).slice(),
      matchType: migrateLegacyMatchType(r.matchType || 'exact'),
      matchFlags: { ...DEFAULT_MATCH_FLAGS, ...(r.matchFlags && typeof r.matchFlags === 'object' ? r.matchFlags : {}) },
    }));
    return { type: 'group', ops: Array(Math.max(0, children.length - 1)).fill('AND'), children };
  }
  const root = parseRoot();
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
  const rulesFlat = collectRulesFlat(root).map((x) => x.rule);
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
    const headers = gtContent.headers || [];
    const rows = gtContent.rows || [];
    const colIdx = headers.findIndex((h) => String(h).trim() === String(columnName).trim());
    if (colIdx >= 0 && rows[rowIndex]) return toCompareStr(rows[rowIndex][colIdx]);
    return '';
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
  const countMatchingRules = (r, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent) =>
    collectRulesFlat(r).map((x) => x.rule).filter((rule) => ruleMatchesRow(rule, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent)).length;
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
  const computeMatchPerRow = (r, results, outputFields, runWs, gtContent) => {
    const gtRows = gtContent.rows || [];
    const resultsByIndex = new Map();
    (results || []).forEach((res) => { resultsByIndex.set(res.row_index, res); });
    const runRowIndices = [...new Set((results || []).map((res) => res.row_index))];
    const maxRunRowIndex = runRowIndices.length ? Math.max(...runRowIndices) : -1;
    const gtCount = gtRows.length;
    const runToGtSize = Math.max(maxRunRowIndex + 1, gtCount);
    const runToGt = new Array(runToGtSize).fill(-1);
    const gtUsed = new Array(gtCount).fill(false);
    const pairs = [];
    for (const i of runRowIndices) {
      for (let j = 0; j < gtCount; j++) {
        const score = countMatchingRules(r, i, j, resultsByIndex, runWs, outputFields, gtContent);
        if (score > 0) pairs.push({ i, j, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    for (const { i, j } of pairs) {
      if (runToGt[i] >= 0 || gtUsed[j]) continue;
      runToGt[i] = j;
      gtUsed[j] = true;
    }
    return { runToGt, total: (results || []).length };
  };

  const gtColsUsed = [];
  const outputKeysUsed = [];
  for (const r of rulesFlat) {
    for (const c of (r.gtColumns || [])) {
      if (c && !gtColsUsed.includes(c)) gtColsUsed.push(c);
    }
    const k = (r.outputKey || '').trim();
    if (k && !outputKeysUsed.includes(k)) outputKeysUsed.push(k);
  }

  const { results: rawResults, outputFields } = getRunResults();
  const runWs = getRunWorkingSetContent();
  const rawGtContent = getGroundTruthContent(selectedNodeId);
  const deduplicateGtRows = (gtContent, gtCols) => {
    if (!gtCols || gtCols.length === 0) return gtContent;
    const rows = gtContent.rows || [];
    const seen = new Set();
    const dedupRows = [];
    for (let i = 0; i < rows.length; i++) {
      const key = JSON.stringify(gtCols.map((col) => getGtValue(gtContent, i, col)));
      if (seen.has(key)) continue;
      seen.add(key);
      dedupRows.push(rows[i]);
    }
    return { ...gtContent, rows: dedupRows };
  };
  const deduplicateResults = (results, outputKeys, runWs, outputFields) => {
    if (!outputKeys || outputKeys.length === 0) return results || [];
    const seen = new Set();
    const dedupResults = [];
    for (const res of (results || [])) {
      const key = JSON.stringify([res.row_index, ...outputKeys.map((k) => getRunValue(res, k, res.row_index, runWs, outputFields))]);
      if (seen.has(key)) continue;
      seen.add(key);
      dedupResults.push(res);
    }
    return dedupResults;
  };

  const resultsForScore = (rawResults || []).filter((r) => r);
  const gtContent = deduplicateGtRows(rawGtContent, gtColsUsed);
  const results = deduplicateResults(resultsForScore, outputKeysUsed, runWs, outputFields).filter((r) =>
    isValidRunOutputForScoreRow(r, outputFields),
  );
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
        root, results, outputFields, runWs, gtContent, getRunValue, getGtValue,
      });
    } catch (_) {
      exportEmbeddingCosineMap = new Map();
    }
  }
  const { runToGt } = computeMatchPerRow(root, results, outputFields, runWs, gtContent);
  const gtToRun = new Array(gtRows.length).fill(-1);
  for (let i = 0; i < (runToGt || []).length; i++) {
    if (runToGt[i] >= 0) gtToRun[runToGt[i]] = i;
  }
  const descriptors = [];
  for (let j = 0; j < gtRows.length; j++) {
    if (gtToRun[j] >= 0) descriptors.push({ type: 'gt', j });
  }
  for (let j = 0; j < gtRows.length; j++) {
    if (gtToRun[j] < 0) descriptors.push({ type: 'gt', j });
  }
  for (const i of runRowIndices) {
    const paired = i < (runToGt || []).length && runToGt[i] >= 0;
    if (paired) continue;
    let matchesAnyGt = false;
    for (let j = 0; j < gtRows.length; j++) {
      if (evaluateNode(root, i, j, resultsByIndex, runWs, outputFields, gtContent)) { matchesAnyGt = true; break; }
    }
    if (!matchesAnyGt) descriptors.push({ type: 'runOnly', i });
  }
  const rowGroupRuleExport = rulesFlat.find((r) => r && r.rowGroupKey === true) || null;
  function gtOneToManyGroupKeyExport(j) {
    if (!rowGroupRuleExport) return '';
    const cols = (rowGroupRuleExport.gtColumns || []).filter(Boolean);
    if (cols.length === 0) return `\0${j}`;
    return cols.map((c) => String(getGtValue(gtContent, j, c) ?? '')).join('\u0001');
  }
  if (rowGroupRuleExport) {
    const gtDesc = descriptors.filter((d) => d.type === 'gt');
    const runOnlyDesc = descriptors.filter((d) => d.type === 'runOnly');
    gtDesc.sort((a, b) => {
      const ka = gtOneToManyGroupKeyExport(a.j);
      const kb = gtOneToManyGroupKeyExport(b.j);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a.j - b.j;
    });
    descriptors.length = 0;
    descriptors.push(...gtDesc, ...runOnlyDesc);
  }
  let excludedFromScoring = {};
  try {
    excludedFromScoring = JSON.parse(node.dataset.scoreRowExcludedFromScoring || '{}');
  } catch (_) {}
  const rowIncludedInReview = (key) => !excludedFromScoring[key];
  const runColumns = typeof getRunResultColumns === 'function' ? getRunResultColumns() : [];
  const runLabels = outputKeysUsed.map((k) => (runColumns.find((c) => c.key === k)?.label || k || '—').trim() || '—');
  const headers = ['Ground truth #', ...(gtColsUsed.length > 0 ? gtColsUsed : ['Ground truth']), 'Run result #', ...runLabels, 'Match', 'Review'];
  const rows = descriptors.map((d) => {
    const parts = [];
    if (d.type === 'gt') {
      const j = d.j;
      const runRowIndex = gtToRun[j];
      const runResult = runRowIndex >= 0 ? resultsByIndex.get(runRowIndex) || null : null;
      parts.push(String(j + 1));
      if (gtColsUsed.length === 0) parts.push('—');
      gtColsUsed.forEach((col) => { parts.push(getGtValue(gtContent, j, col)); });
      parts.push(runRowIndex >= 0 ? String(runRowIndex + 1) : '—');
      outputKeysUsed.forEach((outputKey) => { parts.push(runResult ? getRunValue(runResult, outputKey, runRowIndex, runWs, outputFields) : ''); });
      parts.push(runRowIndex >= 0 && evaluateNode(root, runRowIndex, j, resultsByIndex, runWs, outputFields, gtContent) ? 'true' : 'false');
      parts.push(rowIncludedInReview(String(j)) ? 'true' : 'false');
    } else {
      const i = d.i;
      const runResult = resultsByIndex.get(i) || null;
      parts.push('—');
      if (gtColsUsed.length === 0) parts.push('—');
      gtColsUsed.forEach(() => { parts.push('—'); });
      parts.push(String(i + 1));
      outputKeysUsed.forEach((outputKey) => { parts.push(runResult ? getRunValue(runResult, outputKey, i, runWs, outputFields) : ''); });
      parts.push('false');
      parts.push(rowIncludedInReview(`run:${i}`) ? 'true' : 'false');
    }
    return parts.map((v) => (v === null || v === undefined ? '' : String(v)));
  });
  return { headers, rows };
}
