/**
 * Score match primitives: pure, DOM-free comparison functions shared by the Score detail modal
 * (scoreDetailModal.js) and Review's verify/optimize path (scoreOutputGtMatcher.js). Re-exported from
 * scoreDetailModal.js so existing imports keep working unchanged — this file exists so the matching
 * logic can be read, tested, and ported (e.g. to a Python backend implementation) independently of the
 * 4000-line UI module it used to live inside.
 *
 * Keep behavior here byte-for-byte identical to what it was inside scoreDetailModal.js — this is
 * intentionally a pure extraction, not a rewrite.
 */

import { BACKEND_API_BASE } from './backendConfig.js';

export const SCORE_GT_ROW_INDEX_COLUMN = '__score_gt_row_index__';

/**
 * True when this run row should participate in Score / Review pairing and tables.
 * Includes API/runtime errors and empty model output (still comparable via input-column rules and shown in UI).
 */
export function isValidRunOutputForScoreRow(r, outputFields) {
  void outputFields;
  if (!r) return false;
  return typeof r.row_index === 'number' && !Number.isNaN(r.row_index);
}

export const DEFAULT_MATCH_FLAGS = {
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

export function getMatchFlags(rule) {
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
export function normalizeForMatch(str, flags, isNumeric) {
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

/** Cosine threshold for backend FastEmbed (MiniLM) pair similarities; tuned for "close enough" paraphrases. */
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
