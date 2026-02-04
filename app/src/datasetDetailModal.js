/**
 * Source dataset detail modal: edit name/description (left), full data preview with pagination (right).
 * @param {{ node: HTMLElement, getDatasetContent: () => { headers: string[], rows: string[][] }, isDatasetNameAlreadyUsed?: (name: string, excludeNodeId?: string | null) => boolean }} options
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

export function openDatasetDetailModal({ node, getDatasetContent, isDatasetNameAlreadyUsed }) {
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
        <h2 id="dataset-detail-title" class="modal-title">Source dataset details</h2>
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
            <h3 class="dataset-detail-sampler-title">Working dataset sampler</h3>
            <div class="dataset-detail-sampler-body"></div>
            <div class="dataset-detail-sampler-footer">
              <button type="button" class="btn btn-secondary dataset-detail-btn-create-sampler">Create sampler</button>
            </div>
          </div>
        </div>
        <div class="dataset-detail-col dataset-detail-col--right">
          <div class="dataset-preview-wrap dataset-detail-preview-area">
            <h3 class="dataset-preview-title">Preview</h3>
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

  let currentPage = 1;
  let rowsPerPage = 25;
  let totalPages = 1;

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
    totalPages = Math.max(1, Math.ceil(totalRows / rowsPerPage));
    currentPage = Math.min(currentPage, totalPages);
    const start = (currentPage - 1) * rowsPerPage;
    const end = Math.min(start + rowsPerPage, totalRows);
    const pageRows = rows.slice(start, end);

    paginationInfo.textContent = `Showing ${start + 1}–${end} of ${totalRows.toLocaleString()} rows`;

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
      const tr = document.createElement('tr');
      const tdRowNum = document.createElement('td');
      tdRowNum.className = 'dataset-detail-preview-row-num';
      tdRowNum.textContent = String(start + rowIdx + 1);
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

  overlay.querySelector('.modal-close').addEventListener('click', close);

  function close() {
    overlay.remove();
    document.body.style.overflow = '';
  }

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  renderPreview();
}
