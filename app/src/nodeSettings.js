/**
 * A node's model and settings. A Generate's model is the one picked beside Create Generate (Prompt window), an
 * Optimize's the one picked beside Optimize prompt (Evaluate window); without a pick they use the models chosen in
 * Settings → Generate / Optimize. There are no per-node number settings controls. The default model (and review
 * method) is written onto the node the first time it is needed, so a Generate keeps the model it started with
 * when it resumes.
 *
 * Node fields: model → runCredentialId / reviewCredentialId, review method → reviewMethod, number
 * overrides → runSettings / reviewSettings (JSON, keyed by the backend settings names; sent as the
 * request's settings_overrides). Number overrides are only read: projects saved while per-node
 * settings existed may still carry them.
 */

import { BACKEND_API_BASE } from './backendConfig.js';

const API_BASE = BACKEND_API_BASE;

function readOverrides(node, datasetKey) {
  try {
    const parsed = JSON.parse(node?.dataset?.[datasetKey] || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

/** A Generate node's settings_overrides for POST /api/run, or undefined when it has none. */
export function runSettingsOverrides(node) {
  const o = readOverrides(node, 'runSettings');
  return Object.keys(o).length ? o : undefined;
}

/** A Score node's settings_overrides for POST /api/review/analyze, or undefined when it has none. */
export function reviewSettingsOverrides(node) {
  const o = readOverrides(node, 'reviewSettings');
  return Object.keys(o).length ? o : undefined;
}

async function fetchJson(path, fallback) {
  try {
    const res = await fetch(`${API_BASE}${path}`);
    return res.ok ? await res.json() : fallback;
  } catch (_) {
    return fallback;
  }
}

/**
 * Fills a node's model and review method with the Settings defaults when it has none yet, so
 * canvas checks that look at the node keep working.
 */
export async function ensureRunNodeModel(node) {
  if (!node || (node.dataset.runCredentialId || '').trim()) return;
  const [credentials, settings] = await Promise.all([fetchJson('/api/credentials', []), fetchJson('/api/settings', null)]);
  const defaultId = (settings?.default_run_credential_id || '').trim();
  if (defaultId && (credentials || []).some((c) => c.id === defaultId)) node.dataset.runCredentialId = defaultId;
}

export async function ensureScoreReviewDefaults(node) {
  if (!node) return;
  const [credentials, settings, methodsData] = await Promise.all([
    fetchJson('/api/credentials', []),
    fetchJson('/api/settings', null),
    fetchJson('/api/review/methods', null),
  ]);
  if (!(node.dataset.reviewCredentialId || '').trim()) {
    const defaultId = (settings?.default_review_credential_id || '').trim();
    if (defaultId && (credentials || []).some((c) => c.id === defaultId)) node.dataset.reviewCredentialId = defaultId;
  }
  const methods = Array.isArray(methodsData?.methods) ? methodsData.methods : [];
  const methodId = (node.dataset.reviewMethod || '').trim();
  if (methods.length > 0 && !methods.some((m) => m.id === methodId)) {
    const defaultId = (settings?.default_review_method || '').trim();
    node.dataset.reviewMethod = methods.some((m) => m.id === defaultId) ? defaultId : methods[0].id;
  }
  return settings;
}
