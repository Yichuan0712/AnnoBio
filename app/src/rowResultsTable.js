/**
 * Shared "Results" panel used by detail modals that run user code over a dataset and show a
 * searchable, paginated table of the outcome (Process, Sample by code): a placeholder state for
 * "nothing yet" / errors, and a results-card state with a search box + rows-per-page + pagination
 * toolbar. The footer's action button(s) are caller-supplied via `buildActions`, since what they do
 * (export a dataset, create a sample, ...) differs per caller.
 */

import { displayCell } from './datasetContent.js';
import { showExecutionError } from './executionErrorPanel.js';

export const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100];
const MAX_PREVIEW_CELL_CHARS = 200;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function truncate(str) {
  const s = String(str ?? '');
  return s.length > MAX_PREVIEW_CELL_CHARS ? s.slice(0, MAX_PREVIEW_CELL_CHARS) + '…' : s;
}

export function filterTableRows(headers, rows, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => row.some((v) => v != null && displayCell(v).toLowerCase().includes(q)));
}

function buildResultsTable(headers, rows) {
  const table = document.createElement('table');
  table.className = 'run-detail-results-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headers.forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    th.title = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    headers.forEach((_, i) => {
      const td = document.createElement('td');
      td.textContent = truncate(displayCell(row[i]));
      td.title = displayCell(row[i]);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

/**
 * @param {{ container: HTMLElement, idPrefix: string, buildActions?: (actionsEl: HTMLElement) => void }} opts
 */
export function createRowResultsPanel({ container, idPrefix, buildActions }) {
  const state = { headers: [], rows: [], searchQuery: '', rowsPerPage: 25, currentPage: 1 };

  function showPlaceholder(text) {
    container.innerHTML = `<div class="run-detail-results-card"><div class="run-detail-results"><p class="run-detail-placeholder">${escapeHtml(text)}</p></div></div>`;
  }

  function showError(error, title = 'Execution failed') {
    showExecutionError(container, { title, error, wrapInResultsCard: true });
  }

  function showResultsCard(headers, rows, statusText) {
    state.headers = headers;
    state.rows = rows;
    state.currentPage = 1;
    container.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'run-detail-results-card';
    const wrap = document.createElement('div');
    wrap.className = 'run-detail-results';

    const statusNote = document.createElement('span');
    statusNote.className = 'run-detail-results-note run-detail-results-note--inline';
    statusNote.textContent = statusText || '';
    const topRow = document.createElement('div');
    topRow.className = 'run-detail-results-top-row';
    topRow.appendChild(statusNote);
    const searchWrap = document.createElement('div');
    searchWrap.className = 'dataset-detail-preview-search-wrap run-detail-results-search-wrap';
    searchWrap.innerHTML = `<label class="dataset-detail-search-label" for="${idPrefix}-results-search">Search</label><input type="text" id="${idPrefix}-results-search" class="dataset-detail-input dataset-detail-preview-search-inp" placeholder="Filter rows by cell content..." aria-label="Search in table" />`;
    topRow.appendChild(searchWrap);

    const tableWrap = document.createElement('div');
    tableWrap.className = 'run-detail-results-table-wrap';
    wrap.appendChild(topRow);
    wrap.appendChild(tableWrap);

    const footer = document.createElement('div');
    footer.className = 'run-detail-results-footer';
    const toolbar = document.createElement('div');
    toolbar.className = 'dataset-detail-preview-toolbar run-detail-results-toolbar';
    toolbar.innerHTML = `
      <label class="dataset-detail-rows-label" for="${idPrefix}-rows-per-page">Rows per page</label>
      <select id="${idPrefix}-rows-per-page" class="dataset-detail-rows-select" aria-label="Rows per page">${ROWS_PER_PAGE_OPTIONS.map((n) => `<option value="${n}" ${n === state.rowsPerPage ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <span class="dataset-detail-pagination-info" aria-live="polite"></span>
      <label class="dataset-detail-page-label" for="${idPrefix}-page-inp">Page</label>
      <input type="number" id="${idPrefix}-page-inp" class="dataset-detail-page-inp" min="1" value="1" aria-label="Page" />
      <span class="dataset-detail-page-of">/ 1</span>
      <div class="dataset-detail-pagination-btns">
        <button type="button" class="btn btn-secondary" data-role="prev-page" aria-label="Previous">Previous</button>
        <button type="button" class="btn btn-secondary" data-role="next-page" aria-label="Next">Next</button>
      </div>
    `;
    const rowsPerPageSelect = toolbar.querySelector(`#${idPrefix}-rows-per-page`);
    const paginationInfo = toolbar.querySelector('.dataset-detail-pagination-info');
    const pageInp = toolbar.querySelector(`#${idPrefix}-page-inp`);
    const pageOfSpan = toolbar.querySelector('.dataset-detail-page-of');
    const prevBtn = toolbar.querySelector('[data-role="prev-page"]');
    const nextBtn = toolbar.querySelector('[data-role="next-page"]');

    function refreshTable() {
      const filtered = filterTableRows(state.headers, state.rows, state.searchQuery);
      const totalPages = Math.max(1, Math.ceil(filtered.length / state.rowsPerPage));
      state.currentPage = Math.min(Math.max(1, state.currentPage), totalPages);
      const start = (state.currentPage - 1) * state.rowsPerPage;
      const pageRows = filtered.slice(start, start + state.rowsPerPage);
      const savedScrollLeft = tableWrap.scrollLeft;
      tableWrap.innerHTML = '';
      tableWrap.appendChild(buildResultsTable(state.headers, pageRows));
      if (savedScrollLeft > 0) tableWrap.scrollLeft = savedScrollLeft;
      const totalRows = state.rows.length;
      paginationInfo.textContent = filtered.length === 0 ? (totalRows === 0 ? '0 rows' : `0 rows (filtered from ${totalRows})`) : `Showing ${start + 1}–${Math.min(start + state.rowsPerPage, filtered.length)} of ${totalRows} rows`;
      pageInp.value = String(state.currentPage);
      pageInp.max = String(totalPages);
      pageOfSpan.textContent = `/ ${totalPages}`;
      prevBtn.disabled = state.currentPage <= 1;
      nextBtn.disabled = state.currentPage >= totalPages;
    }

    searchWrap.querySelector(`#${idPrefix}-results-search`).addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      state.currentPage = 1;
      refreshTable();
    });
    rowsPerPageSelect.addEventListener('change', () => { state.rowsPerPage = Number(rowsPerPageSelect.value) || 25; state.currentPage = 1; refreshTable(); });
    pageInp.addEventListener('change', () => { state.currentPage = Math.max(1, parseInt(pageInp.value, 10) || 1); refreshTable(); });
    prevBtn.addEventListener('click', () => { state.currentPage = Math.max(1, state.currentPage - 1); refreshTable(); });
    nextBtn.addEventListener('click', () => {
      const n = filterTableRows(state.headers, state.rows, state.searchQuery).length;
      state.currentPage = Math.min(Math.max(1, Math.ceil(n / state.rowsPerPage)), state.currentPage + 1);
      refreshTable();
    });

    const actions = document.createElement('div');
    actions.className = 'run-detail-results-footer-actions';
    if (typeof buildActions === 'function') buildActions(actions);
    footer.append(toolbar, actions);
    wrap.appendChild(footer);
    card.appendChild(wrap);
    container.appendChild(card);
    refreshTable();
  }

  return { showPlaceholder, showError, showResultsCard };
}
