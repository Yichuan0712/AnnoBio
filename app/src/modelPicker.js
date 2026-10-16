/**
 * The model picker beside Create Run and Optimize prompt: the credentials whose Test passed in
 * Settings → Credentials. The node created by the button keeps the picked model.
 */

import { BACKEND_API_BASE } from './backendConfig.js';

async function fetchJson(path, fallback) {
  try {
    const res = await fetch(`${BACKEND_API_BASE}${path}`);
    return res.ok ? await res.json() : fallback;
  } catch (_) {
    return fallback;
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Tested credentials, in Settings order. */
export function testedModels(credentials) {
  return (Array.isArray(credentials) ? credentials : []).filter((c) => c?.id && c.last_check_ok === true);
}

/** The first preferred id that is offered, else the first offered model, else ''. */
export function pickInitialModel(models, preferredIds) {
  const offered = new Set(models.map((c) => c.id));
  return preferredIds.map((id) => String(id || '').trim()).find((id) => offered.has(id)) || models[0]?.id || '';
}

/**
 * Fills `select` with the tested models and selects the first of `preferredIds` it offers; the
 * `defaultSetting` (a Settings key such as default_run_credential_id) is tried after them.
 * With no tested model the picker is disabled and the button falls back to the Settings default.
 */
export async function fillModelPicker(select, { preferredIds = [], defaultSetting = '' } = {}) {
  if (!select) return;
  const [credentials, settings] = await Promise.all([fetchJson('/api/credentials', []), fetchJson('/api/settings', null)]);
  const models = testedModels(credentials);
  if (!models.length) {
    select.innerHTML = '<option value="">No tested models</option>';
    select.disabled = true;
    select.title = 'Add or test a model in Settings → Credentials';
    return;
  }
  select.innerHTML = models
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.model || c.llm || c.id)}</option>`)
    .join('');
  select.disabled = false;
  select.value = pickInitialModel(models, [...preferredIds, defaultSetting ? settings?.[defaultSetting] : '']);
  const syncTitle = () => { select.title = select.selectedOptions[0]?.textContent || ''; };
  syncTitle();
  select.addEventListener('change', syncTitle);
}

/** The picked credential id, or '' when the picker offers none. */
export function pickedModel(select) {
  return select && !select.disabled ? String(select.value || '').trim() : '';
}
