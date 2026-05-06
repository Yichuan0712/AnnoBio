function toCleanString(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizePositiveInteger(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const normalized = Math.floor(n);
  return normalized >= 1 ? normalized : fallback;
}

function normalizeSamplingType(value) {
  const normalized = toCleanString(value) || 'without-replacement';
  if (normalized === 'with-replacement' || normalized === 'without-replacement' || normalized === 'specify-rows') {
    return normalized;
  }
  throw new Error('Sampling type must be "with-replacement", "without-replacement", or "specify-rows".');
}

function normalizeSampleSizeType(value) {
  const normalized = toCleanString(value) || 'ratio';
  if (normalized === 'rows' || normalized === 'ratio') return normalized;
  throw new Error('Sample size type must be "rows" or "ratio".');
}

function normalizeRowSpec(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) {
    throw new Error('Row spec is required when sampling type is "specify-rows".');
  }
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('Row spec is required when sampling type is "specify-rows".');
  }
  const normalizedParts = parts.map((part) => {
    const dash = part.indexOf('-');
    if (dash >= 0) {
      const from = normalizePositiveInteger(part.slice(0, dash));
      const to = normalizePositiveInteger(part.slice(dash + 1));
      if (!from || !to) {
        throw new Error('Row spec must contain positive row numbers or ranges like "1 3 5-10".');
      }
      return `${Math.min(from, to)}-${Math.max(from, to)}`;
    }
    const row = normalizePositiveInteger(part);
    if (!row) {
      throw new Error('Row spec must contain positive row numbers or ranges like "1 3 5-10".');
    }
    return String(row);
  });
  return normalizedParts.join(' ');
}

export function formatSamplerModeSummary(spec = {}) {
  const samplingType = toCleanString(spec?.samplingType || spec?.sampling_type) || 'without-replacement';
  if (samplingType === 'specify-rows') {
    return `specify rows: ${String(spec?.rowSpec || spec?.row_spec || '').trim()}`;
  }
  const sampleSizeType = toCleanString(spec?.sampleSizeType || spec?.sample_size_type) || 'ratio';
  const sampleSize = normalizePositiveInteger(spec?.sampleSize ?? spec?.sample_size, 100);
  const sizeLabel = sampleSizeType === 'ratio' ? `${sampleSize}%` : `${sampleSize} rows`;
  const typeLabel = samplingType === 'with-replacement' ? 'with replacement' : 'without replacement';
  return `${typeLabel}, ${sizeLabel}`;
}

export function buildSamplerNodeSpec(args = {}, options = {}) {
  const strict = options?.strict === true;
  const sourceNodeId = toCleanString(args?.source_node_id || args?.sourceNodeId);
  const name = toCleanString(args?.name) || 'Sample';
  const samplingType = normalizeSamplingType(args?.sampling_type || args?.samplingType);
  const left = Number.isFinite(Number(args?.left)) ? Number(args.left) : null;
  const top = Number.isFinite(Number(args?.top)) ? Number(args.top) : null;
  const ensureUniqueName = normalizeBoolean(args?.ensure_unique_name, true);

  if (!sourceNodeId) {
    throw new Error('Source dataset node id is required.');
  }

  if (samplingType === 'specify-rows') {
    const rowSpec = normalizeRowSpec(args?.row_spec || args?.rowSpec);
    return {
      sourceNodeId,
      name,
      samplingType,
      rowSpec,
      ...(left != null ? { left } : {}),
      ...(top != null ? { top } : {}),
      ensureUniqueName,
    };
  }

  const sampleSizeType = normalizeSampleSizeType(args?.sample_size_type || args?.sampleSizeType);
  const sampleSize = normalizePositiveInteger(args?.sample_size ?? args?.sampleSize, strict ? null : 100);
  if (sampleSize == null) {
    throw new Error(sampleSizeType === 'ratio'
      ? 'Ratio is required. Enter a number between 1 and 100.'
      : 'Sample size (rows) is required. Enter at least 1 row.');
  }
  if (sampleSizeType === 'ratio' && sampleSize > 100) {
    throw new Error('Ratio sample size must be between 1 and 100.');
  }

  return {
    sourceNodeId,
    name,
    samplingType,
    sampleSizeType,
    sampleSize,
    ...(left != null ? { left } : {}),
    ...(top != null ? { top } : {}),
    ensureUniqueName,
  };
}

export function summarizeSamplerNodeSpec(spec = {}) {
  return {
    name: toCleanString(spec?.name) || 'Sample',
    sourceNodeId: toCleanString(spec?.sourceNodeId || spec?.source_node_id),
    samplingType: toCleanString(spec?.samplingType || spec?.sampling_type) || 'without-replacement',
    sampleSizeType: toCleanString(spec?.sampleSizeType || spec?.sample_size_type),
    sampleSize: normalizePositiveInteger(spec?.sampleSize ?? spec?.sample_size, null),
    rowSpec: toCleanString(spec?.rowSpec || spec?.row_spec),
    modeSummary: formatSamplerModeSummary(spec),
  };
}
