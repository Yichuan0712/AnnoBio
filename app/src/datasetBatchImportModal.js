import { displayCell, isImageCell, isPdfCell } from './datasetContent.js';
import { buildBatchAssetPlan, suggestBatchMatchColumn } from './datasetBatchImportPlan.js';
import { iconFileText } from './icons.js';
import { mountModalDialog } from './modalDialog.js';
import { BatchAssetDraft } from './batchAssetDraft.js';
import { fillDatasetTextCells } from './datasetTableLayout.js';
import { IMAGE_FILE_ACCEPT, IMAGE_FILE_EXTENSIONS, fileExtension } from './fileTypes.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function openDatasetBatchImport({ host, kind, targetColumn, headers, columnTypes, rows, importFiles, previewAsset, columnWidths = [], rowHeights = [], ensureRows, persistContent, onPlanChange, onClose, startAtRow = 0 }) {
  const isPdf = kind === 'pdf';
  const fileLabel = isPdf ? 'PDFs' : 'images';
  const emptyPlacementHint = `Files fill empty cells${startAtRow > 0 ? ` from row ${startAtRow + 1}` : ''} in order. Drag a card onto an existing ${isPdf ? 'PDF' : 'image'} cell in the preview, or reorder cards here.`;
  const textColumns = headers
    .map((header, index) => ({ index, name: String(header ?? '').trim() || `Column ${index + 1}` }))
    .filter(({ index }) => columnTypes[index] === 'text');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay--dataset-batch';
  overlay.setAttribute('aria-labelledby', 'dataset-batch-title');
  const panel = document.createElement('div');
  panel.className = 'modal-panel modal-panel--dataset-batch';
  panel.innerHTML = `
    <div class="modal-header dataset-batch-panel__header">
      <h2 class="modal-title" id="dataset-batch-title">Import ${fileLabel}</h2>
      <button type="button" class="modal-close dataset-batch-panel__close" aria-label="Close import window">&times;</button>
    </div>
    <div class="dataset-batch-layout">
    <div class="dataset-batch-panel">
    <h3 class="prompt-preview-title">Files to import</h3>
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
        <input class="dataset-batch-panel__file-input" type="file" accept="${isPdf ? '.pdf,application/pdf' : IMAGE_FILE_ACCEPT}" multiple hidden>
        <span>or drop ${fileLabel} here</span>
      </div>
      <p class="dataset-image-import-note dataset-batch-panel__hint">${emptyPlacementHint}</p>
      <div class="dataset-batch-panel__summary"><span aria-live="polite"></span></div>
      <div class="dataset-batch-panel__error prompt-form-error prompt-modal-error" hidden></div>
      <div class="dataset-batch-panel__cards"></div>
    </div>
    </div>
    <section class="dataset-batch-preview" aria-label="Target dataset preview">
      <h3 class="prompt-preview-title dataset-batch-preview__heading">Dataset preview</h3>
      <div class="dataset-batch-preview__content score-detail-preview-content">
      <div class="dataset-batch-preview__results run-detail-results-card">
      <p class="dataset-image-import-note dataset-batch-preview__hint">Drag ${fileLabel} within the table to move or reorder them. Changes are saved when you click Import.</p>
      <div class="working-dataset-table-wrap dataset-batch-preview__scroll"><table class="dataset-preview-table working-dataset-edit-table dataset-batch-preview__table"></table></div>
      <div class="dataset-detail-preview-toolbar dataset-batch-preview__pages">
        <label class="dataset-detail-rows-label" for="batch-rows-per-page">Rows per page</label>
        <select id="batch-rows-per-page" class="dataset-detail-rows-select" aria-label="Rows per page">${[10,25,50,100].map((count) => `<option value="${count}" ${count === 25 ? 'selected' : ''}>${count}</option>`).join('')}</select>
        <span class="dataset-detail-pagination-info" aria-live="polite"></span>
        <label class="dataset-detail-page-label" for="batch-page">Page</label><input type="number" id="batch-page" class="dataset-detail-page-inp" min="1" value="1" aria-label="Page number">
        <span class="dataset-detail-page-of">/ 1</span>
        <div class="dataset-detail-pagination-btns"><button type="button" class="btn btn-secondary dataset-batch-preview__prev" aria-label="Previous preview page">Previous</button>
        <button type="button" class="btn btn-secondary dataset-batch-preview__next" aria-label="Next preview page">Next</button></div>
      </div>
      <div class="modal-footer-actions dataset-batch-panel__footer">
        <button type="button" class="btn btn-secondary dataset-batch-panel__cancel">Close</button>
        <button type="button" class="btn btn-primary dataset-batch-panel__apply" disabled>Import</button>
      </div>
      </div>
      </div>
    </section>
    </div>
  `;
  overlay.appendChild(panel);

  const $ = (selector) => panel.querySelector(selector);
  const dropZone = $('.dataset-batch-panel__drop');
  const fileInput = $('.dataset-batch-panel__file-input');
  const cardsEl = $('.dataset-batch-panel__cards');
  const modeButtons = panel.querySelectorAll('.dataset-batch-panel__mode-btn');
  const sourceSelect = $('.dataset-batch-panel__source');
  const applyBtn = $('.dataset-batch-panel__apply');
  const errorEl = $('.dataset-batch-panel__error');
  const summaryEl = $('.dataset-batch-panel__summary span');
  const previewTable = $('.dataset-batch-preview__table');
  const previewScroll = $('.dataset-batch-preview__scroll');
  const assetPreviews = new Map();
  const draft = new BatchAssetDraft(rows, columnTypes, kind);
  let pageSize = 25;
  let previewPage = Math.floor(startAtRow / pageSize);
  let files = [];
  let manualTargets = new Map();
  let mode = 'empty';
  let sourceColumn = textColumns[0]?.index ?? null;
  let draggingIndex = null;
  let draggingExisting = null;
  let busy = false;
  let closed = false;
  let errorMessage = '';
  let plan;
  let activePdfPreviews = 0;
  let columnsResized = false;
  let stopResizing = () => {};

  function buildPlan() {
    return buildBatchAssetPlan({ rows: draft.planningRows(), files, targetColumn, sourceColumn, mode, startRow: startAtRow, manualTargets, kind });
  }

  function updatePreviewLayout() {
    const style = getComputedStyle(previewScroll);
    const available = Math.max(0, previewScroll.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0));
    const widths = headers.map((_, index) => Math.max(60, columnWidths[index] ?? (columnTypes[index] === 'image' ? 180 : columnTypes[index] === 'pdf' ? 160 : 140)));
    const naturalWidth = 40 + widths.reduce((sum, width) => sum + width, 0);
    if (!columnsResized && available > naturalWidth && headers.length) {
      const extra = available - naturalWidth;
      const evenExtra = Math.floor(extra / headers.length);
      const remainder = extra - evenExtra * headers.length;
      widths.forEach((width, index) => { widths[index] = width + evenExtra + (index < remainder ? 1 : 0); });
    }
    previewTable.style.width = `${columnsResized ? naturalWidth : Math.max(available, naturalWidth)}px`;
    previewTable.querySelectorAll('col[data-column-index]').forEach((column) => { column.style.width = `${widths[Number(column.dataset.columnIndex)]}px`; });
    fillDatasetTextCells(previewTable, true);
  }

  function existingAssetHtml(cell, type) {
    const isCell = type === 'pdf' ? isPdfCell(cell) : isImageCell(cell);
    const ids = isCell ? cell.assetIds : [];
    if (!ids.length) return '';
    return `<div class="${type === 'pdf' ? 'wd-pdf-strip' : 'wd-image-strip'}">${ids.map((id, index) => {
      const name = cell.names?.[index] || id;
      if (type === 'pdf') return `<span class="wd-pdf-chip-wrap"><button type="button" class="wd-pdf-chip" tabindex="-1" aria-disabled="true" title="${escapeHtml(name)}">${iconFileText(14).outerHTML}<span class="wd-pdf-chip-name">${escapeHtml(name)}</span></button></span>`;
      return `<span class="wd-image-thumb-wrap"><button type="button" class="wd-image-thumb" tabindex="-1" aria-disabled="true" title="${escapeHtml(name)}">${previewAsset
        ? `<img data-preview-asset-id="${escapeHtml(id)}" alt="${escapeHtml(name)}" draggable="false">`
        : escapeHtml(name)}</button></span>`;
    }).join('')}</div>`;
  }

  function loadAssetPreviews() {
    if (!previewAsset) return;
    previewTable.querySelectorAll('[data-preview-asset-id]').forEach((image) => {
      const id = image.dataset.previewAssetId;
      if (!assetPreviews.has(id)) assetPreviews.set(id, Promise.resolve().then(() => previewAsset(id)));
      assetPreviews.get(id).then((preview) => {
        if (closed || !image.isConnected) return;
        image.src = preview.url;
      }).catch(() => {
        if (!closed && image.isConnected) image.parentElement.textContent = image.alt;
      });
    });
  }

  function draftAssetStripHtml(items) {
    if (!items.length) return '';
    return `<div class="${isPdf ? 'wd-pdf-strip' : 'wd-image-strip'}">${items.map((item) => {
      const pending = item.type === 'file';
      const name = pending ? item.file.name : item.name || item.id;
      const attributes = `draggable="${!busy}" data-preview-asset-key="${escapeHtml(item.key)}" title="${escapeHtml(name)}"`;
      if (isPdf) return `<span class="wd-pdf-chip-wrap"><button type="button" class="wd-pdf-chip" ${attributes}>${iconFileText(14).outerHTML}<span class="wd-pdf-chip-name">${escapeHtml(name)}</span></button></span>`;
      const picture = pending && item.file.previewUrl
        ? `<img src="${escapeHtml(item.file.previewUrl)}" alt="${escapeHtml(name)}" draggable="false">`
        : !pending && previewAsset ? `<img data-preview-asset-id="${escapeHtml(item.id)}" alt="${escapeHtml(name)}" draggable="false">` : escapeHtml(name);
      return `<span class="wd-image-thumb-wrap"><button type="button" class="wd-image-thumb" ${attributes}>${picture}</button></span>`;
    }).join('')}</div>`;
  }

  function draftAssetHtml(items) {
    const groups = [];
    items.forEach((item) => {
      if (groups.at(-1)?.[0].type === item.type) groups.at(-1).push(item);
      else groups.push([item]);
    });
    return groups.map((group) => {
      const strip = draftAssetStripHtml(group);
      if (group[0].type !== 'file') return strip;
      const label = isPdf ? (group.length === 1 ? 'PDF' : 'PDFs') : (group.length === 1 ? 'image' : 'images');
      return `<div class="wd-batch-cell-preview__content">${strip}<span title="${escapeHtml(group.map((item) => item.file.name).join(', '))}">${group.length} ${label} to import</span></div>`;
    }).join('');
  }

  function renderPreview() {
    stopResizing();
    const { scrollLeft, scrollTop } = previewScroll;
    const visibleColumns = headers.map((_, index) => index);
    const planningRows = draft.planningRows();
    const rowCount = plan.importable.reduce((count, entry) => Math.max(count, entry.rowIndex + 1), planningRows.length);
    const pageCount = Math.max(1, Math.ceil(rowCount / pageSize));
    previewPage = Math.min(Math.max(0, previewPage), pageCount - 1);
    const firstRow = previewPage * pageSize;
    const lastRow = Math.min(rowCount, firstRow + pageSize);
    const previewRows = [];
    for (let rowIndex = firstRow; rowIndex < lastRow; rowIndex++) {
      const cells = visibleColumns.map((columnIndex) => {
        const value = displayCell(rows[rowIndex]?.[columnIndex]);
        const canDrop = columnTypes[columnIndex] === kind;
        const type = columnTypes[columnIndex];
        const cell = planningRows[rowIndex]?.[columnIndex];
        const items = canDrop ? draft.items(plan, rowIndex, columnIndex) : [];
        const validCell = type === 'pdf' ? isPdfCell(cell) : isImageCell(cell);
        const emptyCell = canDrop ? !items.length : !validCell || !cell.assetIds.length;
        const rowHeight = Math.max(28, rowHeights[rowIndex] ?? 28);
        const content = type === 'image' || type === 'pdf'
          ? `<div class="${type === 'pdf' ? 'wd-pdf-cell' : 'wd-image-cell'}${emptyCell ? (type === 'pdf' ? ' wd-pdf-cell--empty' : ' wd-image-cell--empty') : ''}">${canDrop ? draftAssetHtml(items) : existingAssetHtml(cell, type)}</div>`
          : `<textarea class="wd-cell-inp wd-cell-textarea" readonly rows="2" data-col-index="${columnIndex}" style="height:${rowHeight}px;min-height:${rowHeight}px" aria-label="${escapeHtml(headers[columnIndex])}, row ${rowIndex + 1}" spellcheck="false">${escapeHtml(value)}</textarea>`;
        return `<td class="dataset-batch-preview__cell${canDrop ? ' dataset-batch-preview__cell--target' : ''}" data-row-index="${rowIndex}" data-column-index="${columnIndex}" data-can-drop="${canDrop}">${content}<div class="wd-col-resize-handle" aria-label="Resize column"></div><div class="wd-row-resize-handle" aria-label="Resize row"></div></td>`;
      }).join('');
      previewRows.push(`<tr data-row-index="${rowIndex}" style="height:${Math.max(28, rowHeights[rowIndex] ?? 28) + 9}px"${rowIndex >= rows.length ? ' class="dataset-batch-preview__new-row"' : ''}><td class="dataset-detail-preview-row-num wd-row-num-cell">${rowIndex + 1}${rowIndex >= rows.length ? '<span class="dataset-batch-preview__new-label">New</span>' : ''}<div class="wd-row-resize-handle" aria-label="Resize row"></div></td>${cells}</tr>`);
    }
    previewTable.innerHTML = `<colgroup><col style="width:40px">${visibleColumns.map((columnIndex) => `<col data-column-index="${columnIndex}">`).join('')}</colgroup>
      <thead><tr><th scope="col" class="dataset-detail-preview-row-num">#</th>${visibleColumns.map((columnIndex) =>
        `<th scope="col" class="wd-header-th${columnIndex === targetColumn ? ' dataset-batch-preview__column--target' : ''}" data-column-index="${columnIndex}"><input type="text" class="wd-cell-inp wd-header-inp" readonly tabindex="-1" data-col-index="${columnIndex}" value="${escapeHtml(headers[columnIndex])}" aria-label="${escapeHtml(headers[columnIndex])}"><div class="wd-col-resize-handle" aria-label="Resize column"></div></th>`).join('')}</tr></thead>
      <tbody>${previewRows.join('')}</tbody>`;
    updatePreviewLayout();
    loadAssetPreviews();
    previewScroll.scrollLeft = scrollLeft;
    previewScroll.scrollTop = scrollTop;
    $('.dataset-detail-pagination-info').textContent = rowCount
      ? `Rows ${firstRow + 1}–${lastRow} of ${rowCount}` : 'No rows yet';
    const pageInput = $('#batch-page');
    pageInput.value = String(previewPage + 1);
    pageInput.max = String(pageCount);
    pageInput.disabled = busy;
    $('#batch-rows-per-page').disabled = busy;
    $('.dataset-detail-page-of').textContent = `/ ${pageCount}`;
    $('.dataset-batch-preview__prev').disabled = busy || previewPage === 0;
    $('.dataset-batch-preview__next').disabled = busy || previewPage >= pageCount - 1;
  }

  function clearDragTargets() {
    panel.querySelectorAll('.dataset-batch-card--drop-target, .dataset-batch-preview__cell--drop-target').forEach((target) => {
      target.classList.remove('dataset-batch-card--drop-target', 'dataset-batch-preview__cell--drop-target');
    });
  }

  function endDrag() {
    draggingIndex = null;
    draggingExisting = null;
    document.body.classList.remove('wd-batch-dragging');
    clearDragTargets();
  }

  function dropOnCell(rowIndex, columnIndex, beforeKey = null) {
    const rowCount = plan.importable.reduce((count, entry) => Math.max(count, entry.rowIndex + 1), draft.planningRows().length);
    if (busy || (draggingIndex === null && !draggingExisting) || !Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= rowCount || columnTypes[columnIndex] !== kind) return false;
    const key = draggingExisting?.key || files[draggingIndex]?.key;
    if (!key || key === beforeKey) { endDrag(); return false; }
    const previousItems = draft.items(plan, rowIndex, columnIndex);
    if (draggingExisting) {
      if (!draft.moveExisting(key, draggingExisting.rowIndex, draggingExisting.columnIndex, rowIndex, columnIndex)) return false;
    } else manualTargets.set(draggingIndex, { rowIndex, columnIndex, placement: 'append' });
    draft.placeInOrder(rowIndex, columnIndex, key, beforeKey, previousItems);
    endDrag();
    refresh();
    return true;
  }

  function renderCards() {
    cardsEl.innerHTML = files.length ? plan.assignments.map((entry) => {
      const preview = cardPreviewHtml(entry.file);
      const destination = entry.rowIndex === null ? 'Not placed'
        : entry.newRow ? `New row ${entry.rowIndex + 1}`
          : `${escapeHtml(headers[entry.columnIndex] || `Column ${entry.columnIndex + 1}`)} / row ${entry.rowIndex + 1}`;
      const note = entry.skipped ? ' / skipped' : entry.existingCount && entry.placement === 'replace' ? ' / replace' : '';
      return `<div class="dataset-batch-card" draggable="${!busy}" data-file-index="${entry.index}" data-file-key="${entry.file.key}" title="Drag to a ${isPdf ? 'PDF' : 'image'} cell">
        <div class="dataset-batch-card__preview${isPdf ? ' dataset-batch-card__preview--pdf' : ''}"><div class="dataset-batch-card__picture">${preview}</div><span class="dataset-batch-card__order">${entry.index + 1}</span></div>
        <div class="dataset-batch-card__info"><span class="dataset-batch-card__name" title="${escapeHtml(entry.file.name)}">${escapeHtml(entry.file.name)}</span>
          <span class="dataset-batch-card__destination">${destination}${note}</span></div>
        <button type="button" class="dataset-batch-card__remove" data-file-index="${entry.index}" aria-label="Remove ${escapeHtml(entry.file.name)}" ${busy ? 'disabled' : ''}>&times;</button>
      </div>`;
    }).join('') : '<p class="dataset-image-import-note dataset-batch-panel__empty">Choose files to see them here.</p>';
  }

  function cardPreviewHtml(file) {
    if (file.previewUrl) return `<img src="${escapeHtml(file.previewUrl)}" alt="${isPdf ? 'First page of ' + escapeHtml(file.name) : ''}" draggable="false">`;
    if (isPdf) return `<span class="dataset-batch-card__pdf"${file.previewState === 'failed' ? ' title="Preview unavailable"' : ''}>PDF</span>`;
    return '<span class="dataset-batch-card__placeholder">Image</span>';
  }

  function loadPdfPreviews() {
    if (closed || !isPdf) return;
    while (activePdfPreviews < 2) {
      const file = files.find((entry) => entry.previewState === 'queued');
      if (!file) break;
      file.previewState = 'loading';
      activePdfPreviews++;
      import('./pdfThumbnail.js').then(({ createPdfThumbnail }) => createPdfThumbnail(file.path, file.previewController.signal))
        .then((url) => {
          if (closed || !files.includes(file) || file.previewController.signal.aborted) { URL.revokeObjectURL(url); return; }
          file.objectUrl = url;
          file.previewUrl = url;
          file.previewState = 'ready';
        }).catch(() => { file.previewState = 'failed'; })
        .finally(() => {
          activePdfPreviews--;
          if (closed) return;
          // Update only the picture so finishing a preview cannot interrupt a drag.
          const picture = cardsEl.querySelector(`[data-file-key="${file.key}"] .dataset-batch-card__picture`);
          if (picture) picture.innerHTML = cardPreviewHtml(file);
          loadPdfPreviews();
        });
    }
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
      : `Files match values in ${textColumns.find(({ index }) => index === sourceColumn)?.name || 'the selected column'}. Drag a card onto an existing ${isPdf ? 'PDF' : 'image'} cell in the preview to correct it.`;
    errorEl.textContent = errorMessage;
    errorEl.hidden = !errorMessage;
    const placed = plan.importable.length;
    summaryEl.textContent = files.length
      ? `${placed} ready / ${plan.newRows} new rows / ${plan.unmatchedFiles} unplaced${plan.skippedFiles ? ` / ${plan.skippedFiles} skipped` : ''}`
      : '';
    const changed = draft.hasExistingChanges(plan);
    applyBtn.textContent = placed ? `Import ${placed} ${placed === 1 ? 'file' : 'files'}` : changed ? 'Apply changes' : 'Import';
    applyBtn.disabled = busy || (placed === 0 && !changed);
    $('.dataset-batch-panel__pick').disabled = busy;
    $('.dataset-batch-panel__cancel').disabled = busy;
    $('.dataset-batch-panel__close').disabled = busy;
    if (sourceSelect) sourceSelect.disabled = busy;
    renderCards();
    renderPreview();
  }

  function refresh(notify = true) {
    if (closed) return;
    plan = buildPlan();
    renderPanel();
    if (notify) onPlanChange?.(plan);
  }

  function releaseFile(file) {
    file.previewController?.abort();
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
    const valid = selected.every((entry) => isPdf ? fileExtension(entry.name) === 'pdf' : IMAGE_FILE_EXTENSIONS.includes(fileExtension(entry.name)));
    if (!valid) {
      errorMessage = `Choose only ${isPdf ? 'PDF' : 'PNG, JPEG, or WebP'} files.`;
      refresh(false);
      return;
    }
    const added = selected.map((entry) => ({
      key: `file:${crypto.randomUUID()}`,
      path: entry,
      name: entry.name,
      previewUrl: '',
      objectUrl: '',
      previewState: isPdf ? 'queued' : '',
      previewController: isPdf ? new AbortController() : null,
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
    loadPdfPreviews();
  }

  const close = mountModalDialog(overlay, () => {
    closed = true;
    stopResizing();
    endDrag();
    files.forEach(releaseFile);
    previewResizeObserver.disconnect();
    onClose?.();
  }, { parent: host.closest('.modal-overlay'), canClose: () => !busy && !closed });
  const previewResizeObserver = new ResizeObserver(updatePreviewLayout);
  previewResizeObserver.observe(previewScroll);

  $('.dataset-batch-panel__close').addEventListener('click', close);
  $('.dataset-batch-panel__cancel').addEventListener('click', close);
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
  // Dropping a local file outside the picker must not navigate away from the app.
  overlay.addEventListener('dragover', (event) => {
    if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
  });
  overlay.addEventListener('drop', (event) => {
    if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
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
    draggingExisting = null;
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
    endDrag();
    if (sourceIndex === targetIndex) return;
    const reordered = files.slice();
    const [moved] = reordered.splice(sourceIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    reorderFiles(reordered);
  });
  cardsEl.addEventListener('dragend', () => {
    endDrag();
    onPlanChange?.(plan);
  });
  previewTable.addEventListener('mousedown', (event) => {
    const columnHandle = event.target.closest('.wd-col-resize-handle');
    const rowHandle = event.target.closest('.wd-row-resize-handle');
    if (busy || event.button !== 0 || (!columnHandle && !rowHandle)) return;
    event.preventDefault();
    event.stopPropagation();
    stopResizing();
    const cell = event.target.closest('td, th');
    const row = cell.closest('tr');
    const columnIndex = Number(cell.dataset.columnIndex);
    const rowIndex = Number(row.dataset.rowIndex);
    const startX = event.clientX;
    const startY = event.clientY;
    const startHeight = row.getBoundingClientRect().height;
    if (columnHandle) {
      // Start from displayed widths, including any space distributed to fill the preview.
      previewTable.querySelectorAll('col[data-column-index]').forEach((column) => {
        columnWidths[Number(column.dataset.columnIndex)] = parseFloat(column.style.width);
      });
      columnsResized = true;
    }
    const startWidth = columnWidths[columnIndex];
    const cursorClass = columnHandle ? 'wd-col-resizing' : 'wd-row-resizing';
    document.body.classList.add(cursorClass);
    const move = (moveEvent) => {
      if (columnHandle) columnWidths[columnIndex] = Math.max(60, startWidth + moveEvent.clientX - startX);
      else {
        const height = Math.max(28, startHeight - 9 + moveEvent.clientY - startY);
        rowHeights[rowIndex] = height;
        row.style.height = `${height + 9}px`;
        row.querySelectorAll('.wd-cell-textarea').forEach((textarea) => {
          textarea.style.height = `${height}px`;
          textarea.style.minHeight = `${height}px`;
        });
      }
      updatePreviewLayout();
    };
    stopResizing = () => {
      document.body.classList.remove(cursorClass);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', stopResizing);
      window.removeEventListener('blur', stopResizing);
      stopResizing = () => {};
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stopResizing);
    window.addEventListener('blur', stopResizing);
  });
  previewTable.addEventListener('dragstart', (event) => {
    const asset = event.target.closest('[data-preview-asset-key]');
    if (!asset || busy) return;
    const cell = asset.closest('[data-can-drop="true"]');
    const key = asset.dataset.previewAssetKey;
    const index = files.findIndex((file) => file.key === key);
    draggingIndex = index >= 0 ? index : null;
    draggingExisting = index >= 0 ? null : { key, rowIndex: Number(cell.dataset.rowIndex), columnIndex: Number(cell.dataset.columnIndex) };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-annobio-batch-asset', key);
    document.body.classList.add('wd-batch-dragging');
  });
  previewTable.addEventListener('dragend', () => { endDrag(); onPlanChange?.(plan); });
  previewTable.addEventListener('dragover', (event) => {
    const cell = event.target.closest('[data-can-drop="true"]');
    if (!cell || busy || (draggingIndex === null && !draggingExisting)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    cell.classList.add('dataset-batch-preview__cell--drop-target');
  });
  previewTable.addEventListener('dragleave', (event) => {
    const cell = event.target.closest('.dataset-batch-preview__cell');
    if (cell && !cell.contains(event.relatedTarget)) cell.classList.remove('dataset-batch-preview__cell--drop-target');
  });
  previewTable.addEventListener('drop', (event) => {
    const cell = event.target.closest('[data-can-drop="true"]');
    if (!cell || busy || (draggingIndex === null && !draggingExisting)) return;
    event.preventDefault();
    const asset = event.target.closest('[data-preview-asset-key]');
    let beforeKey = asset?.dataset.previewAssetKey;
    if (asset) {
      const bounds = asset.getBoundingClientRect();
      if (event.clientX >= bounds.left + bounds.width / 2) {
        const assets = [...cell.querySelectorAll('[data-preview-asset-key]')];
        beforeKey = assets[assets.indexOf(asset) + 1]?.dataset.previewAssetKey;
      }
    }
    dropOnCell(Number(cell.dataset.rowIndex), Number(cell.dataset.columnIndex), beforeKey);
  });
  $('.dataset-batch-preview__prev').addEventListener('click', () => { if (!busy) { previewPage--; renderPreview(); } });
  $('.dataset-batch-preview__next').addEventListener('click', () => { if (!busy) { previewPage++; renderPreview(); } });
  $('#batch-rows-per-page').addEventListener('change', (event) => {
    if (busy) return;
    const firstRow = previewPage * pageSize;
    pageSize = Number(event.target.value);
    previewPage = Math.floor(firstRow / pageSize);
    renderPreview();
  });
  $('#batch-page').addEventListener('change', (event) => {
    if (busy) return;
    previewPage = Math.max(0, Math.floor(Number(event.target.value) || 1) - 1);
    renderPreview();
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
    if (!importPlan.importable.length && !draft.hasExistingChanges(importPlan)) return;
    busy = true;
    plan = importPlan;
    renderPanel();
    try {
      const imported = importPlan.importable.length ? await importFiles(importPlan.importable.map((entry) => entry.file.path)) : [];
      const results = draft.resultCells(importPlan, imported);
      const requiredRows = results.reduce((count, entry) => entry.cell.assetIds.length ? Math.max(count, entry.rowIndex + 1) : count, rows.length);
      ensureRows(requiredRows);
      results.forEach(({ rowIndex, columnIndex, cell }) => {
        if (rowIndex < requiredRows) rows[rowIndex][columnIndex] = cell;
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
  $('.dataset-batch-panel__pick').focus();
  return {
    getPlan: () => plan,
    refresh: () => refresh(false),
    isBusy: () => busy,
    isDragging: () => draggingIndex !== null || draggingExisting !== null,
    canDropOnColumn: (columnIndex) => columnTypes[columnIndex] === kind,
    dropOnCell,
    close,
  };
}
