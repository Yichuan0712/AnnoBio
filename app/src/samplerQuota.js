/** Number of source rows requested by one pull. Ratios use the full source size every time. */
export function requestedSampleRows(totalRows, sizeType, size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 1) return 0;
  return sizeType === 'rows' ? Math.floor(n) : Math.floor(totalRows * n / 100);
}

/**
 * Compute a Sample node's finite quota from its current source and output Datasets.
 * Older outputs have no source-row IDs; match their values to distinct source rows so
 * they still consume rows after a project is reopened. Unmatched old rows reserve an
 * arbitrary remaining row, which is safer than making a possibly-used row available.
 */
export function samplerQuota(sourceContent, outputs, sizeType, size) {
  const rows = Array.isArray(sourceContent?.rows) ? sourceContent.rows : [];
  const rowIds = Array.isArray(sourceContent?.rowIds) ? sourceContent.rowIds : [];
  const count = requestedSampleRows(rows.length, sizeType, size);
  const sourceIds = new Set(rowIds);
  const usedIds = new Set();
  const legacyRows = [];

  for (const output of outputs || []) {
    if (Array.isArray(output.sourceRowIds)) {
      for (const id of output.sourceRowIds) {
        if (sourceIds.has(id)) usedIds.add(id);
      }
    } else {
      legacyRows.push(...(output.rows || []));
    }
  }

  if (legacyRows.length) {
    const byValue = new Map();
    rows.forEach((row, index) => {
      const key = JSON.stringify(row);
      if (!byValue.has(key)) byValue.set(key, []);
      byValue.get(key).push(index);
    });
    let unmatched = 0;
    for (const row of legacyRows) {
      const matches = byValue.get(JSON.stringify(row)) || [];
      const index = matches.find((candidate) => !usedIds.has(rowIds[candidate]));
      if (index == null) unmatched += 1;
      else usedIds.add(rowIds[index]);
    }
    if (unmatched) {
      for (const id of rowIds) {
        if (unmatched === 0) break;
        if (!usedIds.has(id)) { usedIds.add(id); unmatched -= 1; }
      }
    }
  }

  return {
    count,
    completed: (outputs || []).length,
    total: count > 0 ? Math.floor(rows.length / count) : 0,
    availableIndices: rowIds.flatMap((id, index) => usedIds.has(id) ? [] : [index]),
  };
}

/** Pick distinct available source indices, returning them in source order. */
export function pickUnusedSampleIndices(availableIndices, count, random = Math.random) {
  if (count < 1 || availableIndices.length < count) return null;
  const shuffled = availableIndices.slice();
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count).sort((a, b) => a - b);
}
