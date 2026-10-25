/**
 * Settings → Generate: the generation parameters (temperature, seed, ...) of the chosen model, saved as
 * model_settings[credential id].run_params. Which parameters a model takes comes from
 * GET /api/credentials/{id}/run-params (backend/model_params.py); a blank field is the model's default.
 */

/** "Temperature (0–2)", or just the label for a choice. */
export function paramLabel(spec) {
  if (spec.type === 'choice') return spec.label;
  return `${spec.label} (${spec.min}–${spec.max})`;
}

/** The value a field's text stands for, clamped to the parameter's range; null when blank or not valid. */
export function paramValue(spec, raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (spec.type === 'choice') return spec.choices.includes(text) ? text : null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  const value = spec.type === 'integer' ? Math.round(parsed) : parsed;
  return Math.min(spec.max, Math.max(spec.min, value));
}

/**
 * A copy of `modelSettings` whose run_params for one model are exactly `values` ({name: value}, nulls
 * left out). Parameters the model no longer lists are dropped with them; an empty result is removed.
 */
export function withRunParams(modelSettings, credentialId, values) {
  const next = { ...(modelSettings || {}) };
  const own = { ...(next[credentialId] || {}) };
  const params = Object.fromEntries(Object.entries(values || {}).filter(([, value]) => value != null));
  if (Object.keys(params).length) own.run_params = params;
  else delete own.run_params;
  if (Object.keys(own).length) next[credentialId] = own;
  else delete next[credentialId];
  return next;
}
