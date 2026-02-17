/**
 * Dataset detail modal: dataset preview only (table view, search, pagination, add/delete row/col).
 * Name and description are edited via node right-click "Edit name & description".
 * Layout follows prompt detail and add dataset style.
 * @param {{ node: HTMLElement, getContent: () => { headers: string[], rows: string[][] }, saveContent: (content: { headers: string[], rows: string[][] }) => void }} options
 */

const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100];
/** 行高下限：至少一行字高度（约 12px 字号 + 行高 + 内边距） */
const MIN_ROW_HEIGHT_PX = 28;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function openDatasetDetailModal({ node, getContent, saveContent }) {
  const name = (node?.dataset?.subsetName ?? '').trim() || 'Dataset';

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
  let columnWidths = headers.map(() => 140);
  let rowHeights = rows.map(() => undefined);
  const initialHeaders = headers.map((h) => h);
  const initialRows = rows.map((r) => r.slice());

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'working-dataset-detail-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--working-dataset-detail modal-panel--prompt-detail">
      <div class="modal-header">
        <h2 id="working-dataset-detail-title" class="modal-title">Dataset: ${escapeHtml(name)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body prompt-detail-body working-dataset-detail-body">
        <div class="prompt-detail-side prompt-preview-wrap dataset-detail-preview-side">
          <div class="prompt-detail-side-scroll">
            <div class="working-dataset-detail-card">
              <div class="dataset-detail-preview-search-wrap working-dataset-search-wrap">
                <span class="dataset-detail-preview-summary wd-summary" aria-live="polite">${headers.length} columns, ${rows.length.toLocaleString()} rows</span>
                <div class="dataset-detail-preview-search-right">
                  <label class="dataset-detail-search-label" for="wd-preview-search">Search</label>
                  <input type="text" id="wd-preview-search" class="dataset-detail-input dataset-detail-preview-search-inp" placeholder="Filter rows by cell content..." aria-label="Search in table" />
                </div>
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
                <button type="button" class="btn btn-primary working-dataset-sample">Sample</button>
              </div>
            </div>
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
  const sampleBtn = overlay.querySelector('.working-dataset-sample');
  const searchInp = overlay.querySelector('#wd-preview-search');
  const summaryEl = overlay.querySelector('.wd-summary');
  const tableWrap = overlay.querySelector('.working-dataset-table-wrap');

  const tableTooltip = document.createElement('div');
  tableTooltip.className = 'prompt-detail-schema-tooltip';
  tableTooltip.setAttribute('role', 'tooltip');
  tableTooltip.hidden = true;
  overlay.appendChild(tableTooltip);

  if (tableWrap) {
    tableWrap.addEventListener('mouseover', (e) => {
      const cell = e.target.closest('td') || e.target.closest('th');
      if (!cell || cell.classList.contains('wd-row-num-cell')) {
        tableTooltip.hidden = true;
        return;
      }
      const textarea = cell.querySelector('.wd-cell-textarea');
      const headerInp = cell.querySelector('.wd-header-inp');
      const text = textarea ? textarea.value : (headerInp ? headerInp.value : '');
      tableTooltip.textContent = text ?? '';
      tableTooltip.hidden = false;
    });
    tableWrap.addEventListener('mouseout', (e) => {
      if (!e.relatedTarget || !tableWrap.contains(e.relatedTarget)) {
        tableTooltip.hidden = true;
      }
    });
    tableWrap.addEventListener('mousemove', (e) => {
      if (tableTooltip.hidden) return;
      const gap = 10;
      let left = e.clientX + gap;
      let top = e.clientY + gap;
      tableTooltip.style.left = `${left}px`;
      tableTooltip.style.top = `${top}px`;
      const rect = tableTooltip.getBoundingClientRect();
      if (rect.right > window.innerWidth) left = e.clientX - rect.width - gap;
      if (rect.bottom > window.innerHeight) top = e.clientY - rect.height - gap;
      if (left < gap) left = gap;
      if (top < gap) top = gap;
      tableTooltip.style.left = `${left}px`;
      tableTooltip.style.top = `${top}px`;
    });
  }

  function updateSummary() {
    if (summaryEl) summaryEl.textContent = `${headers.length} columns, ${rows.length.toLocaleString()} rows`;
  }

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

    const table = overlay.querySelector('.working-dataset-edit-table');
    if (table && columnWidths.length !== headers.length) {
      while (columnWidths.length < headers.length) columnWidths.push(140);
      if (columnWidths.length > headers.length) columnWidths = columnWidths.slice(0, headers.length);
    }
    let colgroup = table?.querySelector('colgroup');
    if (table) {
      if (!colgroup) {
        colgroup = document.createElement('colgroup');
        table.insertBefore(colgroup, table.firstChild);
      }
      colgroup.innerHTML = '';
      const colNum = document.createElement('col');
      colNum.style.width = '40px';
      colgroup.appendChild(colNum);
      headers.forEach((_, colIdx) => {
        const col = document.createElement('col');
        col.dataset.colIndex = String(colIdx);
        col.style.width = `${Math.max(60, (columnWidths[colIdx] ?? 140))}px`;
        colgroup.appendChild(col);
      });
    }

    // Header row: # + editable headers (click header to select column for delete) + column resize handles
    theadRow.innerHTML = '';
    const thNum = document.createElement('th');
    thNum.className = 'dataset-detail-preview-row-num';
    thNum.textContent = '#';
    theadRow.appendChild(thNum);
    headers.forEach((h, colIdx) => {
      const th = document.createElement('th');
      th.dataset.colIndex = String(colIdx);
      th.className = selectedColIndex === colIdx ? 'wd-header-th wd-col-selected' : 'wd-header-th';
      th.addEventListener('click', (e) => {
        if (e.target.classList.contains('wd-col-resize-handle')) return;
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
      const resizeHandle = document.createElement('div');
      resizeHandle.className = 'wd-col-resize-handle';
      resizeHandle.setAttribute('aria-label', 'Resize column');
      resizeHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = columnWidths[colIdx] ?? 140;
        const col = table?.querySelector(`colgroup col[data-col-index="${colIdx}"]`);
        document.body.classList.add('wd-col-resizing');
        const onMove = (moveE) => {
          const dx = moveE.clientX - startX;
          const newW = Math.max(60, startW + dx);
          columnWidths[colIdx] = newW;
          if (col) col.style.width = `${newW}px`;
        };
        const onUp = () => {
          document.body.classList.remove('wd-col-resizing');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      th.appendChild(resizeHandle);
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
      const addRowResize = (cell) => {
        const rowHandle = document.createElement('div');
        rowHandle.className = 'wd-row-resize-handle';
        rowHandle.setAttribute('aria-label', 'Resize row');
        rowHandle.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const startY = e.clientY;
          const firstTa = tr.querySelector('.wd-cell-textarea');
          const startH = firstTa ? firstTa.offsetHeight : 60;
          document.body.classList.add('wd-row-resizing');
          const onMove = (moveE) => {
            const dy = moveE.clientY - startY;
            const newH = Math.max(MIN_ROW_HEIGHT_PX, startH + dy);
            rowHeights[originalRowIdx] = newH;
            tr.querySelectorAll('.wd-cell-textarea').forEach((el) => {
              el.style.height = `${newH}px`;
              el.style.minHeight = `${newH}px`;
            });
          };
          const onUp = () => {
            document.body.classList.remove('wd-row-resizing');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
        cell.appendChild(rowHandle);
      };
      addRowResize(tdNum);
      tr.appendChild(tdNum);
      const rowData = row.length >= headers.length ? row : [...row, ...Array(headers.length - row.length).fill('')];
      const initialRowH = rowHeights[originalRowIdx];
      const rowH = initialRowH != null ? Math.max(MIN_ROW_HEIGHT_PX, initialRowH) : MIN_ROW_HEIGHT_PX;
      headers.forEach((_, colIdx) => {
        const td = document.createElement('td');
        if (selectedColIndex === colIdx) td.classList.add('wd-col-selected');
        const textarea = document.createElement('textarea');
        textarea.rows = 2;
        textarea.className = 'wd-cell-inp wd-cell-textarea';
        textarea.value = rowData[colIdx] ?? '';
        textarea.dataset.rowIndex = String(originalRowIdx);
        textarea.dataset.colIndex = String(colIdx);
        textarea.style.height = `${rowH}px`;
        textarea.style.minHeight = `${rowH}px`;
        textarea.addEventListener('change', () => {
          const ri = parseInt(textarea.dataset.rowIndex, 10);
          const ci = parseInt(textarea.dataset.colIndex, 10);
          if (Number.isFinite(ri) && Number.isFinite(ci) && rows[ri]) {
            while (rows[ri].length <= ci) rows[ri].push('');
            rows[ri][ci] = textarea.value;
          }
        });
        td.appendChild(textarea);
        const colHandle = document.createElement('div');
        colHandle.className = 'wd-col-resize-handle';
        colHandle.setAttribute('aria-label', 'Resize column');
        colHandle.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const startX = e.clientX;
          const startW = columnWidths[colIdx] ?? 140;
          const col = table?.querySelector(`colgroup col[data-col-index="${colIdx}"]`);
          document.body.classList.add('wd-col-resizing');
          const onMove = (moveE) => {
            const dx = moveE.clientX - startX;
            const newW = Math.max(60, startW + dx);
            columnWidths[colIdx] = newW;
            if (col) col.style.width = `${newW}px`;
          };
          const onUp = () => {
            document.body.classList.remove('wd-col-resizing');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
        td.appendChild(colHandle);
        addRowResize(td);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
      const rowTextareas = tr.querySelectorAll('.wd-cell-textarea');
      rowTextareas.forEach((ta) => {
        const ro = new ResizeObserver(() => {
          requestAnimationFrame(() => {
            const h = Math.max(MIN_ROW_HEIGHT_PX, ta.offsetHeight);
            rowHeights[originalRowIdx] = h;
            rowTextareas.forEach((el) => {
              el.style.height = `${h}px`;
              el.style.minHeight = `${h}px`;
            });
          });
        });
        ro.observe(ta);
      });
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
    updateSummary();
    updateDeleteButtons();
  }

  addRowBtn.addEventListener('click', () => {
    rows.push(Array(headers.length).fill(''));
    rowHeights.push(undefined);
    render();
  });

  addColBtn.addEventListener('click', () => {
    headers.push(`Column ${headers.length + 1}`);
    columnWidths.push(140);
    rows.forEach((r) => r.push(''));
    render();
  });

  deleteRowBtn.addEventListener('click', () => {
    if (rows.length === 0 || selectedRowIndex < 0 || selectedRowIndex >= rows.length) return;
    rows.splice(selectedRowIndex, 1);
    rowHeights.splice(selectedRowIndex, 1);
    selectedRowIndex = -1;
    const totalPages = Math.max(1, Math.ceil(rows.length / rowsPerPage));
    if (currentPage > totalPages) currentPage = totalPages;
    render();
  });

  deleteColBtn.addEventListener('click', () => {
    if (headers.length <= 1 || selectedColIndex < 0 || selectedColIndex >= headers.length) return;
    headers.splice(selectedColIndex, 1);
    columnWidths.splice(selectedColIndex, 1);
    rows.forEach((r) => r.splice(selectedColIndex, 1));
    selectedColIndex = -1;
    render();
  });

  if (sampleBtn) {
    sampleBtn.disabled = !node?.dataset?.nodeId;
    sampleBtn.addEventListener('click', () => {
      if (!node?.dataset?.nodeId) return;
      document.dispatchEvent(new CustomEvent('workflow:add-sampler-node', {
        detail: { sourceNodeId: node.dataset.nodeId },
      }));
      close();
    });
  }

  function updateDeleteButtons() {
    const hasRowSelected = selectedRowIndex >= 0 && selectedRowIndex < rows.length;
    const hasColSelected = selectedColIndex >= 0 && selectedColIndex < headers.length;
    deleteRowBtn.disabled = rows.length === 0 || !hasRowSelected;
    deleteColBtn.disabled = headers.length <= 1 || !hasColSelected;
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);

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
