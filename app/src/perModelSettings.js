/**
 * Settings → Generate / Optimize / Agent: the model chosen at the top of a tab is that tab's default
 * model, and the fields that depend on the model show and edit that model's own values
 * (backend/model_settings.py). With None chosen they edit the values every model without its own
 * uses. Other fields on the tab apply to every model.
 */

/** The settings a model can have of its own. Ranges match backend/model_settings.py. */
export const PER_MODEL_FIELDS = {
  run_max_tokens: { min: 256, max: 131072 },
  run_concurrency: { min: 1, max: 10 },
  review_max_tokens: { min: 256, max: 131072 },
  // Blank is Auto (0): the model's own context window from the registries.
  agent_context_tokens: { min: 4096, max: 2000000, blank: 0 },
};

/** The number a field's text stands for, clamped to its range; null when blank and blank has no meaning. */
export function fieldValue(key, raw) {
  const field = PER_MODEL_FIELDS[key];
  if (!field) return null;
  const parsed = parseInt(String(raw ?? '').trim(), 10);
  if (Number.isNaN(parsed) || (field.blank != null && parsed === field.blank)) return field.blank ?? null;
  return Math.min(field.max, Math.max(field.min, parsed));
}

/** How a stored value appears in its field (Auto shows blank). */
export function fieldText(key, value) {
  if (value == null || value === PER_MODEL_FIELDS[key]?.blank) return '';
  return String(value);
}

/** A copy of `modelSettings` with one model's value set from a field's text, or removed when it has none. */
export function withModelValue(modelSettings, credentialId, key, raw) {
  const next = { ...(modelSettings || {}) };
  const own = { ...(next[credentialId] || {}) };
  const value = fieldValue(key, raw);
  if (value == null) delete own[key];
  else own[key] = value;
  if (Object.keys(own).length) next[credentialId] = own;
  else delete next[credentialId];
  return next;
}

/** Only models that still exist, and only settings a model can have of its own. */
export function keepKnownModels(modelSettings, credentialIds) {
  const known = new Set(credentialIds);
  let out = {};
  for (const [id, own] of Object.entries(modelSettings || {})) {
    if (!known.has(id)) continue;
    for (const [key, value] of Object.entries(own || {})) out = withModelValue(out, id, key, value);
  }
  return out;
}

/**
 * Ties a tab's model-dependent fields to its model picker.
 * @param {{ select: HTMLSelectElement, inputs: Record<string, HTMLInputElement>,
 *   state: { shared: Record<string, number>, modelSettings: object } }} options `state` is shared
 *   by all tabs and read on Save.
 * @returns {{ load: () => void, stash: () => void }} load shows the selected model's values; stash
 *   keeps what the fields say for the model they were showing.
 */
export function bindModelFields({ select, inputs, state }) {
  const keys = Object.keys(inputs).filter((key) => inputs[key]);
  let current = '';
  let shown = {};

  function load() {
    current = (select.value || '').trim();
    shown = {};
    for (const key of keys) {
      const own = current ? state.modelSettings[current]?.[key] : undefined;
      inputs[key].value = fieldText(key, own ?? state.shared[key]);
      shown[key] = inputs[key].value;
    }
  }

  function stash() {
    for (const key of keys) {
      const raw = inputs[key].value;
      if (!current) {
        const value = fieldValue(key, raw);
        if (value != null) state.shared[key] = value;
        continue;
      }
      // A model showing the values it falls back to only gets its own once a field is changed.
      if (state.modelSettings[current]?.[key] == null && raw === shown[key]) continue;
      state.modelSettings = withModelValue(state.modelSettings, current, key, raw);
    }
  }

  select.addEventListener('change', () => {
    stash();
    load();
  });
  return { load, stash };
}
