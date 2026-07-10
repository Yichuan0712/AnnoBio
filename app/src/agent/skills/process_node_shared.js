function toCleanString(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeActiveMode(value) {
  const normalized = toCleanString(value);
  if (!normalized) return null;
  if (normalized === 'row' || normalized === 'df') return normalized;
  throw new Error('active_mode must be "row" or "df".');
}

export function buildProcessNodeSpec(args = {}) {
  const sourceNodeId = toCleanString(args?.source_node_id || args?.sourceNodeId);
  if (!sourceNodeId) {
    throw new Error('Source dataset node id is required.');
  }
  const code = toCleanString(args?.code) || null;
  const dfCode = toCleanString(args?.df_code || args?.dfCode) || null;
  if (!code && !dfCode) {
    throw new Error('At least one of "code" (process(row)) or "df_code" (process(df)) is required.');
  }
  const activeMode = normalizeActiveMode(args?.active_mode || args?.activeMode);
  const name = toCleanString(args?.name) || 'Process';
  const left = Number.isFinite(Number(args?.left)) ? Number(args.left) : null;
  const top = Number.isFinite(Number(args?.top)) ? Number(args.top) : null;

  return {
    sourceNodeId,
    name,
    code,
    dfCode,
    activeMode,
    ...(left != null ? { left } : {}),
    ...(top != null ? { top } : {}),
  };
}

export function summarizeProcessNodeSpec(spec = {}) {
  const modeLabel = spec?.activeMode === 'df'
    ? 'process(df)'
    : spec?.activeMode === 'row'
      ? 'process(row)'
      : (spec?.dfCode && !spec?.code) ? 'process(df)' : 'process(row)';
  return {
    name: toCleanString(spec?.name) || 'Process',
    sourceNodeId: toCleanString(spec?.sourceNodeId),
    modeSummary: modeLabel,
  };
}
