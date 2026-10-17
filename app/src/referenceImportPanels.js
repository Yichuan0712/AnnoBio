/**
 * The Europe PMC, OpenAlex and UniProt tabs of Create Dataset. They share one panel and one fetch loop, as
 * their imports share one job runner (backend/reference_import.py, /api/<source>/import). The columns each
 * source offers come from GET /api/reference/import/sources, so they are listed once. Wikipedia imports
 * through the same runner but has no tab: it is not an academic source, so only the Agent offers it.
 */

const POLL_INTERVAL_MS = 1200;

export const REFERENCE_IMPORT_TABS = [
  {
    source: 'europepmc', label: 'Europe PMC', noun: ['record', 'records'], idNoun: 'ID',
    hint: 'Look up articles and preprints by PMID, PMCID or Europe PMC preprint ID (PPR…) and import the fields you pick as columns — one row per record.',
    idLabel: 'PMIDs, PMCIDs or preprint IDs (one per line, or comma/space separated)', placeholder: '11532001\nPMC13570426\nPPR1235907',
  },
  {
    source: 'openalex', label: 'OpenAlex', noun: ['work', 'works'], idNoun: 'ID',
    hint: 'Look up scholarly works by OpenAlex ID (W…) or DOI and import the fields you pick (citation count, topics, open access, ...) as columns — one row per work.',
    idLabel: 'OpenAlex IDs or DOIs (one per line, or comma/space separated)', placeholder: 'W1651253277\n10.1126/sciadv.aaz9899',
  },
  {
    source: 'uniprot', label: 'UniProt', noun: ['protein', 'proteins'], idNoun: 'accession',
    hint: 'Look up proteins by UniProt accession and import the fields you pick (function, location, GO terms, sequence, ...) as columns — one row per protein.',
    idLabel: 'UniProt accessions (one per line, or comma/space separated)', placeholder: 'P24941\nP06493',
  },
];

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const plural = (count, [one, many]) => `${count} ${count === 1 ? one : many}`;

/** Ids from the text box; a tab with oneTitlePerLine keeps spaces and commas inside each line. */
export function parseReferenceIds(text, { oneTitlePerLine = false } = {}) {
  return String(text || '').split(oneTitlePerLine ? /\r?\n/ : /[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

export function referenceImportTabsHtml() {
  return REFERENCE_IMPORT_TABS.map((tab) => `<button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" data-source="${tab.source}">Import from ${escapeHtml(tab.label)}</button>`).join('');
}

export function referenceImportPanelsHtml() {
  return REFERENCE_IMPORT_TABS.map((tab) => `
    <div class="dataset-source-panel" data-source-panel="${tab.source}" hidden>
      <div class="dataset-import">
        <h3 class="dataset-import-title">Import from ${escapeHtml(tab.label)}</h3>
        <p class="dataset-sheet-hint">${escapeHtml(tab.hint)}</p>
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
 * Wires the four panels in `overlay`.
 * @param {{apiBase: string, onRows: (headers: string[], rows: string[][]) => void, showError: (text: string) => void,
 *   hideError: () => void, setRunning: (running: boolean) => void}} options
 * @returns {{cancel: (source: string) => void, resetStatus: () => void}}
 */
export function mountReferenceImports(overlay, { apiBase, onRows, showError, hideError, setRunning }) {
  const jobs = new Map();
  const panelOf = (source) => overlay.querySelector(`[data-source-panel="${source}"]`);
  const setStatus = (source, text) => {
    const status = panelOf(source)?.querySelector('.reference-import-fetch-status');
    if (status) status.textContent = text || '';
  };

  fetch(`${apiBase}/api/reference/import/sources`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
    .then((sources) => {
      for (const tab of REFERENCE_IMPORT_TABS) {
        const info = sources[tab.source];
        const box = panelOf(tab.source)?.querySelector('.reference-import-checkboxes');
        if (!info || !box) continue;
        box.innerHTML = Object.entries(info.fields).map(([key, label]) => `
          <label class="reference-import-checkbox-label">
            <input type="checkbox" class="reference-field-checkbox" value="${escapeHtml(key)}" ${info.default_fields.includes(key) ? 'checked' : ''} />
            ${escapeHtml(label)}
          </label>`).join('');
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
    panelOf(source).querySelector('.reference-import-fetch-btn').disabled = running;
  }

  async function poll(tab, jobId) {
    const { source } = tab;
    try {
      const res = await fetch(`${apiBase}/api/${source}/import/result/${jobId}`);
      const data = await res.json().catch(() => ({}));
      if (jobs.get(source)?.jobId !== jobId) return;
      if (data.status === 'running') {
        // The total is known after the first batch.
        setStatus(source, data.total ? `Fetching… ${data.completed ?? 0}/${data.total}` : 'Fetching…');
        jobs.get(source).timer = setTimeout(() => poll(tab, jobId), POLL_INTERVAL_MS);
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
      const fields = [...panel.querySelectorAll('.reference-field-checkbox:checked')].map((input) => input.value);
      if (!fields.length) {
        showError(`Pick at least one column to import from ${tab.label}.`);
        return;
      }
      const ids = parseReferenceIds(panel.querySelector('.reference-import-ids').value, tab);
      if (!ids.length) {
        showError(`Paste at least one ${tab.idNoun}.`);
        return;
      }
      button.disabled = true;
      setRunning(true);
      setStatus(tab.source, 'Starting…');
      try {
        const res = await fetch(`${apiBase}/api/${tab.source}/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, fields }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          finish(tab.source, false);
          showError(`Could not start import: ${typeof data.detail === 'string' ? data.detail : 'unknown error'}`);
          setStatus(tab.source, '');
          return;
        }
        jobs.set(tab.source, { jobId: data.job_id, timer: null });
        void poll(tab, data.job_id);
      } catch (error) {
        finish(tab.source, false);
        showError(`Could not reach backend: ${(error && error.message) || error}`);
        setStatus(tab.source, '');
      }
    });
  }

  return {
    /** Stops a running fetch when the user leaves its tab; the backend keeps nothing for it. */
    cancel(source) {
      const job = jobs.get(source);
      if (!job) return;
      clearTimeout(job.timer);
      fetch(`${apiBase}/api/${source}/import/cancel/${job.jobId}`, { method: 'POST' }).catch(() => {});
      finish(source, false);
    },
    resetStatus() {
      REFERENCE_IMPORT_TABS.forEach((tab) => setStatus(tab.source, ''));
    },
  };
}
