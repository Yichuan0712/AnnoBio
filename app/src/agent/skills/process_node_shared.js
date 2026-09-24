function toCleanString(value) {
  return String(value == null ? '' : value).trim();
}

export function buildProcessNodeSpec(args = {}) {
  const sourceNodeId = toCleanString(args?.source_node_id || args?.sourceNodeId);
  if (!sourceNodeId) {
    throw new Error('Source dataset node id is required.');
  }
  // df_code is accepted as a compatibility alias for older agent transcripts. New requests use
  // code exclusively, and it must define process(df).
  const code = toCleanString(args?.code || args?.df_code || args?.dfCode) || null;
  if (!code) {
    throw new Error('"code" defining process(df) is required.');
  }
  if (!/^\s*def\s+process\s*\(\s*df\b/m.test(code)) {
    throw new Error('Process code must define process(df) and return a pandas DataFrame or named DataFrame branches.');
  }
  const name = toCleanString(args?.name) || 'Process';
  const left = Number.isFinite(Number(args?.left)) ? Number(args.left) : null;
  const top = Number.isFinite(Number(args?.top)) ? Number(args.top) : null;

  return {
    sourceNodeId,
    name,
    code,
    ...(left != null ? { left } : {}),
    ...(top != null ? { top } : {}),
  };
}

export function summarizeProcessNodeSpec(spec = {}) {
  return {
    name: toCleanString(spec?.name) || 'Process',
    sourceNodeId: toCleanString(spec?.sourceNodeId),
    modeSummary: 'process(df)',
  };
}
