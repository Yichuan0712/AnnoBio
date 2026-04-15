/**
 * Greedy pairing: each run result row (row_index) maps to at most one ground-truth row.
 * Used by Score detail UI, Review comparison rows, and score export — keep behavior in one place.
 *
 * Algorithm:
 * 1. Collect leaf rules in depth-first order (same as Score rule list / drag order).
 * 2. If any rule has rowGroupKey, only (run_i, gt_j) pairs where that rule matches are candidates.
 * 3. For each pair, score = count of leaf rules that match; tie-break by lexicographic match vector
 *    (earlier rules in the list win), then run index, then GT index.
 * 4. Greedily assign highest-ranked pairs first; each run row and each GT row used at most once.
 */

/** Depth-first list of leaf rule nodes under a score tree root. */
export function flattenScoreRules(node) {
  if (!node) return [];
  if (node.type === 'rule') return [node];
  if (node.type === 'group' && Array.isArray(node.children)) {
    return node.children.flatMap(flattenScoreRules);
  }
  return [];
}

function compareGreedyPairs(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const len = Math.max(a.vec.length, b.vec.length);
  for (let k = 0; k < len; k++) {
    const av = a.vec[k] || 0;
    const bv = b.vec[k] || 0;
    if (bv !== av) return bv - av;
  }
  if (a.i !== b.i) return a.i - b.i;
  return a.j - b.j;
}

/**
 * @param {object} ctx
 * @param {object} ctx.scoreRoot - Parsed score mapping root (type `group`).
 * @param {Array} ctx.results - Run results (falsy entries ignored for the map).
 * @param {{ headers?: string[], rows?: unknown[][] }} ctx.runWs
 * @param {{ headers?: string[], rows?: unknown[][] }} ctx.gtContent
 * @param {unknown[]} ctx.outputFields - Passed through to ruleMatchesRow.
 * @param {function(object, number, number, Map, object, unknown[], object): boolean} ctx.ruleMatchesRow
 *        (rule, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent)
 * @returns {{
 *   runToGt: number[],
 *   matched: boolean[],
 *   matchedCount: number,
 *   total: number,
 *   runCount: number,
 * }}
 */
export function computeGreedyRunToGtPairing(ctx) {
  const { scoreRoot, results, runWs, gtContent, outputFields, ruleMatchesRow } = ctx;
  const resultsByIndex = new Map();
  (results || []).forEach((r) => {
    if (r) resultsByIndex.set(r.row_index, r);
  });
  const scoringResults = (results || []).filter(Boolean);
  const runRowIndices = [...new Set(scoringResults.map((r) => r.row_index))];
  const gtRows = gtContent.rows || [];
  const gtCount = gtRows.length;
  const inputRowCount = runWs?.rows?.length ?? 0;
  const maxRunRowIndex = runRowIndices.length ? Math.max(...runRowIndices) : -1;
  const runCount = Math.max(inputRowCount, maxRunRowIndex + 1);
  const dim = Math.max(runCount, gtCount);

  const rulesOrdered = flattenScoreRules(scoreRoot);
  const rowGroupRule = rulesOrdered.find((r) => r && r.rowGroupKey === true) || null;

  const runToGt = new Array(dim).fill(-1);
  const gtUsed = new Array(gtCount).fill(false);

  const pairs = [];
  for (const i of runRowIndices) {
    for (let j = 0; j < gtCount; j++) {
      if (rowGroupRule && !ruleMatchesRow(rowGroupRule, i, j, resultsByIndex, runWs, outputFields, gtContent)) {
        continue;
      }
      const vec = rulesOrdered.map((rule) =>
        (ruleMatchesRow(rule, i, j, resultsByIndex, runWs, outputFields, gtContent) ? 1 : 0),
      );
      const score = vec.reduce((a, b) => a + b, 0);
      if (score > 0) pairs.push({ i, j, score, vec });
    }
  }
  pairs.sort(compareGreedyPairs);
  for (const { i, j } of pairs) {
    if (runToGt[i] >= 0 || gtUsed[j]) continue;
    runToGt[i] = j;
    gtUsed[j] = true;
  }

  const matched = [];
  const maxRow = Math.max(runCount, gtCount);
  for (let idx = 0; idx < maxRow; idx++) {
    matched.push(idx < runCount && runToGt[idx] >= 0);
  }
  const matchedCount = runToGt.slice(0, runCount).filter((jj) => jj >= 0).length;
  return {
    runToGt,
    matched,
    matchedCount,
    total: scoringResults.length,
    runCount,
  };
}
