import { availableReferenceDatabases } from './databaseCatalog.js';
import { allowedExternalUrl, attachExternalBrowserLink } from './externalLinks.js';
import { mountSnapshotDownload, SNAPSHOT_ROW_LIMIT } from './datasetDownloads.js';

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
        <div class="reference-import-configuration" ${tab.kind === 'snapshot' ? 'hidden' : ''}>
        ${tab.kind === 'snapshot' ? '' : `<label class="dataset-meta-label" for="${tab.source}-ids">${escapeHtml(tab.idLabel)}</label>
        <textarea id="${tab.source}-ids" class="dataset-meta-input dataset-meta-textarea reference-import-ids" rows="6" placeholder="${escapeHtml(tab.placeholder).replaceAll('\n', '&#10;')}"></textarea>`}
        <div class="reference-import-fields">
          <div class="dataset-meta-label">Columns to import</div>
          <div class="reference-import-checkboxes"><span class="dataset-filename">Loading columns…</span></div>
        </div>
        <div class="dataset-import-actions">
          <button type="button" class="btn btn-secondary reference-import-fetch-btn">Fetch from ${escapeHtml(tab.label)}</button>
          <span class="dataset-filename reference-import-fetch-status" aria-live="polite"></span>
        </div>
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
  const snapshots = new Map();
  let closed = false;
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
  const refreshDownloads = () => {
    if (closed || document.hidden) return;
    snapshots.forEach((snapshot) => { void snapshot.refresh(); });
  };
  const hasSnapshots = REFERENCE_IMPORT_TABS.some((tab) => tab.kind === 'snapshot');
  const timer = hasSnapshots ? setInterval(refreshDownloads, 5000) : null;
  const observer = hasSnapshots ? new MutationObserver(refreshDownloads) : null;
  observer?.observe(overlay.querySelector('.modal-panel--dataset'), { attributes: true, attributeFilter: ['data-dataset-source'] });
  if (hasSnapshots) {
    window.addEventListener('focus', refreshDownloads);
    document.addEventListener('visibilitychange', refreshDownloads);
  }

  fetch(`${apiBase}/api/reference/import/sources`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
    .then((sources) => {
      if (closed) return;
      for (const tab of REFERENCE_IMPORT_TABS) {
        const info = sources[tab.source];
        const panel = panelOf(tab.source);
        const box = panel?.querySelector('.reference-import-checkboxes');
        if (!box) continue;
        if (!info) {
          box.textContent = 'This source is unavailable on the connected backend. Update the backend to use it.';
          if (tab.kind === 'snapshot') panel.querySelector('.reference-import-options').textContent = box.textContent;
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
        snapshots.set(tab.source, mountSnapshotDownload(panel, info, {
          apiBase, setRunning, showError, hideError,
          isImportRunning: () => jobs.has(tab.source),
          onInvalidate() {
            schemas.delete(tab.source);
            selections.delete(tab.source);
            cancelImport(tab.source);
            if (panel.classList.contains('dataset-source-panel--active')) onReset();
          },
          onSchema(schema) {
            schemas.set(tab.source, schema);
            renderFields(panel, schema);
          },
        }));
        void snapshots.get(tab.source).refresh();
      }
    })
    .catch((error) => {
      if (closed) return;
      overlay.querySelectorAll('.reference-import-checkboxes').forEach((box) => {
        box.innerHTML = `<span class="dataset-filename">Could not load columns: ${escapeHtml(error?.message || error)}</span>`;
      });
      for (const tab of REFERENCE_IMPORT_TABS.filter((item) => item.kind === 'snapshot')) {
        panelOf(tab.source).querySelector('.reference-import-options').textContent = `Could not load dataset information: ${error?.message || error}`;
      }
    });

  function finish(source, running) {
    jobs.delete(source);
    setRunning(running);
    const panel = panelOf(source);
    panel.querySelector('.reference-import-fetch-btn').disabled = running || (snapshots.has(source) && !schemas.has(source));
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

      if (data.error) {
        finish(source, false);
        showError(`${tab.label} import failed: ${data.error}`);
        setStatus(source, '');
        return;
      }
      const rows = data.rows || [];
      const notFound = data.not_found || [];
      const total = data.total ?? rows.length;
      const idWord = (count) => `${tab.idNoun}${count === 1 ? '' : 's'}`;
      if (rows.length === 0) {
        finish(source, false);
        setStatus(source, data.status === 'cancelled' ? 'Cancelled.' : `0/${total} ${idWord(total)} fetched`);
        if (data.status !== 'cancelled' && notFound.length > 0) showError(`None of the ${notFound.length} ${idWord(notFound.length)} were found on ${tab.label}.`);
        return;
      }
      if (snapshots.has(source) && !await snapshots.get(source).checkReady()) {
        if (jobs.get(source)?.jobId === jobId) { finish(source, false); setStatus(source, ''); }
        return;
      }
      if (jobs.get(source)?.jobId !== jobId) return;
      if (closed || !panelOf(source).classList.contains('dataset-source-panel--active')) return;
      finish(source, false);
      onRows(data.headers || [], rows, { truncated: tab.kind === 'snapshot' && data.truncated === true });
      setStatus(source, data.truncated
        ? `Imported the first ${rows.length.toLocaleString('en-US')} rows. The remaining rows were not imported.`
        : `${rows.length}/${plural(total, tab.noun)} fetched${data.status === 'cancelled' ? ' (cancelled early)' : ''}`);
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
      if (snapshots.has(tab.source)) {
        button.disabled = true;
        if (!await snapshots.get(tab.source).checkReady()) return;
        button.disabled = false;
      }
      const fields = [...(selections.get(tab.source) || [])];
      if (!fields.length) {
        showError(`Pick at least one column to import from ${tab.label}.`);
        return;
      }
      const ids = tab.kind === 'snapshot' ? [] : parseReferenceIds(panel.querySelector('.reference-import-ids').value, tab);
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
          body: JSON.stringify({ ids, fields, options: tab.kind === 'snapshot' ? { ...readOptions(panel), limit: SNAPSHOT_ROW_LIMIT } : readOptions(panel) }),
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

  function cancelImport(source) {
    const job = jobs.get(source);
    if (!job) return;
    clearTimeout(job.timer);
    if (job.jobId) fetch(`${apiBase}/api/${source}/import/cancel/${job.jobId}`, { method: 'POST' }).catch(() => {});
    finish(source, false);
  }

  function cancel(source) {
    cancelImport(source);
    snapshots.get(source)?.cancel();
  }
  return {
    cancel,
    cancelAll() {
      closed = true;
      clearInterval(timer);
      observer?.disconnect();
      window.removeEventListener('focus', refreshDownloads);
      document.removeEventListener('visibilitychange', refreshDownloads);
      [...jobs.keys()].forEach(cancelImport);
      snapshots.forEach((snapshot) => snapshot.destroy());
    },
    resetStatus() {
      REFERENCE_IMPORT_TABS.forEach((tab) => setStatus(tab.source, ''));
    },
  };
}
