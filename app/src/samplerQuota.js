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

/** Only real Sample output edges count as pulls; Dataset versions retain provenance without consuming another pull. */
export function sampledOutputs(canvasState, samplerId) {
  const outputIds = new Set((canvasState?.connections || [])
    .filter((edge) => edge.type === 'sampler-to-dataset' && edge.fromId === samplerId).map((edge) => edge.toId));
  return (canvasState?.nodes || []).filter((node) => node.type === 'dataset'
    && node.samplerNodeId === samplerId && outputIds.has(node.nodeId)).map((node) => ({
    nodeId: node.nodeId,
    rows: (node.datasetContent || node.subsetContent)?.rows || [],
    sourceRowIds: node.sampledSourceRowIds,
  }));
}

/** Row numbers are 1-based; range direction is normalized, while order and duplicates are preserved. */
export function parseSampleRowSpec(text, totalRows) {
  const indices = [];
  for (const part of String(text || '').split(/[\s,]+/).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) continue;
    const a = Number(match[1]);
    const b = Number(match[2] || match[1]);
    if (a < 1 || b < 1) continue;
    for (let row = Math.min(a, b); row <= Math.min(Math.max(a, b), totalRows); row += 1) indices.push(row - 1);
  }
  return indices;
}

/** The canvas and Agent draw from the same source-row pool and enforce the same finite quota. */
export function sampleSourceIndices(source, outputs, settings, random = Math.random) {
  const totalRows = source?.rows?.length || 0;
  if (settings.samplingType === 'specify-rows') return parseSampleRowSpec(settings.rowSpec, totalRows);
  const count = requestedSampleRows(totalRows, settings.sampleSizeType || 'ratio', settings.sampleSize ?? 100);
  if (settings.samplingType === 'with-replacement') {
    return Array.from({ length: Math.min(count, totalRows) }, () => Math.floor(random() * totalRows)).sort((a, b) => a - b);
  }
  if (count < 1) throw new Error('Sample size selects no rows from this Dataset.');
  const quota = samplerQuota(source, outputs, settings.sampleSizeType || 'ratio', settings.sampleSize ?? 100);
  if (quota.completed >= quota.total || quota.availableIndices.length < count) {
    throw new Error('Not enough remaining data to create a new dataset when sampling without replacement.');
  }
  return pickUnusedSampleIndices(quota.availableIndices, count, random);
}
