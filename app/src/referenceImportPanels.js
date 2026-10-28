import { availableReferenceDatabases } from './databaseCatalog.js';
import { allowedExternalUrl, attachExternalBrowserLink } from './externalLinks.js';

/**
 * Database-specific import forms share the backend job runner and column registry.
 * The database picker opens these forms; PubMed retains its own shortcut.
 */

const POLL_INTERVAL_MS = 1200;

export const REFERENCE_IMPORT_TABS = availableReferenceDatabases();

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const plural = (count, [one, many]) => `${count} ${count === 1 ? one : many}`;

/** Ids from the text box; a tab with oneTitlePerLine keeps spaces and commas inside each line. */
export function parseReferenceIds(text, { oneTitlePerLine = false } = {}) {
  return String(text || '').split(oneTitlePerLine ? /\r?\n/ : /[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

export function referenceImportTabsHtml() {
  return '<button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" data-source="database">Import from other databases</button>';
}

export function referenceImportPanelsHtml() {
  return REFERENCE_IMPORT_TABS.map((tab) => `
    <div class="dataset-source-panel" data-source-panel="${tab.source}" hidden>
      <div class="dataset-import">
        <h3 class="dataset-import-title">Import from ${escapeHtml(tab.label)}</h3>
        <p class="dataset-sheet-hint">${escapeHtml(tab.hint)}</p>
        <div class="reference-import-options"></div>
        <label class="dataset-meta-label" for="${tab.source}-ids">${escapeHtml(tab.idLabel)}</label>
        <textarea id="${tab.source}-ids" class="dataset-meta-input dataset-meta-textarea reference-import-ids" rows="6" placeholder="${escapeHtml(tab.placeholder).replaceAll('\n', '&#10;')}"></textarea>
        <div class="reference-import-fields">
          <div class="dataset-meta-label">Columns to import</div>
          <div class="reference-import-checkboxes"><span class="dataset-filename">Loading columns…</span></div>
        </div>
        <div class="dataset-import-actions">
          <button type="button" class="btn btn-secondary reference-import-fetch-btn">Fetch from ${escapeHtml(tab.label)}</button>
          <span class="dataset-filename reference-import-fetch-status" aria-live="polite"></span>
        </div>
      </div>
    </div>`).join('');
}

/**
 * Wires database forms in `overlay`.
 * @param {{apiBase: string, onRows: (headers: string[], rows: string[][]) => void, showError: (text: string) => void,
 *   hideError: () => void, setRunning: (running: boolean) => void}} options
 * @returns {{cancel: (source: string) => void, cancelAll: () => void, resetStatus: () => void}}
 */
export function mountReferenceImports(overlay, { apiBase, onRows, onReset = () => {}, showError, hideError, setRunning }) {
  const jobs = new Map();
  const schemas = new Map();
  const selections = new Map();
  const panelOf = (source) => overlay.querySelector(`[data-source-panel="${source}"]`);
  const setStatus = (source, text) => {
    const status = panelOf(source)?.querySelector('.reference-import-fetch-status');
    if (status) status.textContent = text || '';
  };

  const renderFields = (panel, info) => {
    const source = panel.dataset.sourcePanel;
    const selected = new Set(info.default_fields);
    selections.set(source, selected);
    const box = panel.querySelector('.reference-import-checkboxes');
    const entries = Object.entries(info.fields);
    box.innerHTML = `${entries.length > 100 ? '<input type="search" class="dataset-meta-input reference-column-search" placeholder="Search columns" aria-label="Search columns" /><span class="dataset-filename reference-column-count"></span>' : ''}<div class="reference-column-list"></div>`;
    const draw = () => {
      const query = (box.querySelector('.reference-column-search')?.value || '').toLowerCase();
      const matching = entries.filter(([key, label]) => `${key} ${label}`.toLowerCase().includes(query));
      box.querySelector('.reference-column-list').innerHTML = matching.slice(0, 100).map(([key, label]) => `
        <label class="reference-import-checkbox-label"><input type="checkbox" class="reference-field-checkbox" value="${escapeHtml(key)}" ${selected.has(key) ? 'checked' : ''} /> ${escapeHtml(label)}</label>`).join('');
      const count = box.querySelector('.reference-column-count');
      if (count) count.textContent = `${Math.min(matching.length, 100)} of ${matching.length} columns shown; ${selected.size} selected. Search to find more.`;
    };
    box.querySelector('.reference-column-search')?.addEventListener('input', draw);
    box.onchange = (event) => {
      if (!event.target.matches('.reference-field-checkbox')) return;
      event.target.checked ? selected.add(event.target.value) : selected.delete(event.target.value);
      const count = box.querySelector('.reference-column-count');
      if (count) draw();
    };
    draw();
  };
  const readOptions = (panel) => Object.fromEntries([...panel.querySelectorAll('[data-reference-option]')].map((input) => [input.dataset.referenceOption, input.value]));
  const formatBytes = (bytes) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(2)} MB`;

  fetch(`${apiBase}/api/reference/import/sources`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
    .then((sources) => {
      for (const tab of REFERENCE_IMPORT_TABS) {
        const info = sources[tab.source];
        const panel = panelOf(tab.source);
        const box = panel?.querySelector('.reference-import-checkboxes');
        if (!box) continue;
        if (!info) {
          box.textContent = 'This source is unavailable on the connected backend. Update the backend to use it.';
          panel.querySelector('.reference-import-fetch-btn').disabled = true;
          continue;
        }
        const options = panel.querySelector('.reference-import-options');
        options.innerHTML = (info.option_fields || []).map((field) => `<label class="dataset-meta-label">${escapeHtml(field.label)}
          ${field.type === 'select' ? `<select class="dataset-meta-input" data-reference-option="${escapeHtml(field.key)}">${field.choices.map((choice) => `<option value="${escapeHtml(choice.value)}" ${choice.value === field.default ? 'selected' : ''}>${escapeHtml(choice.label)}</option>`).join('')}</select>`
            : `<input class="dataset-meta-input" type="password" autocomplete="off" data-reference-option="${escapeHtml(field.key)}" placeholder="${field.required ? 'Enter a key, or use the key configured on the server' : 'Optional'}" />`}</label>`).join('');
        const helpUrl = allowedExternalUrl(info.help_url);
        if (helpUrl) {
          options.insertAdjacentHTML('beforeend', `<p class="dataset-sheet-hint"><a href="${escapeHtml(helpUrl)}" target="_blank" rel="noopener noreferrer">API access and credentials</a></p>`);
          attachExternalBrowserLink(options.querySelector('a'), showError);
        }
        if (info.kind !== 'snapshot') {
          renderFields(panel, info);
          continue;
        }
        options.innerHTML = `<label class="dataset-meta-label">Dataset file<select class="dataset-meta-input" data-reference-option="dataset">${info.datasets.map((file) => `<option value="${escapeHtml(file.name)}">${escapeHtml(file.name)} (${formatBytes(file.bytes)})</option>`).join('')}</select></label>
          <p class="dataset-sheet-hint reference-dataset-description"></p>
          <button type="button" class="btn btn-secondary reference-load-columns">Load columns</button>
          <label class="dataset-meta-label">Maximum rows<input class="dataset-meta-input" type="number" min="1" max="2000" value="100" data-reference-option="limit" /></label>
          <label class="dataset-meta-label">Filter column (optional)<select class="dataset-meta-input" data-reference-option="filter_column"><option value="">No filter</option></select></label>`;
        const select = options.querySelector('[data-reference-option="dataset"]');
        const load = options.querySelector('.reference-load-columns');
        const updateFile = (event) => {
          cancel(tab.source);
          schemas.delete(tab.source);
          if (event) onReset();
          const file = info.datasets.find((item) => item.name === select.value);
          options.querySelector('.reference-dataset-description').textContent = `${file.description} ${file.name.endsWith('.pkl') ? 'This format requires a full download and enough server memory to read the file. It is cached after the first download.' : 'Rows are read on demand.'}`;
          box.textContent = 'Load columns for the selected file.';
          panel.querySelector('.reference-import-fetch-btn').disabled = true;
          options.querySelector('[data-reference-option="filter_column"]').innerHTML = '<option value="">No filter</option>';
          setStatus(tab.source, '');
        };
        select.addEventListener('change', updateFile);
        load.addEventListener('click', async () => {
          hideError();
          cancel(tab.source);
          onReset();
          const pending = { jobId: null, timer: null, schema: true };
          jobs.set(tab.source, pending);
          load.disabled = true;
          setStatus(tab.source, 'Reading dataset columns…');
          try {
            const response = await fetch(`${apiBase}/api/reference/import/sources/${tab.source}/schema`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset: select.value }) });
            const data = await response.json();
            if (jobs.get(tab.source) !== pending) {
              if (data.job_id) fetch(`${apiBase}/api/${tab.source}/import/cancel/${data.job_id}`, { method: 'POST' }).catch(() => {});
              return;
            }
            if (!response.ok) throw new Error(data.detail || 'Could not read columns.');
            pending.jobId = data.job_id;
            void poll(tab, data.job_id);
          } catch (error) {
            if (jobs.get(tab.source) !== pending) return;
            finish(tab.source, false);
            showError(error.message);
            setStatus(tab.source, '');
          }
        });
        updateFile();
      }
    })
    .catch((error) => {
      overlay.querySelectorAll('.reference-import-checkboxes').forEach((box) => {
        box.innerHTML = `<span class="dataset-filename">Could not load columns: ${escapeHtml(error?.message || error)}</span>`;
      });
    });

  function finish(source, running) {
    jobs.delete(source);
    setRunning(running);
    const panel = panelOf(source);
    panel.querySelector('.reference-import-fetch-btn').disabled = running || (panel.querySelector('.reference-load-columns') && !schemas.has(source));
    const load = panel.querySelector('.reference-load-columns');
    if (load) load.disabled = running;
  }

  async function poll(tab, jobId) {
    const { source } = tab;
    try {
      const res = await fetch(`${apiBase}/api/${source}/import/result/${jobId}`);
      const data = await res.json().catch(() => ({}));
      if (jobs.get(source)?.jobId !== jobId) return;
      if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${res.status}`);
      if (data.status === 'running') {
        // The total is known after the first batch.
        setStatus(source, data.total ? `Fetching… ${data.completed ?? 0}/${data.total}` : 'Fetching…');
        jobs.get(source).timer = setTimeout(() => poll(tab, jobId), POLL_INTERVAL_MS);
        return;
      }
      if (data.schema && data.status !== 'cancelled') {
        schemas.set(source, data.schema);
        const panel = panelOf(source);
        renderFields(panel, data.schema);
        panel.querySelector('[data-reference-option="filter_column"]').innerHTML = '<option value="">No filter</option>' + data.schema.filter_columns.map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(key)}</option>`).join('');
        finish(source, false);
        setStatus(source, 'Columns loaded. Choose columns and fetch rows.');
        return;
      }
      finish(source, false);
      if (data.error) {
        showError(`${tab.label} import failed: ${data.error}`);
        setStatus(source, '');
        return;
      }
      const rows = data.rows || [];
      const notFound = data.not_found || [];
      const total = data.total ?? rows.length;
      const idWord = (count) => `${tab.idNoun}${count === 1 ? '' : 's'}`;
      if (rows.length === 0) {
        setStatus(source, data.status === 'cancelled' ? 'Cancelled.' : `0/${total} ${idWord(total)} fetched`);
        if (data.status !== 'cancelled' && notFound.length > 0) showError(`None of the ${notFound.length} ${idWord(notFound.length)} were found on ${tab.label}.`);
        return;
      }
      onRows(data.headers || [], rows);
      setStatus(source, `${rows.length}/${plural(total, tab.noun)} fetched${data.status === 'cancelled' ? ' (cancelled early)' : ''}`);
      if (notFound.length > 0) {
        showError(`${notFound.length} ${idWord(notFound.length)} not found on ${tab.label} and skipped: ${notFound.join(', ')}`);
      }
    } catch (error) {
      if (jobs.get(source)?.jobId !== jobId) return;
      finish(source, false);
      showError(`Could not reach backend: ${(error && error.message) || error}`);
      setStatus(source, '');
    }
  }

  for (const tab of REFERENCE_IMPORT_TABS) {
    const panel = panelOf(tab.source);
    const button = panel?.querySelector('.reference-import-fetch-btn');
    button?.addEventListener('click', async () => {
      hideError();
      const fields = [...(selections.get(tab.source) || [])];
      if (!fields.length) {
        showError(`Pick at least one column to import from ${tab.label}.`);
        return;
      }
      const ids = parseReferenceIds(panel.querySelector('.reference-import-ids').value, tab);
      if (!ids.length && tab.kind !== 'snapshot') {
        showError(`Paste at least one ${tab.idNoun}.`);
        return;
      }
      onReset();
      button.disabled = true;
      setRunning(true);
      setStatus(tab.source, 'Starting…');
      const pending = { jobId: null, timer: null };
      jobs.set(tab.source, pending);
      try {
        const res = await fetch(`${apiBase}/api/${tab.source}/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, fields, options: readOptions(panel) }),
        });
        const data = await res.json().catch(() => ({}));
        if (jobs.get(tab.source) !== pending) {
          if (data.job_id) fetch(`${apiBase}/api/${tab.source}/import/cancel/${data.job_id}`, { method: 'POST' }).catch(() => {});
          return;
        }
        if (!res.ok) {
          finish(tab.source, false);
          showError(`Could not start import: ${typeof data.detail === 'string' ? data.detail : 'unknown error'}`);
          setStatus(tab.source, '');
          return;
        }
        if (!data.job_id) throw new Error('The database did not return an import job.');
        pending.jobId = data.job_id;
        void poll(tab, data.job_id);
      } catch (error) {
        if (jobs.get(tab.source) !== pending) return;
        finish(tab.source, false);
        showError(`Could not reach backend: ${(error && error.message) || error}`);
        setStatus(tab.source, '');
      }
    });
  }

  function cancel(source) {
    const job = jobs.get(source);
    if (!job) return;
    clearTimeout(job.timer);
    if (job.jobId) fetch(`${apiBase}/api/${source}/import/cancel/${job.jobId}`, { method: 'POST' }).catch(() => {});
    finish(source, false);
  }

  return {
    cancel,
    cancelAll() { [...jobs.keys()].forEach(cancel); },
    resetStatus() {
      REFERENCE_IMPORT_TABS.forEach((tab) => setStatus(tab.source, ''));
    },
  };
}
