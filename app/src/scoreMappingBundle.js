/**
 * Score mapping persistence: v2 bundle `{ v: 2, input, output }` with two rule trees.
 * Legacy single tree / array is migrated to output-only; input is an empty group.
 * No import from scoreDetailModal, to avoid circular deps; match flags come from scoreMatchPrimitives
 * so every flag the rule editor saves (incl. rxnormMatch / meshMatch) survives a reload.
 */

import {
  DEFAULT_MATCH_FLAGS,
  canonicalizeMatchFlags,
  migrateLegacyMatchType,
  legacyMatchTypeWasContains,
} from './scoreMatchPrimitives.js';

export const SCORE_MAPPING_BUNDLE_V = 2;

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

function ensureGroupOps(data, children) {
  const n = (children || []).length;
  const len = Math.max(0, n - 1);
  if (Array.isArray(data.ops) && data.ops.length >= len) {
    return data.ops.slice(0, len).map((o) => (o === 'OR' ? 'OR' : 'AND'));
  }
  const defaultOp = data && data.op === 'OR' ? 'OR' : 'AND';
  return Array(len).fill(defaultOp);
}

function normalizeBundleChild(c) {
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
  return normalizeBundleGroupChild(c);
}

function normalizeBundleGroupChild(c) {
  const children = (c.children || []).map((ch) => (ch && ch.type === 'group') ? normalizeBundleGroupChild(ch) : normalizeBundleChild(ch));
  const ops = ensureGroupOps(c, children);
  const out = { type: 'group', ops, children };
  if (typeof c.groupId === 'number' && Number.isInteger(c.groupId) && c.groupId > 0) {
    out.groupId = c.groupId;
  }
  return out;
}

/**
 * Stable ids for nested `{ type: 'group' }` nodes (not the outer list wrapper). Drag-reorder must not rename groups.
 * Assigns missing positive integers; shared counter across input + output trees so ids stay unique in the bundle.
 */
export function assignMissingScoreGroupIdsAcross(inputRoot, outputRoot) {
  let max = 0;
  function scanChildren(g) {
    if (!g || g.type !== 'group') return;
    for (const c of g.children || []) {
      if (c && c.type === 'group') {
        if (typeof c.groupId === 'number' && Number.isInteger(c.groupId) && c.groupId > 0) {
          max = Math.max(max, c.groupId);
        }
        scanChildren(c);
      }
    }
  }
  scanChildren(inputRoot);
  scanChildren(outputRoot);
  let next = max;
  function fillChildren(g) {
    if (!g || g.type !== 'group') return;
    for (const c of g.children || []) {
      if (c && c.type === 'group') {
        if (!(typeof c.groupId === 'number' && Number.isInteger(c.groupId) && c.groupId > 0)) {
          next += 1;
          c.groupId = next;
        }
        fillChildren(c);
      }
    }
  }
  fillChildren(inputRoot);
  fillChildren(outputRoot);
}

/** Parse a single stored tree (legacy shape). Ids are finalized in {@link assignMissingScoreGroupIdsAcross} on the bundle. */
export function parseScoreTreeOnly(data) {
  if (!data) return emptyScoreRuleGroup();
  if (data.type === 'group' && Array.isArray(data.children)) {
    const children = (data.children || []).map((c) => (c && c.type === 'group') ? normalizeBundleGroupChild(c) : normalizeBundleChild(c));
    const ops = ensureGroupOps(data, children);
    const out = { type: 'group', ops, children };
    if (typeof data.groupId === 'number' && Number.isInteger(data.groupId) && data.groupId > 0) {
      out.groupId = data.groupId;
    }
    return out;
  }
  const rules = normalizeScoreMappingToRules(Array.isArray(data) ? data : []);
  const children = rules.map((r) => ({
    type: 'rule',
    outputKey: r.outputKey || '',
    gtColumns: (r.gtColumns || []).slice(),
    matchType: migrateLegacyMatchType(r.matchType || 'exact'),
    matchFlags: { ...DEFAULT_MATCH_FLAGS, ...(r.matchFlags && typeof r.matchFlags === 'object' ? r.matchFlags : {}) },
  }));
  return { type: 'group', ops: Array(Math.max(0, children.length - 1)).fill('AND'), children };
}

export function emptyScoreRuleGroup() {
  return { type: 'group', ops: [], children: [] };
}

/**
 * @param {string} raw - JSON from node.dataset.scoreMapping
 * @returns {{ inputRoot: object, outputRoot: object }}
 */
export function parseScoreMappingBundle(raw) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
  } catch (_) {
    data = {};
  }
  if (data && data.v === SCORE_MAPPING_BUNDLE_V && data.input && data.output
    && data.input.type === 'group' && data.output.type === 'group') {
    const inputRoot = parseScoreTreeOnly(data.input);
    const outputRoot = parseScoreTreeOnly(data.output);
    assignMissingScoreGroupIdsAcross(inputRoot, outputRoot);
    return { inputRoot, outputRoot };
  }
  const outputRoot = parseScoreTreeOnly(data);
  assignMissingScoreGroupIdsAcross(emptyScoreRuleGroup(), outputRoot);
  return { inputRoot: emptyScoreRuleGroup(), outputRoot };
}

export function serializeScoreMappingBundle(inputRoot, outputRoot) {
  const inR = inputRoot || emptyScoreRuleGroup();
  const outR = outputRoot || emptyScoreRuleGroup();
  assignMissingScoreGroupIdsAcross(inR, outR);
  return JSON.stringify({
    v: SCORE_MAPPING_BUNDLE_V,
    input: inR,
    output: outR,
  });
}

/** For embedding prefetch: one synthetic group containing both trees. */
export function scoreBundleRootsForEmbeddingWalk(inputRoot, outputRoot) {
  const ch = [];
  if (inputRoot && (inputRoot.type === 'rule' || (inputRoot.children && inputRoot.children.length))) ch.push(inputRoot);
  if (outputRoot && (outputRoot.type === 'rule' || (outputRoot.children && outputRoot.children.length))) ch.push(outputRoot);
  if (ch.length === 0) return emptyScoreRuleGroup();
  if (ch.length === 1) return ch[0];
  return { type: 'group', ops: Array(ch.length - 1).fill('AND'), children: ch };
}
