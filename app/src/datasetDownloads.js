/** Desktop snapshot downloads with file-status checks. */
export const SNAPSHOT_ROW_LIMIT = 5000;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
export const formatDownloadBytes = (bytes) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(2)} MB`;

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (response.status === 404 && data.detail === 'Not Found' && /\/api\/reference\/import\/(?:downloads(?:[/?]|$)|sources\/[^/]+\/(?:download|schema)(?:[?]|$))/.test(url)) {
    throw new Error('The desktop backend is out of date. Fully quit and reopen AnnoBio to enable dataset downloads.');
  }
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${response.status}`);
  return data;
}

export function mountSnapshotDownload(panel, info, { apiBase, onInvalidate, onSchema, setRunning, showError, hideError, isImportRunning }) {
  const source = panel.dataset.sourcePanel;
  const options = panel.querySelector('.reference-import-options');
  const configuration = panel.querySelector('.reference-import-configuration');
  const fetchButton = panel.querySelector('.reference-import-fetch-btn');
  configuration.hidden = true;
  options.innerHTML = `<label class="dataset-meta-label">Dataset file<select class="dataset-meta-input" data-reference-option="dataset">${info.datasets.map((file) => `<option value="${escapeHtml(file.name)}">${escapeHtml(file.name)} (${formatDownloadBytes(file.bytes)})</option>`).join('')}</select></label>
    <p class="dataset-sheet-hint reference-dataset-description"></p>
    <div class="dataset-import-actions"><button type="button" class="btn btn-secondary reference-download-btn" disabled>Download</button></div>
    <progress class="reference-download-progress" aria-label="Dataset download progress" max="100" value="0" hidden></progress>
    <span class="dataset-filename reference-download-status" aria-live="polite">Checking download...</span>`;
  const select = options.querySelector('select');
  const downloadButton = options.querySelector('.reference-download-btn');
  const progress = options.querySelector('progress');
  const status = options.querySelector('.reference-download-status');
  let schema = null;
  let fileState = null;
  let job = null;
  let generation = 0;
  let checking = false;
  let closed = false;
  let removing = false;
  let failedFingerprint = null;
  let backendReady = false;
  const isActive = () => !closed && panel.isConnected && panel.classList.contains('dataset-source-panel--active');
  const currentFile = () => info.datasets.find((file) => file.name === select.value);
  const invalidate = () => {
    schema = null;
    configuration.hidden = true;
    fetchButton.disabled = true;
    onInvalidate();
  };
  const cancelRemote = (id) => fetch(`${apiBase}/api/${source}/import/cancel/${id}`, { method: 'POST' }).catch(() => {});
  const syncButtons = () => {
    const running = Boolean(job) || removing;
    const importing = Boolean(isImportRunning?.());
    const downloaded = Boolean(schema) && fileState?.status === 'downloaded';
    downloadButton.disabled = !backendReady || running || importing || fileState?.status === 'downloading' || (downloaded && !fileState.managed);
    downloadButton.classList.toggle('reference-download-btn--downloaded', downloaded && !running);
    if (downloaded && !running) {
      downloadButton.innerHTML = '<span class="reference-download-label">Downloaded</span><span class="reference-download-action" aria-hidden="true">Remove download</span>';
      downloadButton.setAttribute('aria-label', fileState.managed ? 'Remove download' : 'Downloaded');
      downloadButton.title = fileState.managed ? 'Remove the downloaded source file. Imported project tables are kept.' : 'This file is supplied from an external data directory.';
    } else {
      downloadButton.textContent = removing ? 'Removing...' : job ? (job.download ? 'Downloading...' : 'Preparing...') : fileState?.status === 'downloaded' ? 'Open dataset' : 'Download';
      downloadButton.removeAttribute('aria-label');
      downloadButton.removeAttribute('title');
    }
    progress.hidden = !job;
    fetchButton.disabled = running || importing || !schema;
  };
  function cancel() {
    const previous = job;
    job = null;
    if (previous) {
      if (fileState?.status === 'downloaded') failedFingerprint = fileState.fingerprint;
      clearTimeout(previous.timer);
      if (previous.id) void cancelRemote(previous.id);
      setRunning(false);
    }
    syncButtons();
  }
  async function fileStatus() {
    const data = await requestJson(`${apiBase}/api/reference/import/downloads?source=${encodeURIComponent(source)}`);
    return data.files.find((file) => file.name === select.value);
  }
  async function refresh() {
    if (!isActive() || checking || job || removing) return;
    const version = generation;
    checking = true;
    try {
      const next = await fileStatus();
      if (!isActive() || version !== generation || job || removing) return;
      backendReady = true;
      fileState = next;
      if (schema && (next?.status !== 'downloaded' || schema.fingerprint !== next.fingerprint)) invalidate();
      if (next?.status === 'downloaded') {
        status.textContent = `Downloaded · ${formatDownloadBytes(next.bytes)}`;
        if (!schema && failedFingerprint !== next.fingerprint) void start(false);
      } else {
        status.textContent = next?.status === 'downloading' ? 'Downloading in another window...' : next?.status === 'incomplete' ? 'Download is incomplete. Click Download to retry.' : `Not downloaded · ${formatDownloadBytes(currentFile().bytes)}`;
      }
      syncButtons();
    } catch (error) {
      if (isActive() && version === generation) { backendReady = false; status.textContent = error.message; syncButtons(); }
    } finally { checking = false; }
  }
  async function poll(pending) {
    if (job !== pending) return;
    try {
      const data = await requestJson(`${apiBase}/api/${source}/import/result/${pending.id}`);
      if (job !== pending) return;
      if (data.status === 'running') {
        if (data.phase === 'downloading') {
          const total = data.download_total_bytes || currentFile().bytes;
          const completed = data.downloaded_bytes || 0;
          const percent = Math.min(100, Math.round(completed / total * 100));
          progress.value = percent;
          status.textContent = `Downloading ${percent}% · ${formatDownloadBytes(completed)} / ${formatDownloadBytes(total)}`;
        } else {
          progress.value = 100;
          status.textContent = 'Preparing dataset...';
        }
        pending.timer = setTimeout(() => poll(pending), 1200);
        return;
      }
      if (data.error) throw new Error(data.error);
      if (data.status === 'cancelled') { cancel(); status.textContent = 'Cancelled'; return; }
      const next = await fileStatus();
      if (job !== pending) return;
      if (next?.status !== 'downloaded' || next.fingerprint !== data.schema?.fingerprint) throw new Error('The downloaded file changed or was removed. Download it again.');
      fileState = next;
      schema = data.schema;
      onSchema(schema);
      configuration.hidden = false;
      job = null;
      failedFingerprint = null;
      setRunning(false);
      status.textContent = `Downloaded · ${formatDownloadBytes(next.bytes)}`;
      syncButtons();
    } catch (error) {
      if (job !== pending) return;
      job = null;
      failedFingerprint = fileState?.fingerprint || null;
      setRunning(false);
      status.textContent = 'Could not prepare the dataset. Try again.';
      showError(error.message);
      syncButtons();
    }
  }
  async function start(download) {
    if (!isActive() || job) return;
    hideError();
    failedFingerprint = null;
    invalidate();
    const pending = { id: null, timer: null, download };
    job = pending;
    setRunning(true);
    progress.value = 0;
    status.textContent = download ? 'Starting download...' : 'Preparing dataset...';
    syncButtons();
    try {
      const data = await requestJson(`${apiBase}/api/reference/import/sources/${source}/${download ? 'download' : 'schema'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset: select.value }) });
      if (job !== pending) { if (data.job_id) void cancelRemote(data.job_id); return; }
      if (!data.job_id) throw new Error('The backend did not return a download job.');
      pending.id = data.job_id;
      void poll(pending);
    } catch (error) {
      if (job !== pending) return;
      job = null;
      failedFingerprint = fileState?.fingerprint || null;
      setRunning(false);
      status.textContent = error.message;
      showError(error.message);
      syncButtons();
    }
  }
  select.addEventListener('change', () => {
    ++generation;
    cancel();
    invalidate();
    fileState = null;
    checking = false;
    failedFingerprint = null;
    status.textContent = 'Checking download...';
    options.querySelector('.reference-dataset-description').textContent = currentFile().description;
    downloadButton.disabled = true;
    void refresh();
  });
  downloadButton.addEventListener('click', async () => {
    if (downloadButton.disabled || job || removing) return;
    if (!schema || fileState?.status !== 'downloaded') { void start(fileState?.status !== 'downloaded'); return; }
    if (!fileState.managed || isImportRunning?.()) return;
    removing = true;
    const version = ++generation;
    const filename = select.value;
    syncButtons();
    try {
      await requestJson(`${apiBase}/api/reference/import/downloads/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      if (version === generation) { fileState = null; invalidate(); }
    } catch (error) { showError(error.message); }
    finally { removing = false; void refresh(); }
  });
  options.querySelector('.reference-dataset-description').textContent = currentFile().description;
  return {
    refresh, cancel,
    async checkReady() {
      if (!isActive() || !schema) return false;
      const version = generation;
      try {
        const next = await fileStatus();
        if (!isActive() || version !== generation) return false;
        if (next?.status === 'downloaded' && schema?.fingerprint === next.fingerprint) return true;
        invalidate();
        showError('The downloaded file changed or was removed. Download it again.');
        void refresh();
      } catch (error) { showError(error.message); syncButtons(); }
      return false;
    },
    destroy() { closed = true; ++generation; cancel(); },
  };
}
