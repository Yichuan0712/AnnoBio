/**
 * Greedy pairing: each run result row (row_index) maps to at most one ground-truth row.
 * Used by Score detail UI, Review comparison rows, and score export — keep behavior in one place.
 *
 * Two rule trees (v2 bundle):
 * 1. inputRoot — input / row-index vs GT: all input leaves must match for (i,j) to be a candidate.
 * 2. outputRoot — model output vs GT: matching leaves define score and tie-break vector.
 * If output tree has no leaves but input has leaves, candidate score is 1.
 * If both empty, no pairs match.
 *
 * Output-side greedy runs **per input zebra band** (same key as Score “Input → Ground truth” stripes on
 * run rows): within each band, pairs are sorted by output score and matched; bands do not compete for GT.
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

/** True when the rule compares run input / row index (not a model output field key). */
export function isScoreInputSideRuleKey(outputKey) {
  const keyStr = String(outputKey || '').trim();
  if (keyStr === '#' || keyStr === '[#]') return true;
  return keyStr.startsWith('[') && keyStr.endsWith(']');
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

const emptyGroup = () => ({ type: 'group', ops: [], children: [] });

function normalizeTreeRoot(r) {
  if (!r) return emptyGroup();
  if (r.type === 'rule') return { type: 'group', ops: [], children: [r] };
  if (r.type === 'group') return r;
  return emptyGroup();
}

/**
 * Band key for run row `runRowIndex`, aligned with Score zebra (input rules on run side only).
 * `getRunValue(runResult, outputKey, rowIndex, runWs, outputFields)` must match Score / Review pairing.
 */
export function computeRunInputBandKey(runRowIndex, inputRoot, resultsByIndex, runWs, outputFields, getRunValue) {
  const inR = normalizeTreeRoot(inputRoot);
  const inputLeaves = flattenScoreRules(inR);
  const rr = typeof runRowIndex === 'number' && runRowIndex >= 0 ? resultsByIndex.get(runRowIndex) || null : null;
  if (inputLeaves.length === 0) {
    const idx = rr ? (rr.input_row_index ?? runRowIndex) : runRowIndex;
    return `__ir__:${idx}`;
  }
  const parts = [];
  for (const rule of inputLeaves) {
    const rv = rr ? getRunValue(rr, rule.outputKey, runRowIndex, runWs, outputFields) : '';
    parts.push(`${String(rule.outputKey || '')}\0${rv}`);
  }
  return parts.join('\u0002');
}

/**
 * @param {object} ctx
 * @param {object} ctx.inputRoot - Rules: input / [#] / [col] vs GT (candidate gate).
 * @param {object} ctx.outputRoot - Rules: model output fields vs GT (scoring).
 * @param {Array} ctx.results
 * @param {{ headers?: string[], rows?: unknown[][] }} ctx.runWs
 * @param {{ headers?: string[], rows?: unknown[][] }} ctx.gtContent
 * @param {unknown[]} ctx.outputFields
 * @param {function(object, number, number, Map, object, unknown[], object): boolean} ctx.ruleMatchesRow
 * @param {function(object, string, number, object, unknown[]): string} [ctx.getRunValue] - run cell value; required for per-band output greedy (rowIndex = run row_index).
 */
export function computeGreedyRunToGtPairing(ctx) {
  const { inputRoot, outputRoot, results, runWs, gtContent, outputFields, ruleMatchesRow, getRunValue } = ctx;
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

  const inR = normalizeTreeRoot(inputRoot);
  const outR = normalizeTreeRoot(outputRoot);
  const inputLeaves = flattenScoreRules(inR);
  const outputLeaves = flattenScoreRules(outR);

  const runToGt = new Array(dim).fill(-1);
  const gtUsed = new Array(gtCount).fill(false);

  const pairs = [];
  for (const i of runRowIndices) {
    for (let j = 0; j < gtCount; j++) {
      if (inputLeaves.length > 0) {
        const inputOk = inputLeaves.every((rule) =>
          ruleMatchesRow(rule, i, j, resultsByIndex, runWs, outputFields, gtContent),
        );
        if (!inputOk) continue;
      }
      let vec;
      let score;
      if (outputLeaves.length > 0) {
        vec = outputLeaves.map((rule) =>
          (ruleMatchesRow(rule, i, j, resultsByIndex, runWs, outputFields, gtContent) ? 1 : 0),
        );
        score = vec.reduce((a, b) => a + b, 0);
      } else if (inputLeaves.length > 0) {
        vec = [1];
        score = 1;
      } else {
        vec = [];
        score = 0;
      }
      if (score > 0) pairs.push({ i, j, score, vec });
    }
  }
  if (typeof getRunValue === 'function') {
    const bandOfRun = new Map();
    for (const i of runRowIndices) {
      bandOfRun.set(i, computeRunInputBandKey(i, inputRoot, resultsByIndex, runWs, outputFields, getRunValue));
    }
    const pairsByBand = new Map();
    for (const p of pairs) {
      const b = bandOfRun.get(p.i);
      if (!pairsByBand.has(b)) pairsByBand.set(b, []);
      pairsByBand.get(b).push(p);
    }
    const bandOrder = [...pairsByBand.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const b of bandOrder) {
      const bandPairs = pairsByBand.get(b).slice();
      bandPairs.sort(compareGreedyPairs);
      for (const { i, j } of bandPairs) {
        if (runToGt[i] >= 0 || gtUsed[j]) continue;
        runToGt[i] = j;
        gtUsed[j] = true;
      }
    }
  } else {
    pairs.sort(compareGreedyPairs);
    for (const { i, j } of pairs) {
      if (runToGt[i] >= 0 || gtUsed[j]) continue;
      runToGt[i] = j;
      gtUsed[j] = true;
    }
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
