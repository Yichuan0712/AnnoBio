/**
 * Source dataset detail modal: edit name/description (left), full data preview with pagination (right).
 * @param {{ node: HTMLElement, getDatasetContent: () => { headers: string[], rows: string[][] }, isDatasetNameAlreadyUsed?: (name: string, excludeNodeId?: string | null) => boolean, isSamplerNameAlreadyUsedForSource?: (name: string, sourceNodeId: string, excludeNodeId?: string | null) => boolean }} options
 */

const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100];
const MAX_CELL_CHARS = 80;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, max = MAX_CELL_CHARS) {
  const s = String(str ?? '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function openDatasetDetailModal({ node, getDatasetContent, isDatasetNameAlreadyUsed, isSamplerNameAlreadyUsedForSource }) {
  const nodeId = node?.dataset?.nodeId ?? '';
  const name = (node?.dataset?.datasetName ?? '').trim() || 'Source dataset';
  const note = (node?.dataset?.datasetNote ?? '').trim();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'dataset-detail-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--dataset-detail" data-dataset-detail-mode="view">
      <div class="modal-header">
        <h2 id="dataset-detail-title" class="modal-title">Source dataset details: ${escapeHtml(name)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body dataset-detail-body">
        <div class="dataset-detail-col dataset-detail-col--left">
          <div class="dataset-detail-card">
            <div class="dataset-detail-view">
              <div class="dataset-detail-row">
                <span class="dataset-detail-label">Source dataset name</span>
                <span class="dataset-detail-name-value">${escapeHtml(name)}</span>
              </div>
              <div class="dataset-detail-row">
                <span class="dataset-detail-label">Source dataset description</span>
                <div class="dataset-detail-notes-value">${note ? escapeHtml(note) : '<span class="prompt-detail-placeholder">No description.</span>'}</div>
              </div>
            </div>
            <div class="dataset-detail-edit">
              <div class="dataset-detail-row">
                <label class="dataset-detail-label" for="dataset-detail-name-inp">Source dataset name</label>
                <input type="text" id="dataset-detail-name-inp" class="dataset-detail-input" placeholder="Source dataset name (required)" />
              </div>
              <div class="dataset-detail-row">
                <label class="dataset-detail-label" for="dataset-detail-notes-inp">Source dataset description</label>
                <textarea id="dataset-detail-notes-inp" class="dataset-detail-textarea" rows="3" placeholder="Source dataset description (required)"></textarea>
              </div>
            </div>
            <div class="dataset-detail-footer">
              <div class="prompt-detail-inline-error dataset-detail-name-error" role="alert" aria-live="polite" hidden></div>
              <button type="button" class="btn btn-secondary dataset-detail-btn-edit">Edit</button>
              <div class="dataset-detail-footer-edit">
                <button type="button" class="btn btn-secondary dataset-detail-btn-save">Save</button>
                <button type="button" class="btn btn-secondary dataset-detail-btn-cancel">Cancel</button>
              </div>
            </div>
          </div>
          <div class="dataset-detail-sampler-card">
            <h3 class="dataset-detail-sampler-title">Dataset sampler</h3>
            <div class="dataset-detail-sampler-body">
              <div class="dataset-detail-row">
                <label class="dataset-detail-label" for="sampler-name-inp">Sampler name</label>
                <input type="text" id="sampler-name-inp" class="dataset-detail-input dataset-meta-input" placeholder="Sampler name (required)" />
              </div>
              <div class="dataset-detail-row">
                <span class="dataset-detail-label">Sampling</span>
                <div class="sampler-radio-group">
                  <label class="sampler-radio-label"><input type="radio" name="sampler-replacement" value="with-replacement" /> With replacement</label>
                  <label class="sampler-radio-label"><input type="radio" name="sampler-replacement" value="without-replacement" checked /> Without replacement</label>
                  <label class="sampler-radio-label"><input type="radio" name="sampler-replacement" value="specify-rows" /> Specify rows</label>
                </div>
              </div>
              <div class="sampler-size-wrap">
              <div class="dataset-detail-row">
                <span class="dataset-detail-label">Sample size</span>
                <div class="sampler-radio-group">
                  <label class="sampler-radio-label"><input type="radio" name="sampler-size-type" value="rows" checked /> Rows</label>
                  <label class="sampler-radio-label"><input type="radio" name="sampler-size-type" value="ratio" /> Ratio</label>
                </div>
              </div>
              <div class="dataset-detail-row sampler-size-rows-wrap">
                <label class="dataset-detail-label" for="sampler-rows-inp">Rows</label>
                <input type="number" id="sampler-rows-inp" class="dataset-detail-input dataset-meta-input" min="1" placeholder="Required when using rows" />
              </div>
              <div class="dataset-detail-row sampler-size-ratio-wrap" style="display: none;">
                <label class="dataset-detail-label" for="sampler-ratio-inp">Ratio (%)</label>
                <input type="number" id="sampler-ratio-inp" class="dataset-detail-input dataset-meta-input" min="1" max="100" placeholder="1–100" aria-label="Ratio percentage (1–100)" />
              </div>
              </div>
              <div class="sampler-specify-rows-wrap" style="display: none;">
                <div class="dataset-detail-row sampler-row-spec-block">
                  <span class="dataset-detail-label">Add row</span>
                  <div class="sampler-row-spec-add-row">
                    <input type="number" id="sampler-add-number-inp" class="dataset-detail-input dataset-meta-input sampler-add-number-inp" min="1" placeholder="1" aria-label="Row number (1-based)" />
                    <button type="button" class="btn btn-secondary sampler-add-number-btn">Add</button>
                  </div>
                </div>
                <div class="dataset-detail-row sampler-row-spec-block">
                  <span class="dataset-detail-label">Add range</span>
                  <div class="sampler-row-spec-add-row">
                    <input type="number" id="sampler-add-range-from" class="dataset-detail-input dataset-meta-input sampler-add-range-inp" min="1" placeholder="From" aria-label="From row" />
                    <span class="sampler-row-spec-to-label">to</span>
                    <input type="number" id="sampler-add-range-to" class="dataset-detail-input dataset-meta-input sampler-add-range-inp" min="1" placeholder="To" aria-label="To row" />
                    <button type="button" class="btn btn-secondary sampler-add-range-btn">Add range</button>
                  </div>
                </div>
                <div class="dataset-detail-row">
                  <div class="sampler-row-spec-list" role="list" aria-label="Selected row numbers and ranges"></div>
                </div>
              </div>
              <div class="prompt-form-error sampler-form-error" role="alert" aria-live="polite" hidden></div>
            </div>
            <div class="dataset-detail-sampler-footer">
              <button type="button" class="btn btn-secondary dataset-detail-btn-create-sampler">Create sampler</button>
            </div>
          </div>
        </div>
        <div class="dataset-detail-col dataset-detail-col--right">
          <div class="dataset-preview-wrap dataset-detail-preview-area">
            <div class="dataset-detail-preview-search-wrap">
              <span class="dataset-detail-label dataset-detail-preview-caption">Source dataset preview</span>
              <label class="dataset-detail-search-label" for="dataset-detail-preview-search">Search</label>
              <input type="text" id="dataset-detail-preview-search" class="dataset-detail-input dataset-detail-preview-search-inp" placeholder="Filter rows by cell content..." aria-label="Search in preview" />
            </div>
            <div class="dataset-preview">
              <div class="dataset-detail-preview-inner"></div>
            </div>
            <div class="dataset-detail-preview-toolbar">
              <label class="dataset-detail-rows-label" for="dataset-detail-rows-per-page">Rows per page</label>
              <select id="dataset-detail-rows-per-page" class="dataset-detail-rows-select" aria-label="Rows per page">
                ${ROWS_PER_PAGE_OPTIONS.map((n) => `<option value="${n}" ${n === 25 ? 'selected' : ''}>${n}</option>`).join('')}
              </select>
              <span class="dataset-detail-pagination-info" aria-live="polite"></span>
              <label class="dataset-detail-page-label" for="dataset-detail-page-inp">Page</label>
              <input type="number" id="dataset-detail-page-inp" class="dataset-detail-page-inp" min="1" value="1" aria-label="Page number" />
              <span class="dataset-detail-page-of">/ 1</span>
              <div class="dataset-detail-pagination-btns">
                <button type="button" class="btn btn-secondary dataset-detail-prev-page" aria-label="Previous page">Previous</button>
                <button type="button" class="btn btn-secondary dataset-detail-next-page" aria-label="Next page">Next</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const panel = overlay.querySelector('.modal-panel--dataset-detail');
  const nameValueEl = overlay.querySelector('.dataset-detail-name-value');
  const notesValueEl = overlay.querySelector('.dataset-detail-notes-value');
  const nameInp = overlay.querySelector('#dataset-detail-name-inp');
  const notesInp = overlay.querySelector('#dataset-detail-notes-inp');
  const btnEdit = overlay.querySelector('.dataset-detail-btn-edit');
  const footerEdit = overlay.querySelector('.dataset-detail-footer-edit');
  const btnCancel = overlay.querySelector('.dataset-detail-btn-cancel');
  const btnSave = overlay.querySelector('.dataset-detail-btn-save');
  const nameErrorEl = overlay.querySelector('.dataset-detail-name-error');
  const rowsPerPageSelect = overlay.querySelector('#dataset-detail-rows-per-page');
  const paginationInfo = overlay.querySelector('.dataset-detail-pagination-info');
  const previewInner = overlay.querySelector('.dataset-detail-preview-inner');
  const prevPageBtn = overlay.querySelector('.dataset-detail-prev-page');
  const nextPageBtn = overlay.querySelector('.dataset-detail-next-page');
  const pageInp = overlay.querySelector('#dataset-detail-page-inp');
  const pageOfSpan = overlay.querySelector('.dataset-detail-page-of');
  const btnCreateSampler = overlay.querySelector('.dataset-detail-btn-create-sampler');
  const samplerNameInp = overlay.querySelector('#sampler-name-inp');
  const samplerRowsInp = overlay.querySelector('#sampler-rows-inp');
  const samplerRatioInp = overlay.querySelector('#sampler-ratio-inp');
  const samplerSizeWrap = overlay.querySelector('.sampler-size-wrap');
  const samplerSizeRowsWrap = overlay.querySelector('.sampler-size-rows-wrap');
  const samplerSizeRatioWrap = overlay.querySelector('.sampler-size-ratio-wrap');
  const samplerSpecifyRowsWrap = overlay.querySelector('.sampler-specify-rows-wrap');
  const samplerRowSpecList = overlay.querySelector('.sampler-row-spec-list');
  const samplerAddNumberInp = overlay.querySelector('#sampler-add-number-inp');
  const samplerAddNumberBtn = overlay.querySelector('.sampler-add-number-btn');
  const samplerAddRangeFrom = overlay.querySelector('#sampler-add-range-from');
  const samplerAddRangeTo = overlay.querySelector('#sampler-add-range-to');
  const samplerAddRangeBtn = overlay.querySelector('.sampler-add-range-btn');
  const samplerFormErrorEl = overlay.querySelector('.sampler-form-error');

  const rowSpecItems = [];
  function renderRowSpecList() {
    if (!samplerRowSpecList) return;
    samplerRowSpecList.innerHTML = '';
    rowSpecItems.forEach((item, idx) => {
      const chip = document.createElement('span');
      chip.className = 'sampler-row-spec-chip';
      chip.setAttribute('role', 'listitem');
      if (item.type === 'single') {
        chip.textContent = String(item.value);
      } else {
        chip.textContent = `${item.from}–${item.to}`;
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'sampler-row-spec-chip-remove';
      remove.setAttribute('aria-label', 'Remove');
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        rowSpecItems.splice(idx, 1);
        renderRowSpecList();
      });
      chip.appendChild(remove);
      samplerRowSpecList.appendChild(chip);
    });
  }
  function buildRowSpecString() {
    return rowSpecItems.map((item) => (item.type === 'single' ? String(item.value) : `${item.from}-${item.to}`)).join(' ');
  }
  const previewSearchInp = overlay.querySelector('#dataset-detail-preview-search');

  let currentPage = 1;
  let rowsPerPage = 25;
  let totalPages = 1;
  let previewSearchQuery = '';

  function getContent() {
    const content = getDatasetContent();
    const headers = content?.headers ?? [];
    const rows = content?.rows ?? [];
    return { headers, rows };
  }

  function renderPreview() {
    const { headers, rows } = getContent();
    const totalRows = rows.length;
    if (headers.length === 0 || totalRows === 0) {
      previewInner.innerHTML = '<p class="dataset-detail-no-data">No data.</p>';
      paginationInfo.textContent = '0 rows';
      totalPages = 1;
      if (prevPageBtn) prevPageBtn.disabled = true;
      if (nextPageBtn) nextPageBtn.disabled = true;
      if (pageInp) {
        pageInp.value = '1';
        pageInp.max = '1';
      }
      if (pageOfSpan) pageOfSpan.textContent = '/ 1';
      return;
    }
    const searchLower = (previewSearchQuery || '').trim().toLowerCase();
    const filteredIndices = searchLower
      ? rows.map((row, i) => (row.some((cell) => String(cell ?? '').toLowerCase().includes(searchLower)) ? i : -1)).filter((i) => i >= 0)
      : rows.map((_, i) => i);
    const filteredTotal = filteredIndices.length;
    totalPages = Math.max(1, Math.ceil(filteredTotal / rowsPerPage));
    currentPage = Math.min(currentPage, totalPages);
    const start = (currentPage - 1) * rowsPerPage;
    const end = Math.min(start + rowsPerPage, filteredTotal);
    const pageIndices = filteredIndices.slice(start, end);
    const pageRows = pageIndices.map((i) => rows[i]);

    paginationInfo.textContent = filteredTotal === totalRows
      ? `Showing ${start + 1}–${end} of ${totalRows.toLocaleString()} rows`
      : `Showing ${start + 1}–${end} of ${filteredTotal.toLocaleString()} (filtered from ${totalRows.toLocaleString()}) rows`;

    const table = document.createElement('table');
    table.className = 'dataset-preview-table dataset-detail-preview-table';
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const thRowNum = document.createElement('th');
    thRowNum.className = 'dataset-detail-preview-row-num';
    thRowNum.textContent = '#';
    thRowNum.title = 'Row';
    headerRow.appendChild(thRowNum);
    headers.forEach((h) => {
      const th = document.createElement('th');
      th.textContent = truncate(h);
      th.title = h;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    pageRows.forEach((row, rowIdx) => {
      const originalRowNum = pageIndices[rowIdx] + 1;
      const tr = document.createElement('tr');
      const tdRowNum = document.createElement('td');
      tdRowNum.className = 'dataset-detail-preview-row-num';
      tdRowNum.textContent = String(originalRowNum);
      tr.appendChild(tdRowNum);
      headers.forEach((_, i) => {
        const td = document.createElement('td');
        const val = row[i];
        td.textContent = truncate(val);
        td.title = val ?? '';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    previewInner.innerHTML = '';
    previewInner.appendChild(table);

    if (prevPageBtn) {
      prevPageBtn.disabled = currentPage <= 1;
    }
    if (nextPageBtn) {
      nextPageBtn.disabled = currentPage >= totalPages;
    }
    if (pageInp) {
      pageInp.value = String(currentPage);
      pageInp.max = String(totalPages);
      pageInp.min = '1';
    }
    if (pageOfSpan) {
      pageOfSpan.textContent = '/ ' + totalPages;
    }
  }

  function applyToNode(newName, newNote) {
    if (!node) return;
    node.dataset.datasetName = newName;
    node.dataset.datasetNote = newNote;
    const titleEl = node.querySelector('.workflow-node__title');
    if (titleEl) titleEl.textContent = newName || 'Source dataset';
    const bodyEl = node.querySelector('.workflow-node__body');
    const noteTrimmed = (newNote || '').trim();
    if (noteTrimmed) {
      node.classList.remove('workflow-node--no-body');
      if (bodyEl) {
        const noteEl = bodyEl.querySelector('.workflow-node__note');
        if (noteEl) noteEl.textContent = noteTrimmed;
        else bodyEl.innerHTML = `<span class="workflow-node__note">${escapeHtml(noteTrimmed)}</span>`;
      } else {
        const div = document.createElement('div');
        div.className = 'workflow-node__body';
        div.innerHTML = `<span class="workflow-node__note">${escapeHtml(noteTrimmed)}</span>`;
        node.appendChild(div);
      }
    } else {
      if (bodyEl) bodyEl.remove();
      node.classList.add('workflow-node--no-body');
    }
  }

  function showView() {
    panel.setAttribute('data-dataset-detail-mode', 'view');
  }

  function showEdit() {
    nameInp.value = nameValueEl.textContent.trim() || '';
    notesInp.value = notesValueEl.querySelector('.prompt-detail-placeholder') ? '' : (notesValueEl.textContent || '').trim();
    if (nameErrorEl) nameErrorEl.hidden = true;
    panel.setAttribute('data-dataset-detail-mode', 'edit');
  }

  rowsPerPageSelect.addEventListener('change', () => {
    rowsPerPage = parseInt(rowsPerPageSelect.value, 10);
    currentPage = 1;
    renderPreview();
  });
  if (previewSearchInp) {
    previewSearchInp.addEventListener('input', () => {
      previewSearchQuery = (previewSearchInp.value || '').trim();
      currentPage = 1;
      renderPreview();
    });
  }
  if (prevPageBtn) {
    prevPageBtn.addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage--;
        renderPreview();
      }
    });
  }
  if (nextPageBtn) {
    nextPageBtn.addEventListener('click', () => {
      if (currentPage < totalPages) {
        currentPage++;
        renderPreview();
      }
    });
  }
  if (pageInp) {
    pageInp.addEventListener('change', () => {
      const n = parseInt(pageInp.value, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= totalPages) {
        currentPage = n;
        renderPreview();
      } else {
        pageInp.value = String(currentPage);
      }
    });
    pageInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        pageInp.blur();
      }
    });
  }

  btnEdit.addEventListener('click', showEdit);
  btnCancel.addEventListener('click', showView);
  btnSave.addEventListener('click', () => {
    const newName = (nameInp.value || '').trim();
    const newNote = (notesInp.value || '').trim();
    if (nameErrorEl) nameErrorEl.hidden = true;
    if (!newName) {
      if (nameErrorEl) {
        nameErrorEl.textContent = 'Source dataset name is required.';
        nameErrorEl.hidden = false;
      }
      return;
    }
    if (!newNote) {
      if (nameErrorEl) {
        nameErrorEl.textContent = 'Source dataset description is required.';
        nameErrorEl.hidden = false;
      }
      return;
    }
    const nameUsed = isDatasetNameAlreadyUsed?.(newName, nodeId);
    if (nameUsed) {
      if (nameErrorEl) {
        nameErrorEl.textContent = 'This source dataset name is already used on the canvas. Please choose another.';
        nameErrorEl.hidden = false;
      }
      return;
    }
    nameValueEl.textContent = newName;
    notesValueEl.innerHTML = newNote ? escapeHtml(newNote) : '<span class="prompt-detail-placeholder">No description.</span>';
    applyToNode(newName, newNote);
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    showView();
  });

  function updateSamplerModeVisibility() {
    const samplingType = overlay.querySelector('input[name="sampler-replacement"]:checked')?.value || 'without-replacement';
    const isSpecifyRows = samplingType === 'specify-rows';
    if (samplerSizeWrap) samplerSizeWrap.style.display = isSpecifyRows ? 'none' : '';
    if (samplerSpecifyRowsWrap) samplerSpecifyRowsWrap.style.display = isSpecifyRows ? 'flex' : 'none';
  }
  overlay.querySelectorAll('input[name="sampler-replacement"]').forEach((radio) => {
    radio.addEventListener('change', updateSamplerModeVisibility);
  });
  updateSamplerModeVisibility();

  overlay.querySelectorAll('input[name="sampler-size-type"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const isRows = overlay.querySelector('input[name="sampler-size-type"]:checked')?.value === 'rows';
      if (samplerSizeRowsWrap) samplerSizeRowsWrap.style.display = isRows ? '' : 'none';
      if (samplerSizeRatioWrap) samplerSizeRatioWrap.style.display = isRows ? 'none' : '';
    });
  });
  if (samplerSizeRatioWrap) samplerSizeRatioWrap.style.display = 'none';

  function addSingleRow() {
    if (!samplerAddNumberInp) return;
    const n = parseInt(samplerAddNumberInp.value, 10);
    if (!Number.isFinite(n) || n < 1) return;
    rowSpecItems.push({ type: 'single', value: n });
    renderRowSpecList();
    samplerAddNumberInp.value = '';
    samplerAddNumberInp.focus();
  }
  if (samplerAddNumberBtn && samplerAddNumberInp) {
    samplerAddNumberBtn.addEventListener('click', addSingleRow);
    samplerAddNumberInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSingleRow(); } });
  }
  if (samplerAddRangeBtn && samplerAddRangeFrom && samplerAddRangeTo) {
    samplerAddRangeBtn.addEventListener('click', () => {
      const from = parseInt(samplerAddRangeFrom.value, 10);
      const to = parseInt(samplerAddRangeTo.value, 10);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < 1) return;
      const low = Math.min(from, to);
      const high = Math.max(from, to);
      rowSpecItems.push({ type: 'range', from: low, to: high });
      renderRowSpecList();
      samplerAddRangeFrom.value = '';
      samplerAddRangeTo.value = '';
    });
  }

  if (btnCreateSampler) {
    btnCreateSampler.addEventListener('click', () => {
      if (samplerFormErrorEl) samplerFormErrorEl.hidden = true;
      const name = (samplerNameInp?.value || '').trim();
      const samplingType = overlay.querySelector('input[name="sampler-replacement"]:checked')?.value || 'without-replacement';
      const isSpecifyRows = samplingType === 'specify-rows';
      const rowSpec = isSpecifyRows ? buildRowSpecString() : '';
      const sampleSizeType = overlay.querySelector('input[name="sampler-size-type"]:checked')?.value || 'rows';
      const rowsValue = samplerRowsInp?.value != null ? samplerRowsInp.value.trim() : '';
      const rowsNum = sampleSizeType === 'rows' ? parseInt(rowsValue, 10) : NaN;
      const ratioValue = samplerRatioInp?.value != null ? samplerRatioInp.value.trim() : '';
      const ratioNum = sampleSizeType === 'ratio' ? parseInt(ratioValue, 10) : NaN;
      const sampleSize = sampleSizeType === 'rows' ? (Number.isFinite(rowsNum) && rowsNum >= 1 ? rowsNum : 0) : (Number.isFinite(ratioNum) && ratioNum >= 1 && ratioNum <= 100 ? ratioNum : 50);

      if (!name) {
        if (samplerFormErrorEl) {
          samplerFormErrorEl.textContent = 'Sampler name is required.';
          samplerFormErrorEl.hidden = false;
        }
        return;
      }
      if (isSpecifyRows) {
        if (rowSpecItems.length === 0) {
          if (samplerFormErrorEl) {
            samplerFormErrorEl.textContent = 'Add at least one row number or range.';
            samplerFormErrorEl.hidden = false;
          }
          return;
        }
      } else if (sampleSizeType === 'rows' && (!Number.isFinite(rowsNum) || rowsNum < 1)) {
        if (samplerFormErrorEl) {
          samplerFormErrorEl.textContent = 'Sample size (rows) is required. Enter at least 1 row.';
          samplerFormErrorEl.hidden = false;
        }
        return;
      } else if (sampleSizeType === 'ratio' && (!Number.isFinite(ratioNum) || ratioNum < 1 || ratioNum > 100)) {
        if (samplerFormErrorEl) {
          samplerFormErrorEl.textContent = 'Ratio is required. Enter a number between 1 and 100.';
          samplerFormErrorEl.hidden = false;
        }
        return;
      }
      if (isSamplerNameAlreadyUsedForSource?.(name, nodeId, null)) {
        if (samplerFormErrorEl) {
          samplerFormErrorEl.textContent = 'This sampler name is already used for this source dataset. Please choose another.';
          samplerFormErrorEl.hidden = false;
        }
        return;
      }

      const colorIndex = node?.dataset?.datasetColorIndex != null ? parseInt(node.dataset.datasetColorIndex, 10) : undefined;
      const detail = { sourceNodeId: nodeId, colorIndex, name, samplingType };
      if (isSpecifyRows) {
        detail.rowSpec = rowSpec;
      } else {
        detail.sampleSizeType = sampleSizeType;
        detail.sampleSize = sampleSize;
      }
      document.dispatchEvent(new CustomEvent('workflow:add-sampler-node', { detail }));
      close();
    });
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);

  function close() {
    overlay.remove();
    document.body.style.overflow = '';
  }

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  renderPreview();
}
