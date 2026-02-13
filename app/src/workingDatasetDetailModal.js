/**
 * Working dataset detail modal: name/description (left), table view and editor (right).
 * @param {{ node: HTMLElement, getContent: () => { headers: string[], rows: string[][] }, saveContent: (content: { headers: string[], rows: string[][] }) => void, isSubsetNameAlreadyUsed?: (name: string, excludeNodeId?: string | null) => boolean }} options
 */

const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function openWorkingDatasetDetailModal({ node, getContent, saveContent, isSubsetNameAlreadyUsed }) {
  const name = (node?.dataset?.subsetName ?? '').trim() || 'Working dataset';
  const note = (node?.dataset?.subsetNote ?? '').trim();

  let headers = [];
  let rows = [];
  try {
    const c = getContent();
    headers = Array.isArray(c?.headers) ? c.headers.slice() : [];
    rows = Array.isArray(c?.rows) ? c.rows.map((r) => r.slice()) : [];
  } catch (_) {}

  if (headers.length === 0) {
    headers = ['Column 1'];
    rows = rows.length ? rows : [];
  }

  let currentPage = 1;
  let rowsPerPage = 25;
  let searchQuery = '';
  let selectedRowIndex = -1;
  let selectedColIndex = -1;
  const initialHeaders = headers.map((h) => h);
  const initialRows = rows.map((r) => r.slice());

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'working-dataset-detail-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--working-dataset-detail" data-working-dataset-detail-mode="view">
      <div class="modal-header">
        <h2 id="working-dataset-detail-title" class="modal-title">Working dataset details: ${escapeHtml(name)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body working-dataset-detail-body dataset-detail-body">
        <div class="dataset-detail-col dataset-detail-col--left">
          <div class="dataset-detail-card">
            <div class="dataset-detail-view">
              <div class="dataset-detail-row">
                <span class="dataset-detail-label">Working dataset name</span>
                <span class="dataset-detail-name-value wd-name-value">${escapeHtml(name)}</span>
              </div>
              <div class="dataset-detail-row">
                <span class="dataset-detail-label">Working dataset description</span>
                <div class="dataset-detail-notes-value wd-notes-value">${note ? escapeHtml(note) : '<span class="prompt-detail-placeholder">No description.</span>'}</div>
              </div>
            </div>
            <div class="dataset-detail-edit">
              <div class="dataset-detail-row">
                <label class="dataset-detail-label" for="wd-name-inp">Working dataset name</label>
                <input type="text" id="wd-name-inp" class="dataset-detail-input" placeholder="Working dataset name (required)" />
              </div>
              <div class="dataset-detail-row">
                <label class="dataset-detail-label" for="wd-notes-inp">Working dataset description</label>
                <textarea id="wd-notes-inp" class="dataset-detail-textarea" rows="3" placeholder="Working dataset description (optional)"></textarea>
              </div>
            </div>
            <div class="dataset-detail-footer">
              <div class="prompt-detail-inline-error wd-name-error" role="alert" aria-live="polite" hidden></div>
              <button type="button" class="btn btn-secondary dataset-detail-btn-edit wd-btn-edit">Edit</button>
              <div class="dataset-detail-footer-edit">
                <button type="button" class="btn btn-secondary dataset-detail-btn-save wd-btn-save">Save</button>
                <button type="button" class="btn btn-secondary dataset-detail-btn-cancel wd-btn-cancel">Cancel</button>
              </div>
            </div>
          </div>
        </div>
        <div class="dataset-detail-col dataset-detail-col--right">
        <div class="working-dataset-detail-card">
          <div class="dataset-detail-preview-search-wrap working-dataset-search-wrap">
            <span class="dataset-detail-label dataset-detail-preview-caption">Working dataset preview</span>
            <label class="dataset-detail-search-label" for="wd-preview-search">Search</label>
            <input type="text" id="wd-preview-search" class="dataset-detail-input dataset-detail-preview-search-inp" placeholder="Filter rows by cell content..." aria-label="Search in table" />
          </div>
          <div class="working-dataset-table-wrap">
            <table class="dataset-preview-table working-dataset-edit-table">
              <thead><tr class="wd-header-row"></tr></thead>
              <tbody class="wd-tbody"></tbody>
            </table>
          </div>
          <div class="dataset-detail-preview-toolbar working-dataset-pagination-toolbar">
            <label class="dataset-detail-rows-label" for="wd-rows-per-page">Rows per page</label>
            <select id="wd-rows-per-page" class="dataset-detail-rows-select" aria-label="Rows per page">
              ${ROWS_PER_PAGE_OPTIONS.map((n) => `<option value="${n}" ${n === 25 ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
            <span class="dataset-detail-pagination-info wd-pagination-info" aria-live="polite"></span>
            <label class="dataset-detail-page-label" for="wd-page-inp">Page</label>
            <input type="number" id="wd-page-inp" class="dataset-detail-page-inp" min="1" value="1" aria-label="Page number" />
            <span class="dataset-detail-page-of wd-page-of">/ 1</span>
            <div class="dataset-detail-pagination-btns">
              <button type="button" class="btn btn-secondary wd-prev-page" aria-label="Previous page">Previous</button>
              <button type="button" class="btn btn-secondary wd-next-page" aria-label="Next page">Next</button>
            </div>
          </div>
          <div class="dataset-detail-footer working-dataset-detail-footer">
            <button type="button" class="btn btn-secondary working-dataset-add-row">Add row</button>
            <button type="button" class="btn btn-secondary working-dataset-add-col">Add column</button>
            <button type="button" class="btn btn-secondary working-dataset-delete-row">Delete row</button>
            <button type="button" class="btn btn-secondary working-dataset-delete-col">Delete column</button>
          </div>
        </div>
        </div>
      </div>
    </div>
  `;

  const panel = overlay.querySelector('.modal-panel--working-dataset-detail');
  const titleEl = overlay.querySelector('#working-dataset-detail-title');
  const nameValueEl = overlay.querySelector('.wd-name-value');
  const notesValueEl = overlay.querySelector('.wd-notes-value');
  const nameInp = overlay.querySelector('#wd-name-inp');
  const notesInp = overlay.querySelector('#wd-notes-inp');
  const wdNameErrorEl = overlay.querySelector('.wd-name-error');
  const btnEdit = overlay.querySelector('.wd-btn-edit');
  const btnSave = overlay.querySelector('.wd-btn-save');
  const btnCancel = overlay.querySelector('.wd-btn-cancel');
  const theadRow = overlay.querySelector('.wd-header-row');
  const tbody = overlay.querySelector('.wd-tbody');
  const paginationInfo = overlay.querySelector('.wd-pagination-info');
  const pageInp = overlay.querySelector('#wd-page-inp');
  const pageOfSpan = overlay.querySelector('.wd-page-of');
  const prevBtn = overlay.querySelector('.wd-prev-page');
  const nextBtn = overlay.querySelector('.wd-next-page');
  const rowsPerPageSelect = overlay.querySelector('#wd-rows-per-page');
  const addRowBtn = overlay.querySelector('.working-dataset-add-row');
  const addColBtn = overlay.querySelector('.working-dataset-add-col');
  const deleteRowBtn = overlay.querySelector('.working-dataset-delete-row');
  const deleteColBtn = overlay.querySelector('.working-dataset-delete-col');
  const searchInp = overlay.querySelector('#wd-preview-search');

  function applyNameAndNoteToNode(newName, newNote) {
    if (!node) return;
    node.dataset.subsetName = newName;
    node.dataset.subsetNote = newNote || '';
    const nodeTitleEl = node.querySelector('.workflow-node__title');
    if (nodeTitleEl) nodeTitleEl.textContent = (newName && newName.trim()) ? newName.trim() : 'Working dataset';
    if (titleEl) titleEl.textContent = `Working dataset details: ${(newName && newName.trim()) ? newName.trim() : 'Working dataset'}`;
  }

  function showMetaView() {
    panel.setAttribute('data-working-dataset-detail-mode', 'view');
  }

  function showMetaEdit() {
    if (nameInp) nameInp.value = (nameValueEl && nameValueEl.textContent) ? nameValueEl.textContent.trim() : '';
    if (notesInp) notesInp.value = notesValueEl && notesValueEl.querySelector('.prompt-detail-placeholder') ? '' : (notesValueEl ? (notesValueEl.textContent || '').trim() : '');
    if (wdNameErrorEl) wdNameErrorEl.hidden = true;
    panel.setAttribute('data-working-dataset-detail-mode', 'edit');
  }

  if (btnEdit) btnEdit.addEventListener('click', showMetaEdit);
  if (btnCancel) btnCancel.addEventListener('click', showMetaView);
  if (btnSave) btnSave.addEventListener('click', () => {
    const newName = (nameInp?.value || '').trim();
    const newNote = (notesInp?.value || '').trim();
    if (wdNameErrorEl) wdNameErrorEl.hidden = true;
    if (!newName) {
      if (wdNameErrorEl) {
        wdNameErrorEl.textContent = 'Working dataset name is required.';
        wdNameErrorEl.hidden = false;
      }
      return;
    }
    const nameUsed = isSubsetNameAlreadyUsed?.(newName, node?.dataset?.nodeId);
    if (nameUsed) {
      if (wdNameErrorEl) {
        wdNameErrorEl.textContent = 'This working dataset name is already used on the canvas. Please choose another.';
        wdNameErrorEl.hidden = false;
      }
      return;
    }
    if (nameValueEl) nameValueEl.textContent = newName;
    if (notesValueEl) notesValueEl.innerHTML = newNote ? escapeHtml(newNote) : '<span class="prompt-detail-placeholder">No description.</span>';
    applyNameAndNoteToNode(newName, newNote);
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    showMetaView();
  });

  function getFilteredIndices() {
    const q = (searchQuery || '').trim().toLowerCase();
    if (!q) return rows.map((_, i) => i);
    return rows.map((row, i) => (row.some((cell) => String(cell ?? '').toLowerCase().includes(q)) ? i : -1)).filter((i) => i >= 0);
  }

  function getTotalPages() {
    const filtered = getFilteredIndices();
    return Math.max(1, Math.ceil(filtered.length / rowsPerPage));
  }

  function render() {
    const filteredIndices = getFilteredIndices();
    const totalPages = Math.max(1, Math.ceil(filteredIndices.length / rowsPerPage));
    currentPage = Math.min(Math.max(1, currentPage), totalPages);
    const start = (currentPage - 1) * rowsPerPage;
    const end = Math.min(start + rowsPerPage, filteredIndices.length);
    const pageIndices = filteredIndices.slice(start, end);
    const pageRows = pageIndices.map((i) => rows[i]);

    // Header row: # + editable headers (click header to select column for delete)
    theadRow.innerHTML = '';
    const thNum = document.createElement('th');
    thNum.className = 'dataset-detail-preview-row-num';
    thNum.textContent = '#';
    theadRow.appendChild(thNum);
    headers.forEach((h, colIdx) => {
      const th = document.createElement('th');
      th.dataset.colIndex = String(colIdx);
      th.className = selectedColIndex === colIdx ? 'wd-header-th wd-col-selected' : 'wd-header-th';
      th.addEventListener('click', () => {
        selectedColIndex = selectedColIndex === colIdx ? -1 : colIdx;
        selectedRowIndex = -1;
        render();
      });
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'wd-cell-inp wd-header-inp';
      inp.value = h;
      inp.dataset.colIndex = String(colIdx);
      inp.addEventListener('change', () => {
        const idx = parseInt(inp.dataset.colIndex, 10);
        if (Number.isFinite(idx) && idx >= 0 && idx < headers.length) headers[idx] = inp.value.trim() || '';
      });
      inp.addEventListener('click', (e) => e.stopPropagation());
      th.appendChild(inp);
      theadRow.appendChild(th);
    });

    tbody.innerHTML = '';
    pageRows.forEach((row, pageRowIdx) => {
      const originalRowIdx = pageIndices[pageRowIdx];
      const originalRowNum = originalRowIdx + 1;
      const tr = document.createElement('tr');
      tr.dataset.rowIndex = String(originalRowIdx);
      if (selectedRowIndex === originalRowIdx) tr.classList.add('wd-row-selected');
      const tdNum = document.createElement('td');
      tdNum.className = 'dataset-detail-preview-row-num wd-row-num-cell';
      tdNum.textContent = String(originalRowNum);
      tdNum.addEventListener('click', () => {
        selectedRowIndex = selectedRowIndex === originalRowIdx ? -1 : originalRowIdx;
        selectedColIndex = -1;
        render();
      });
      tr.appendChild(tdNum);
      const rowData = row.length >= headers.length ? row : [...row, ...Array(headers.length - row.length).fill('')];
      headers.forEach((_, colIdx) => {
        const td = document.createElement('td');
        if (selectedColIndex === colIdx) td.classList.add('wd-col-selected');
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'wd-cell-inp';
        inp.value = rowData[colIdx] ?? '';
        inp.dataset.rowIndex = String(originalRowIdx);
        inp.dataset.colIndex = String(colIdx);
        inp.addEventListener('change', () => {
          const ri = parseInt(inp.dataset.rowIndex, 10);
          const ci = parseInt(inp.dataset.colIndex, 10);
          if (Number.isFinite(ri) && Number.isFinite(ci) && rows[ri]) {
            while (rows[ri].length <= ci) rows[ri].push('');
            rows[ri][ci] = inp.value;
          }
        });
        td.appendChild(inp);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    const totalFiltered = filteredIndices.length;
    if (rows.length === 0) {
      paginationInfo.textContent = '0 rows';
    } else if (totalFiltered === 0) {
      paginationInfo.textContent = `0 rows (filtered from ${rows.length.toLocaleString()})`;
    } else {
      paginationInfo.textContent = totalFiltered === rows.length
        ? `Showing ${start + 1}–${end} of ${rows.length.toLocaleString()} rows`
        : `Showing ${start + 1}–${end} of ${totalFiltered.toLocaleString()} (filtered from ${rows.length.toLocaleString()}) rows`;
    }
    if (pageInp) {
      pageInp.value = String(currentPage);
      pageInp.max = String(totalPages);
    }
    if (pageOfSpan) pageOfSpan.textContent = `/ ${totalPages}`;
    if (prevBtn) prevBtn.disabled = currentPage <= 1;
    if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
    updateDeleteButtons();
  }

  addRowBtn.addEventListener('click', () => {
    rows.push(Array(headers.length).fill(''));
    render();
  });

  addColBtn.addEventListener('click', () => {
    headers.push(`Column ${headers.length + 1}`);
    rows.forEach((r) => r.push(''));
    render();
  });

  deleteRowBtn.addEventListener('click', () => {
    if (rows.length === 0 || selectedRowIndex < 0 || selectedRowIndex >= rows.length) return;
    rows.splice(selectedRowIndex, 1);
    selectedRowIndex = -1;
    const totalPages = Math.max(1, Math.ceil(rows.length / rowsPerPage));
    if (currentPage > totalPages) currentPage = totalPages;
    render();
  });

  deleteColBtn.addEventListener('click', () => {
    if (headers.length <= 1 || selectedColIndex < 0 || selectedColIndex >= headers.length) return;
    headers.splice(selectedColIndex, 1);
    rows.forEach((r) => r.splice(selectedColIndex, 1));
    selectedColIndex = -1;
    render();
  });

  function updateDeleteButtons() {
    const hasRowSelected = selectedRowIndex >= 0 && selectedRowIndex < rows.length;
    const hasColSelected = selectedColIndex >= 0 && selectedColIndex < headers.length;
    deleteRowBtn.disabled = rows.length === 0 || !hasRowSelected;
    deleteColBtn.disabled = headers.length <= 1 || !hasColSelected;
  }

  function isDirty() {
    if (headers.length !== initialHeaders.length) return true;
    if (rows.length !== initialRows.length) return true;
    for (let i = 0; i < headers.length; i++) {
      if ((headers[i] ?? '') !== (initialHeaders[i] ?? '')) return true;
    }
    for (let i = 0; i < rows.length; i++) {
      const a = initialRows[i] ?? [];
      const b = rows[i] ?? [];
      if (a.length !== b.length) return true;
      for (let j = 0; j < a.length; j++) {
        if ((a[j] ?? '') !== (b[j] ?? '')) return true;
      }
    }
    return false;
  }

  function doSave() {
    saveContent({ headers: headers.slice(), rows: rows.map((r) => r.slice()) });
  }

  function requestClose() {
    if (!isDirty()) {
      close();
      return;
    }
    const panel = overlay.querySelector('.modal-panel');
    const saveDialog = document.createElement('div');
    saveDialog.className = 'working-dataset-save-dialog-overlay';
    saveDialog.setAttribute('role', 'dialog');
    saveDialog.setAttribute('aria-labelledby', 'wd-save-dialog-title');
    saveDialog.innerHTML = `
      <div class="working-dataset-save-dialog">
        <p id="wd-save-dialog-title" class="working-dataset-save-dialog-title">Save changes before closing?</p>
        <div class="working-dataset-save-dialog-btns">
          <button type="button" class="btn btn-secondary wd-save-dialog-save">Save</button>
          <button type="button" class="btn btn-secondary wd-save-dialog-dont">Don't save</button>
          <button type="button" class="btn btn-secondary wd-save-dialog-cancel">Cancel</button>
        </div>
      </div>
    `;
    const removeDialog = () => {
      saveDialog.remove();
    };
    saveDialog.querySelector('.wd-save-dialog-save').addEventListener('click', () => {
      removeDialog();
      doSave();
      close();
    });
    saveDialog.querySelector('.wd-save-dialog-dont').addEventListener('click', () => {
      removeDialog();
      close();
    });
    saveDialog.querySelector('.wd-save-dialog-cancel').addEventListener('click', removeDialog);
    panel.appendChild(saveDialog);
  }

  overlay.querySelector('.modal-close').addEventListener('click', requestClose);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) requestClose();
  });

  if (searchInp) {
    searchInp.addEventListener('input', () => {
      searchQuery = (searchInp.value || '').trim();
      currentPage = 1;
      render();
    });
  }
  rowsPerPageSelect.addEventListener('change', () => {
    rowsPerPage = parseInt(rowsPerPageSelect.value, 10);
    currentPage = 1;
    render();
  });
  prevBtn.addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; render(); }
  });
  nextBtn.addEventListener('click', () => {
    if (currentPage < getTotalPages()) { currentPage++; render(); }
  });
  pageInp.addEventListener('change', () => {
    const n = parseInt(pageInp.value, 10);
    const totalPages = getTotalPages();
    if (!Number.isNaN(n) && n >= 1 && n <= totalPages) {
      currentPage = n;
      render();
    } else {
      pageInp.value = String(currentPage);
    }
  });

  function close() {
    overlay.remove();
    document.body.style.overflow = '';
  }

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  render();
}
