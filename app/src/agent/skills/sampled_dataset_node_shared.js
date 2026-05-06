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

export function buildSampledDatasetNodeSpec(args = {}) {
  const samplerNodeId = toCleanString(args?.sampler_node_id || args?.samplerNodeId);
  const name = toCleanString(args?.name);
  const notes = toCleanString(args?.notes || args?.note);
  const left = Number.isFinite(Number(args?.left)) ? Number(args.left) : null;
  const top = Number.isFinite(Number(args?.top)) ? Number(args.top) : null;
  const ensureUniqueName = normalizeBoolean(args?.ensure_unique_name, true);
  const maxSampleUses = normalizePositiveInteger(args?.max_sample_uses ?? args?.maxSampleUses, 1);

  if (!samplerNodeId) {
    throw new Error('Sampler node id is required.');
  }

  return {
    samplerNodeId,
    ...(name ? { name } : {}),
    ...(notes ? { notes } : {}),
    ...(left != null ? { left } : {}),
    ...(top != null ? { top } : {}),
    maxSampleUses,
    ensureUniqueName,
  };
}

export function summarizeSampledDatasetNodeSpec(spec = {}) {
  return {
    samplerNodeId: toCleanString(spec?.samplerNodeId || spec?.sampler_node_id),
    name: toCleanString(spec?.name),
    notes: String(spec?.notes || ''),
    // This is an agent-loop safety cap, not a sampler's lifetime usage limit.
    maxSampleUses: normalizePositiveInteger(spec?.maxSampleUses ?? spec?.max_sample_uses, 1),
  };
}
