/**
 * Working dataset detail modal: table view and editor (headers + rows).
 * @param {{ node: HTMLElement, getContent: () => { headers: string[], rows: string[][] }, saveContent: (content: { headers: string[], rows: string[][] }) => void }} options
 */

const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function openWorkingDatasetDetailModal({ node, getContent, saveContent }) {
  const name = (node?.dataset?.subsetName ?? '').trim() || 'Working dataset';

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
    <div class="modal-panel modal-panel--working-dataset-detail">
      <div class="modal-header">
        <h2 id="working-dataset-detail-title" class="modal-title">Working dataset: ${escapeHtml(name)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body working-dataset-detail-body">
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
  `;

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
          <button type="button" class="btn btn-primary wd-save-dialog-save">Save</button>
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
