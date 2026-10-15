/**
 * Precision / Recall / F1 from score comparison_rows (same pairing semantics as
 * scoreDetailModal.renderResults when rows are built by buildReviewComparisonRows).
 */

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown[]} comparisonRows
 * @returns {{ precision: number, recall: number, f1: number } | null}
 *   Values are percentages 0–100 (4 dp), matching the Score detail banner.
 */
export function computeScorePrfFromComparisonRows(comparisonRows) {
  const rows = safeArray(comparisonRows);
  if (rows.length === 0) return null;

  const gtIndices = new Set();
  for (const row of rows) {
    const j = row?.source_gt_row_index;
    if (typeof j === 'number' && !Number.isNaN(j) && j >= 0) gtIndices.add(j);
  }
  const recallDenom = gtIndices.size;

  let tp = 0;
  let precDenom = 0;
  for (const row of rows) {
    if (row?.gt_only === true) continue;
    precDenom += 1;
    if (
      row?.matched === true
      && typeof row?.source_gt_row_index === 'number'
      && !Number.isNaN(row.source_gt_row_index)
      && row.source_gt_row_index >= 0
    ) {
      tp += 1;
    }
  }

  const precision = precDenom > 0 ? (tp / precDenom) * 100 : 0;
  const recall = recallDenom > 0 ? (tp / recallDenom) * 100 : 0;
  const f1 = (precision + recall) > 0
    ? (2 * (precision / 100) * (recall / 100) / ((precision + recall) / 100)) * 100
    : 0;

  return {
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number(f1.toFixed(4)),
  };
}

/**
 * @param {object | null} metrics
 * @param {unknown[]} comparisonRows
 * @returns {object | null}
 */
export function mergeScoreMetricsWithPrf(metrics, comparisonRows) {
  const prf = computeScorePrfFromComparisonRows(comparisonRows);
  if (!metrics && !prf) return null;
  if (!metrics) return prf;
  if (!prf) return metrics;
  return { ...metrics, ...prf };
}

/** One line for the Agent, with the precision / recall / F1 of an Evaluate result. */
export function formatScoreMetrics(metrics) {
  const percent = (value) => `${Math.round(value * 10) / 10}%`;
  const matched = `${metrics.matchedRows}/${metrics.totalRows} rows matched (${percent(metrics.passRate * 100)})`;
  if (![metrics.precision, metrics.recall, metrics.f1].every(Number.isFinite)) return matched;
  return `${matched}; precision ${percent(metrics.precision)}, recall ${percent(metrics.recall)}, F1 ${percent(metrics.f1)}`;
}

/** passRate + row counts + precision / recall / f1 (same bases as inspect / snapshot). */
export function buildFullScoreMetricsFromComparisonRows(comparisonRows) {
  const rows = safeArray(comparisonRows);
  if (rows.length === 0) return null;
  let matched = 0;
  let unmatched = 0;
  let gtOnly = 0;
  for (const row of rows) {
    if (row?.gt_only === true) gtOnly += 1;
    if (row?.matched === true) matched += 1;
    else unmatched += 1;
  }
  const total = rows.length;
  const base = {
    totalRows: total,
    matchedRows: matched,
    unmatchedRows: unmatched,
    gtOnlyRows: gtOnly,
    passRate: total > 0 ? Number((matched / total).toFixed(4)) : 0,
  };
  return mergeScoreMetricsWithPrf(base, rows);
}
