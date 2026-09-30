/**
 * Per-node settings dialogs: "Run settings" for a Run node and "Review settings" for a Score node
 * (the node a Review is started from). Each holds the node's model plus its own values for the same
 * knobs as Settings → Run defaults / Review defaults; a blank number means "use the default".
 * Changes save to the node as they're made, like the app's other settings dialogs.
 *
 * Node fields: model → runCredentialId / reviewCredentialId, review method → reviewMethod, GEPA-style
 * target section → gepaTargetSectionIndex, number overrides → runSettings / reviewSettings (JSON,
 * keyed by the backend settings names; sent as the request's settings_overrides).
 */

import { BACKEND_API_BASE } from './backendConfig.js';
import { selectPlaceholderLabel } from './displayTextNormalize.js';

const API_BASE = BACKEND_API_BASE;

const RUN_NUMBER_FIELDS = [
  { key: 'run_max_tokens', label: 'Max tokens', min: 256, max: 131072 },
  { key: 'run_max_retries', label: 'Max retries on error', min: 0, max: 5 },
  { key: 'run_concurrency', label: 'Concurrency', min: 1, max: 10 },
];

const REVIEW_NUMBER_FIELDS = [
  { key: 'review_max_tokens', label: 'Max tokens', min: 256, max: 131072 },
  { key: 'review_max_failed_rows', label: 'Max failed inputs', min: 1, max: 200 },
];

/** Same per-method knobs as Settings → Review defaults (data-method-settings there). */
const REVIEW_METHOD_FIELDS = {
  gepa: [{ key: 'gepa_max_iterations', label: 'GEPA max iterations', min: 4, max: 200 }],
  miprov2: [{ key: 'miprov2_num_trials', label: 'MIPROv2 trials', min: 4, max: 200 }],
  bootstrap_fewshot: [{ key: 'bootstrap_fewshot_num_candidates', label: 'BootstrapFewShot candidates', min: 2, max: 100 }],
  textgrad: [{ key: 'textgrad_num_steps', label: 'TextGrad steps', min: 2, max: 50 }],
  copro: [
    { key: 'copro_breadth', label: 'COPRO breadth', min: 2, max: 30 },
    { key: 'copro_depth', label: 'COPRO depth', min: 1, max: 10 },
  ],
  simba: [{ key: 'simba_max_steps', label: 'SIMBA steps', min: 2, max: 40 }],
};

/** Methods that rewrite one whole prompt section chosen up front. */
export const REVIEW_METHODS_WITH_TARGET_SECTION = new Set(['gepa', 'miprov2', 'bootstrap_fewshot', 'textgrad', 'copro', 'simba']);

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

function readOverrides(node, datasetKey) {
  try {
    const parsed = JSON.parse(node?.dataset?.[datasetKey] || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeOverrides(node, datasetKey, overrides) {
  if (!node) return;
  if (Object.keys(overrides).length === 0) delete node.dataset[datasetKey];
  else node.dataset[datasetKey] = JSON.stringify(overrides);
}

/** A Run node's settings_overrides for POST /api/run, or undefined when it has none. */
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

function numberFieldHtml(field, idPrefix) {
  return `
    <div class="node-settings-field" data-number-field="${field.key}">
      <label class="dataset-meta-label" for="${idPrefix}-${field.key}">${escapeHtml(field.label)} (${field.min.toLocaleString()}–${field.max.toLocaleString()})</label>
      <input type="number" id="${idPrefix}-${field.key}" class="dataset-meta-input" min="${field.min}" max="${field.max}" step="1" autocomplete="off" />
    </div>`;
}

/** Wires a number input to one key of the node's overrides; blank clears it back to the default. */
function bindNumberField(overlay, idPrefix, field, { node, datasetKey, defaults, onChange }) {
  const input = overlay.querySelector(`#${idPrefix}-${field.key}`);
  if (!input) return;
  const current = readOverrides(node, datasetKey)[field.key];
  input.value = current != null ? String(current) : '';
  input.placeholder = defaults?.[field.key] != null ? `Default: ${defaults[field.key]}` : 'Default';
  const commit = () => {
    const overrides = readOverrides(node, datasetKey);
    const raw = input.value.trim();
    if (raw === '') {
      delete overrides[field.key];
    } else {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed)) {
        input.value = overrides[field.key] != null ? String(overrides[field.key]) : '';
        return;
      }
      const clamped = Math.min(field.max, Math.max(field.min, parsed));
      input.value = String(clamped);
      overrides[field.key] = clamped;
    }
    writeOverrides(node, datasetKey, overrides);
    onChange();
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
}

function fillModelSelect(select, credentials, selectedId) {
  select.innerHTML = `<option value="">${escapeHtml(selectPlaceholderLabel('Select model'))}</option>`
    + credentials.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.model || c.llm || c.id)}</option>`).join('');
  select.value = credentials.some((c) => c.id === selectedId) ? selectedId : '';
}

function openShell({ title, intro, bodyHtml, panelClass }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'node-settings-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--node-settings ${panelClass}">
      <div class="modal-header">
        <h2 id="node-settings-title" class="modal-title">${escapeHtml(title)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <p class="settings-tab-intro">${intro}</p>
        <div class="node-settings-grid">${bodyHtml}</div>
      </div>
    </div>
  `;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });
  overlay.querySelector('.modal-close').addEventListener('click', () => {
    overlay.remove();
    resolveClosed();
  });
  document.body.appendChild(overlay);
  return { overlay, closed: closedPromise };
}

/**
 * @param {{ node: HTMLElement, modelLocked?: boolean, onChange?: () => void }} options
 * @returns {Promise<void>} resolves when the dialog closes
 */
export function openRunSettingsModal({ node, modelLocked = false, onChange = () => {} }) {
  const idPrefix = 'run-settings';
  const { overlay, closed } = openShell({
    title: 'Run settings',
    panelClass: 'modal-panel--run-settings',
    intro: 'These settings apply to this Run only. Leave a number blank to use Settings → Run defaults. Sending more rows at once finishes sooner but can hit the provider\'s rate limits.',
    bodyHtml: `
      <div class="node-settings-field node-settings-field--full">
        <label class="dataset-meta-label" for="${idPrefix}-model">Model</label>
        <select id="${idPrefix}-model" class="credentials-select dataset-meta-input" aria-label="Model for this Run"></select>
        ${modelLocked ? '<p class="node-settings-note">The model can\'t change once this Run has results.</p>' : ''}
      </div>
      ${RUN_NUMBER_FIELDS.map((f) => numberFieldHtml(f, idPrefix)).join('')}
    `,
  });
  const modelSelect = overlay.querySelector(`#${idPrefix}-model`);
  modelSelect.disabled = modelLocked;
  const changed = () => {
    onChange();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  };

  modelSelect.addEventListener('change', () => {
    const id = (modelSelect.value || '').trim();
    if (id) node.dataset.runCredentialId = id;
    else delete node.dataset.runCredentialId;
    changed();
  });

  (async () => {
    const [credentials, settings] = await Promise.all([fetchJson('/api/credentials', []), fetchJson('/api/settings', null)]);
    fillModelSelect(modelSelect, Array.isArray(credentials) ? credentials : [], (node.dataset.runCredentialId || '').trim());
    RUN_NUMBER_FIELDS.forEach((field) => bindNumberField(overlay, idPrefix, field, { node, datasetKey: 'runSettings', defaults: settings, onChange: changed }));
  })();

  return closed;
}

/**
 * @param {{ node: HTMLElement, getPromptSections?: () => Promise<Array<{name?: string}>> | Array<{name?: string}>, onChange?: () => void }} options
 * @returns {Promise<void>} resolves when the dialog closes
 */
export function openReviewSettingsModal({ node, getPromptSections = () => [], onChange = () => {} }) {
  const idPrefix = 'review-settings';
  const allMethodFields = Object.values(REVIEW_METHOD_FIELDS).flat();
  const { overlay, closed } = openShell({
    title: 'Review settings',
    panelClass: 'modal-panel--review-settings',
    intro: 'These settings apply to Reviews started from this Score. Leave a number blank to use Settings → Review defaults. Larger numbers can find better edits but make more model calls.',
    bodyHtml: `
      <div class="node-settings-field node-settings-field--full">
        <label class="dataset-meta-label" for="${idPrefix}-model">Model</label>
        <select id="${idPrefix}-model" class="credentials-select dataset-meta-input" aria-label="Model for Review"></select>
      </div>
      <div class="node-settings-field node-settings-field--full" data-review-method-field hidden>
        <label class="dataset-meta-label" for="${idPrefix}-method">Review method</label>
        <select id="${idPrefix}-method" class="credentials-select dataset-meta-input" aria-label="Review method"></select>
      </div>
      <div class="node-settings-field node-settings-field--full" data-target-section-field hidden>
        <label class="dataset-meta-label" for="${idPrefix}-section">Section to optimize</label>
        <select id="${idPrefix}-section" class="credentials-select dataset-meta-input" aria-label="Prompt section to optimize"></select>
      </div>
      ${REVIEW_NUMBER_FIELDS.map((f) => numberFieldHtml(f, idPrefix)).join('')}
      ${allMethodFields.map((f) => numberFieldHtml(f, idPrefix)).join('')}
    `,
  });
  const modelSelect = overlay.querySelector(`#${idPrefix}-model`);
  const methodSelect = overlay.querySelector(`#${idPrefix}-method`);
  const sectionSelect = overlay.querySelector(`#${idPrefix}-section`);
  const methodField = overlay.querySelector('[data-review-method-field]');
  const sectionField = overlay.querySelector('[data-target-section-field]');
  const changed = () => {
    onChange();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  };

  async function refreshMethodDependentFields() {
    const methodId = (node.dataset.reviewMethod || '').trim();
    const visibleKeys = new Set((REVIEW_METHOD_FIELDS[methodId] || []).map((f) => f.key));
    allMethodFields.forEach((f) => {
      const el = overlay.querySelector(`[data-number-field="${f.key}"]`);
      if (el) el.hidden = !visibleKeys.has(f.key);
    });

    sectionField.hidden = true;
    if (!REVIEW_METHODS_WITH_TARGET_SECTION.has(methodId)) return;
    const sections = await Promise.resolve(getPromptSections());
    if (!Array.isArray(sections) || sections.length <= 1) return;
    sectionSelect.innerHTML = sections
      .map((s, i) => `<option value="${i}">${escapeHtml((s?.name || '').trim() || `Section ${i + 1}`)}</option>`)
      .join('');
    const saved = Number.parseInt(node.dataset.gepaTargetSectionIndex, 10);
    const idx = Number.isInteger(saved) && saved >= 0 && saved < sections.length ? saved : 0;
    sectionSelect.value = String(idx);
    node.dataset.gepaTargetSectionIndex = String(idx);
    sectionField.hidden = false;
  }

  modelSelect.addEventListener('change', () => {
    const id = (modelSelect.value || '').trim();
    if (id) node.dataset.reviewCredentialId = id;
    else delete node.dataset.reviewCredentialId;
    changed();
  });
  methodSelect.addEventListener('change', () => {
    node.dataset.reviewMethod = (methodSelect.value || '').trim();
    changed();
    void refreshMethodDependentFields();
  });
  sectionSelect.addEventListener('change', () => {
    node.dataset.gepaTargetSectionIndex = (sectionSelect.value || '').trim();
    changed();
  });

  (async () => {
    const [credentials, settings, methodsData] = await Promise.all([
      fetchJson('/api/credentials', []),
      fetchJson('/api/settings', null),
      fetchJson('/api/review/methods', null),
    ]);
    fillModelSelect(modelSelect, Array.isArray(credentials) ? credentials : [], (node.dataset.reviewCredentialId || '').trim());
    const methods = Array.isArray(methodsData?.methods) ? methodsData.methods : [];
    if (methods.length > 1) {
      methodSelect.innerHTML = methods.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label || m.id)}</option>`).join('');
      methodSelect.value = (node.dataset.reviewMethod || '').trim();
      methodField.hidden = false;
    }
    [...REVIEW_NUMBER_FIELDS, ...allMethodFields].forEach((field) => bindNumberField(overlay, idPrefix, field, { node, datasetKey: 'reviewSettings', defaults: settings, onChange: changed }));
    await refreshMethodDependentFields();
  })();

  return closed;
}

/**
 * Fills a node's model and review method with the Settings defaults when it has none yet, the way
 * the old inline dropdowns did on open, so canvas checks that look at the node keep working.
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
