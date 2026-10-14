import { imageCell, isImageCell, isPdfCell, pdfCell } from './datasetContent.js';
import { buildBatchAssetPlan, suggestBatchMatchColumn } from './datasetBatchImportPlan.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function openDatasetBatchImport({ host, kind, targetColumn, headers, columnTypes, rows, importFiles, ensureRows, persistContent, onPlanChange, onClose, startAtRow = 0 }) {
  const isPdf = kind === 'pdf';
  const fileLabel = isPdf ? 'PDFs' : 'images';
  const emptyPlacementHint = `Files fill empty cells${startAtRow > 0 ? ` from row ${startAtRow + 1}` : ''} in order. Drag a card onto any ${isPdf ? 'PDF' : 'image'} cell, or reorder cards here.`;
  const textColumns = headers
    .map((header, index) => ({ index, name: String(header ?? '').trim() || `Column ${index + 1}` }))
    .filter(({ index }) => columnTypes[index] === 'text');
  const panel = document.createElement('aside');
  panel.className = 'dataset-batch-panel';
  panel.setAttribute('aria-label', `Import ${fileLabel}`);
  panel.innerHTML = `
    <div class="dataset-batch-panel__header">
      <div class="dataset-batch-panel__heading"><strong>Import ${fileLabel}</strong><span class="dataset-batch-panel__target">${escapeHtml(headers[targetColumn] || `Column ${targetColumn + 1}`)}</span></div>
      <button type="button" class="dataset-batch-panel__close" aria-label="Close import panel">&times;</button>
    </div>
    <div class="dataset-batch-panel__body">
      ${textColumns.length ? `<div class="review-detail-view-switch dataset-batch-panel__mode-switch" role="group" aria-label="File placement">
        <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab review-detail-tab--active dataset-batch-panel__mode-btn" data-mode="empty" aria-pressed="true">Fill empty cells</button>
        <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab dataset-batch-panel__mode-btn" data-mode="filename" aria-pressed="false">Match by filename</button>
      </div>
      <label class="dataset-batch-panel__source-field" hidden>Match against
        <select class="dataset-meta-input dataset-batch-panel__source">
          ${textColumns.map(({ index, name }) => `<option value="${index}">${escapeHtml(name)}</option>`).join('')}
        </select>
      </label>` : ''}
      <div class="dataset-batch-panel__drop">
        <button type="button" class="btn btn-secondary dataset-batch-panel__pick">Choose ${fileLabel}</button>
        <input class="dataset-batch-panel__file-input" type="file" accept="${isPdf ? 'application/pdf' : 'image/png,image/jpeg,image/webp'}" multiple hidden>
        <span>or drop ${fileLabel} here</span>
      </div>
      <p class="dataset-image-import-note dataset-batch-panel__hint">${emptyPlacementHint}</p>
      <div class="dataset-batch-panel__summary"><span aria-live="polite"></span><button type="button" class="dataset-batch-panel__sort">Sort A–Z</button></div>
      <div class="dataset-batch-panel__error prompt-form-error prompt-modal-error" hidden></div>
      <div class="dataset-batch-panel__cards"></div>
    </div>
    <div class="dataset-batch-panel__footer">
      <button type="button" class="btn btn-secondary dataset-batch-panel__cancel">Close</button>
      <button type="button" class="btn btn-primary dataset-batch-panel__apply" disabled>Import</button>
    </div>
  `;
  host.appendChild(panel);

  const $ = (selector) => panel.querySelector(selector);
  const dropZone = $('.dataset-batch-panel__drop');
  const fileInput = $('.dataset-batch-panel__file-input');
  const cardsEl = $('.dataset-batch-panel__cards');
  const modeButtons = panel.querySelectorAll('.dataset-batch-panel__mode-btn');
  const sourceSelect = $('.dataset-batch-panel__source');
  const applyBtn = $('.dataset-batch-panel__apply');
  const errorEl = $('.dataset-batch-panel__error');
  const summaryEl = $('.dataset-batch-panel__summary span');
  let files = [];
  let manualTargets = new Map();
  let mode = 'empty';
  let sourceColumn = textColumns[0]?.index ?? null;
  let draggingIndex = null;
  let busy = false;
  let closed = false;
  let errorMessage = '';
  let plan;

  function buildPlan() {
    return buildBatchAssetPlan({ rows, files, targetColumn, sourceColumn, mode, startRow: startAtRow, manualTargets, kind });
  }

  function renderCards() {
    cardsEl.innerHTML = files.length ? plan.assignments.map((entry) => {
      const preview = isPdf
        ? '<span class="dataset-batch-card__pdf">PDF</span>'
        : entry.file.previewUrl
          ? `<img src="${escapeHtml(entry.file.previewUrl)}" alt="" draggable="false">`
          : '<span class="dataset-batch-card__placeholder">Image</span>';
      const destination = entry.rowIndex === null ? 'Not placed'
        : entry.newRow ? `New row ${entry.rowIndex + 1}`
          : `${escapeHtml(headers[entry.columnIndex] || `Column ${entry.columnIndex + 1}`)} / row ${entry.rowIndex + 1}`;
      const note = entry.skipped ? ' / skipped' : entry.existingCount && entry.placement === 'replace' ? ' / replace' : '';
      return `<div class="dataset-batch-card" draggable="${!busy}" data-file-index="${entry.index}" title="Drag to a ${isPdf ? 'PDF' : 'image'} cell">
        <div class="dataset-batch-card__preview">${preview}<span class="dataset-batch-card__order">${entry.index + 1}</span></div>
        <div class="dataset-batch-card__info"><span class="dataset-batch-card__name" title="${escapeHtml(entry.file.name)}">${escapeHtml(entry.file.name)}</span>
          <span class="dataset-batch-card__destination">${destination}${note}</span></div>
        <button type="button" class="dataset-batch-card__remove" data-file-index="${entry.index}" aria-label="Remove ${escapeHtml(entry.file.name)}" ${busy ? 'disabled' : ''}>&times;</button>
      </div>`;
    }).join('') : '<p class="dataset-image-import-note dataset-batch-panel__empty">Choose files to see them here.</p>';
  }

  function renderPanel() {
    panel.setAttribute('aria-busy', String(busy));
    modeButtons.forEach((button) => {
      const selected = button.dataset.mode === mode;
      button.classList.toggle('review-detail-tab--active', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = busy;
    });
    if (sourceSelect) {
      $('.dataset-batch-panel__source-field').hidden = mode !== 'filename' || textColumns.length === 1;
      if (sourceColumn !== null) sourceSelect.value = String(sourceColumn);
    }
    $('.dataset-batch-panel__hint').textContent = mode === 'empty'
      ? emptyPlacementHint
      : `Files match values in ${textColumns.find(({ index }) => index === sourceColumn)?.name || 'the selected column'}. Drag a card onto any ${isPdf ? 'PDF' : 'image'} cell to correct it.`;
    errorEl.textContent = errorMessage;
    errorEl.hidden = !errorMessage;
    const placed = plan.importable.length;
    summaryEl.textContent = files.length
      ? `${placed} ready / ${plan.newRows} new rows / ${plan.unmatchedFiles} unplaced${plan.skippedFiles ? ` / ${plan.skippedFiles} skipped` : ''}`
      : '';
    applyBtn.textContent = placed ? `Import ${placed} ${placed === 1 ? 'file' : 'files'}` : 'Import';
    applyBtn.disabled = busy || placed === 0;
    $('.dataset-batch-panel__pick').disabled = busy;
    $('.dataset-batch-panel__cancel').disabled = busy;
    $('.dataset-batch-panel__close').disabled = busy;
    $('.dataset-batch-panel__sort').disabled = busy || files.length < 2;
    $('.dataset-batch-panel__sort').hidden = files.length < 2;
    if (sourceSelect) sourceSelect.disabled = busy;
    renderCards();
  }

  function refresh(notify = true) {
    if (closed) return;
    plan = buildPlan();
    renderPanel();
    if (notify) onPlanChange?.(plan);
  }

  function releaseFile(file) {
    if (file.objectUrl) URL.revokeObjectURL(file.objectUrl);
  }

  function reorderFiles(nextFiles) {
    const targetsByFile = new Map(files.map((file, index) => [file, manualTargets.get(index)]));
    files = nextFiles;
    manualTargets = new Map(files.flatMap((file, index) => targetsByFile.get(file) ? [[index, targetsByFile.get(file)]] : []));
    refresh();
  }

  function addFiles(entries) {
    if (!entries?.length || busy) return;
    const selected = Array.from(entries);
    const valid = selected.every((entry) => (isPdf ? /\.pdf$/i : /\.(png|jpe?g|webp)$/i).test(entry.name));
    if (!valid) {
      errorMessage = `Choose only ${isPdf ? 'PDF' : 'PNG, JPEG, or WebP'} files.`;
      refresh(false);
      return;
    }
    const added = selected.map((entry) => ({
      path: entry,
      name: entry.name,
      previewUrl: '',
      objectUrl: '',
    }));
    if (!isPdf) added.forEach((file) => {
      try {
        file.objectUrl = URL.createObjectURL(file.path);
        file.previewUrl = file.objectUrl;
      } catch (_) { /* Keep the filename visible if the file cannot be previewed. */ }
    });
    const wasEmpty = files.length === 0;
    files.push(...added);
    if (mode === 'filename' && wasEmpty) {
      sourceColumn = suggestBatchMatchColumn(rows, textColumns.map((column) => column.index), files).columnIndex;
    }
    errorMessage = '';
    refresh();
  }

  function close() {
    if (busy || closed) return;
    closed = true;
    files.forEach(releaseFile);
    panel.remove();
    onClose?.();
  }

  $('.dataset-batch-panel__close').addEventListener('click', close);
  $('.dataset-batch-panel__cancel').addEventListener('click', close);
  $('.dataset-batch-panel__sort').addEventListener('click', () => {
    if (busy) return;
    reorderFiles(files.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
  });
  $('.dataset-batch-panel__pick').addEventListener('click', () => { if (!busy) fileInput.click(); });
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });
  dropZone.addEventListener('dragover', (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
    if (!busy) dropZone.classList.add('dataset-batch-panel__drop--active');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dataset-batch-panel__drop--active'));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('dataset-batch-panel__drop--active');
    addFiles(event.dataTransfer?.files);
  });
  cardsEl.addEventListener('click', (event) => {
    const removeBtn = event.target.closest('.dataset-batch-card__remove');
    if (!removeBtn || busy) return;
    const index = Number(removeBtn.dataset.fileIndex);
    releaseFile(files[index]);
    files.splice(index, 1);
    manualTargets = new Map([...manualTargets].filter(([key]) => key !== index)
      .map(([key, target]) => [key > index ? key - 1 : key, target]));
    refresh();
  });
  cardsEl.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.dataset-batch-card');
    if (!card || busy) return;
    draggingIndex = Number(card.dataset.fileIndex);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-annobio-batch-file', String(draggingIndex));
    document.body.classList.add('wd-batch-dragging');
  });
  cardsEl.addEventListener('dragover', (event) => {
    const card = event.target.closest('.dataset-batch-card');
    if (!card || draggingIndex === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    card.classList.add('dataset-batch-card--drop-target');
  });
  cardsEl.addEventListener('dragleave', (event) => {
    const card = event.target.closest('.dataset-batch-card');
    if (card && !card.contains(event.relatedTarget)) card.classList.remove('dataset-batch-card--drop-target');
  });
  cardsEl.addEventListener('drop', (event) => {
    const card = event.target.closest('.dataset-batch-card');
    if (!card || draggingIndex === null) return;
    event.preventDefault();
    const sourceIndex = draggingIndex;
    const targetIndex = Number(card.dataset.fileIndex);
    draggingIndex = null;
    document.body.classList.remove('wd-batch-dragging');
    if (sourceIndex === targetIndex) return;
    const reordered = files.slice();
    const [moved] = reordered.splice(sourceIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    reorderFiles(reordered);
  });
  cardsEl.addEventListener('dragend', () => {
    draggingIndex = null;
    document.body.classList.remove('wd-batch-dragging');
    cardsEl.querySelectorAll('.dataset-batch-card--drop-target').forEach((card) => card.classList.remove('dataset-batch-card--drop-target'));
    host.querySelectorAll('.wd-image-cell--drop-target, .wd-pdf-cell--drop-target').forEach((target) => target.classList.remove('wd-image-cell--drop-target', 'wd-pdf-cell--drop-target'));
    onPlanChange?.(plan);
  });
  modeButtons.forEach((button) => button.addEventListener('click', () => {
    if (busy || mode === button.dataset.mode) return;
    mode = button.dataset.mode;
    if (mode === 'filename' && files.length && textColumns.length) {
      sourceColumn = suggestBatchMatchColumn(rows, textColumns.map((column) => column.index), files).columnIndex;
    }
    refresh();
  }));
  sourceSelect?.addEventListener('change', () => { sourceColumn = Number(sourceSelect.value); refresh(); });
  applyBtn.addEventListener('click', async () => {
    if (busy) return;
    const importPlan = buildPlan();
    if (!importPlan.importable.length) return;
    busy = true;
    plan = importPlan;
    renderPanel();
    try {
      const imported = await importFiles(importPlan.importable.map((entry) => entry.file.path));
      if (imported.length !== importPlan.importable.length) throw new Error('Some files could not be imported. No dataset cells were changed.');
      const groups = new Map();
      imported.forEach((asset, index) => {
        const entry = importPlan.importable[index];
        const key = `${entry.rowIndex}:${entry.columnIndex}`;
        const group = groups.get(key) || { rowIndex: entry.rowIndex, columnIndex: entry.columnIndex, assets: [], replace: false };
        group.assets.push(asset);
        group.replace ||= entry.placement === 'replace';
        groups.set(key, group);
      });
      const requiredRows = importPlan.importable.reduce((count, entry) => Math.max(count, entry.rowIndex + 1), rows.length);
      ensureRows(requiredRows);
      groups.forEach(({ rowIndex, columnIndex, assets, replace }) => {
        const current = rows[rowIndex][columnIndex];
        const validCurrent = isPdf ? isPdfCell(current) : isImageCell(current);
        const base = !replace && validCurrent ? current : (isPdf ? pdfCell() : imageCell());
        rows[rowIndex][columnIndex] = (isPdf ? pdfCell : imageCell)(
          [...base.assetIds, ...assets.map((asset) => asset.id)],
          [...(base.names || []), ...assets.map((asset) => asset.name)],
        );
      });
      persistContent();
      busy = false;
      close();
    } catch (error) {
      errorMessage = error?.message || String(error);
      busy = false;
      refresh(false);
    }
  });

  refresh(false);
  return {
    getPlan: () => plan,
    refresh: () => refresh(false),
    isBusy: () => busy,
    isDragging: () => draggingIndex !== null,
    canDropOnColumn: (columnIndex) => columnTypes[columnIndex] === kind,
    dropOnCell(rowIndex, columnIndex) {
      if (busy || draggingIndex === null || columnTypes[columnIndex] !== kind) return false;
      manualTargets.set(draggingIndex, { rowIndex, columnIndex, placement: 'append' });
      draggingIndex = null;
      document.body.classList.remove('wd-batch-dragging');
      refresh();
      return true;
    },
    close,
  };
}
