/**
 * Dataset detail modal: dataset preview only (table view, search, pagination, add/delete row/col).
 * Name and description are edited via node right-click "Edit name & description".
 * Layout follows prompt detail and add dataset style.
 * @param {{ node: HTMLElement, getContent: () => { headers: string[], rows: string[][] }, saveContent: (content: { headers: string[], rows: string[][] }) => void }} options
 */

import * as XLSX from 'xlsx';
import { displayCell, imageCell, isImageCell, pdfCell, isPdfCell, cloneCell, normalizeDatasetContent } from './datasetContent.js';
import { getCurrentProjectId } from './currentProject.js';
import * as webImageApi from './webImageApi.js';
import { iconImageAdd, iconFileText } from './icons.js';

const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100];
/** 行高下限：至少一行字高度（约 12px 字号 + 行高 + 内边距） */
const MIN_ROW_HEIGHT_PX = 28;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Escape a value for CSV: quote if contains comma, newline, or double-quote; double any quotes inside. */
function escapeCsvField(value) {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Escape a value for TSV: quote if contains tab, newline, or double-quote; double any quotes inside. */
function escapeTsvField(value) {
  const s = String(value ?? '');
  if (/[\t\r\n"]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Sanitize node name for use as default filename (remove/replace invalid path chars). */
function sanitizeFilename(name) {
  const s = String(name ?? '').replace(/[\r\n/:*?"<>|\\]/g, '_').trim();
  return s || 'dataset';
}

function basename(filePath) {
  const parts = String(filePath ?? '').split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

function filenameStem(fileName) {
  const name = String(fileName ?? '').trim();
  return name.replace(/\.[^.]+$/, '');
}

function normalizeMatchKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function candidateMatchKeys(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  const keys = new Set();
  keys.add(normalizeMatchKey(raw));
  const leaf = basename(raw);
  if (leaf && leaf !== raw) keys.add(normalizeMatchKey(leaf));
  if (/\.(png|jpe?g|webp)$/i.test(leaf)) keys.add(normalizeMatchKey(filenameStem(leaf)));
  return Array.from(keys).filter(Boolean);
}

export function openDatasetDetailModal({ node, getContent, saveContent }) {
  const nodeId = (node?.dataset?.nodeId ?? '').trim();
  const existing = nodeId
    ? document.querySelector(`.modal-overlay[data-working-dataset-node-id="${CSS.escape(nodeId)}"]`)
    : null;
  if (existing) {
    document.body.appendChild(existing);
    return;
  }

  const name = (node?.dataset?.datasetName ?? node?.dataset?.subsetName ?? '').trim() || 'Dataset';
  const hasElectron = !!window.electronAPI;

  let headers = [];
  let rows = [];
  let columnTypes = [];
  let rowIds = [];
  try {
    const c = normalizeDatasetContent(getContent());
    headers = c.headers;
    rows = c.rows;
    columnTypes = c.columnTypes;
    rowIds = c.rowIds;
  } catch (_) {}

  if (headers.length === 0) {
    headers = ['Column 1'];
    columnTypes = ['text'];
    rows = rows.length ? rows : [];
  }

  let currentPage = 1;
  let rowsPerPage = 25;
  let searchQuery = '';
  let selectedRowIndex = -1;
  let selectedColIndex = -1;
  // Image columns need more room than text to comfortably show the image thumbnail strip (see
  // .wd-image-cell in modals.css) — matches the 180px new
  // image columns already get when added via the in-modal "+" menu (addImageColumn below), just
  // also applied to image columns a dataset already has when this modal opens (e.g. from the PDF
  // import's Image N columns), which this line previously defaulted to the same 140px as text.
  let columnWidths = headers.map((_, i) => (columnTypes[i] === 'image' ? 180 : columnTypes[i] === 'pdf' ? 160 : 140));
  let rowHeights = rows.map(() => undefined);
  const initialHeaders = headers.map((h) => h);
  const initialRows = rows.map((r) => r.map((cell) => cloneCell(cell)));

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'working-dataset-detail-title');
  if (nodeId) overlay.dataset.workingDatasetNodeId = nodeId;
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
                <button type="button" class="btn btn-secondary working-dataset-export-local">Save to local</button>
                <div class="working-dataset-detail-footer__actions">
                  <button type="button" class="btn btn-secondary working-dataset-link-images">Add images</button>
                  <button type="button" class="btn btn-secondary working-dataset-link-pdf">Add pdf</button>
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
  const linkImagesBtn = overlay.querySelector('.working-dataset-link-images');
  const linkPdfBtn = overlay.querySelector('.working-dataset-link-pdf');
  const addRowBtn = overlay.querySelector('.working-dataset-add-row');
  const addColBtn = overlay.querySelector('.working-dataset-add-col');
  const deleteRowBtn = overlay.querySelector('.working-dataset-delete-row');
  const deleteColBtn = overlay.querySelector('.working-dataset-delete-col');
  const sampleBtn = overlay.querySelector('.working-dataset-sample');
  const exportLocalBtn = overlay.querySelector('.working-dataset-export-local');
  const searchInp = overlay.querySelector('#wd-preview-search');
  const summaryEl = overlay.querySelector('.wd-summary');
  const tableWrap = overlay.querySelector('.working-dataset-table-wrap');
  let activeAddColumnMenu = null;

  function getTableLayoutMetrics() {
    const rowNumWidth = 40;
    const widths = headers.map((_, colIdx) => Math.max(60, (columnWidths[colIdx] ?? 140)));
    if (!tableWrap || headers.length === 0) {
      return {
        rowNumWidth,
        widths,
        tableWidth: rowNumWidth + widths.reduce((sum, width) => sum + width, 0),
      };
    }
    const wrapStyles = window.getComputedStyle(tableWrap);
    const innerWidth = Math.max(
      0,
      tableWrap.clientWidth
        - (parseFloat(wrapStyles.paddingLeft) || 0)
        - (parseFloat(wrapStyles.paddingRight) || 0),
    );
    const naturalWidth = rowNumWidth + widths.reduce((sum, width) => sum + width, 0);
    if (naturalWidth >= innerWidth || innerWidth <= 0) {
      return { rowNumWidth, widths, tableWidth: naturalWidth };
    }
    const extra = innerWidth - naturalWidth;
    const evenExtra = Math.floor(extra / headers.length);
    const remainder = extra - (evenExtra * headers.length);
    const stretchedWidths = widths.map((width, idx) => width + evenExtra + (idx < remainder ? 1 : 0));
    return { rowNumWidth, widths: stretchedWidths, tableWidth: innerWidth };
  }

  function applyTableLayout() {
    const table = overlay.querySelector('.working-dataset-edit-table');
    if (!table) return;
    let colgroup = table.querySelector('colgroup');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      table.insertBefore(colgroup, table.firstChild);
    }
    const { rowNumWidth, widths, tableWidth } = getTableLayoutMetrics();
    colgroup.innerHTML = '';
    const colNum = document.createElement('col');
    colNum.style.width = `${rowNumWidth}px`;
    colgroup.appendChild(colNum);
    headers.forEach((_, colIdx) => {
      const col = document.createElement('col');
      col.dataset.colIndex = String(colIdx);
      col.style.width = `${widths[colIdx]}px`;
      colgroup.appendChild(col);
    });
    table.style.width = `${Math.max(tableWidth, rowNumWidth)}px`;
  }

  /** Recognizes the specific GFM table shape backend/pdf_client.py's _rows_to_markdown emits
   * (header row, a |---|---| separator, body rows) — not a general markdown parser. Returns null
   * for anything else so plain text cells keep showing just the raw-text tooltip. */
  function parseMarkdownTable(text) {
    const lines = String(text || '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;
    const isRow = (l) => l.startsWith('|') && l.endsWith('|') && l.length > 1;
    if (!isRow(lines[0]) || !/^\|(\s*:?-+:?\s*\|)+$/.test(lines[1])) return null;
    const splitRow = (l) => l.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    return { header: splitRow(lines[0]), body: lines.slice(2).filter(isRow).map(splitRow) };
  }

  function renderMarkdownTablePreview({ header, body }) {
    const table = document.createElement('table');
    table.className = 'wd-tooltip-md-table';
    const thead = document.createElement('thead');
    const headerTr = document.createElement('tr');
    header.forEach((h) => {
      const th = document.createElement('th');
      th.textContent = h;
      headerTr.appendChild(th);
    });
    thead.appendChild(headerTr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    body.forEach((row) => {
      const tr = document.createElement('tr');
      row.forEach((c) => {
        const td = document.createElement('td');
        td.textContent = c;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

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
      // Image cells have neither — they show thumbnails directly, and clicking one already opens
      // a full viewer, so there's nothing worth putting in a text tooltip here (used to show up
      // as an empty box next to the cursor).
      if (!textarea && !headerInp) {
        tableTooltip.hidden = true;
        return;
      }
      const text = textarea ? textarea.value : headerInp.value;
      tableTooltip.innerHTML = '';
      const raw = document.createElement('pre');
      raw.className = 'wd-tooltip-raw';
      raw.textContent = text ?? '';
      tableTooltip.appendChild(raw);
      const parsedTable = parseMarkdownTable(text);
      if (parsedTable) {
        const label = document.createElement('p');
        label.className = 'wd-tooltip-md-table-label';
        label.textContent = 'Preview';
        tableTooltip.appendChild(label);
        tableTooltip.appendChild(renderMarkdownTablePreview(parsedTable));
      }
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
    return rows.map((row, i) => (row.some((cell) => displayCell(cell).toLowerCase().includes(q)) ? i : -1)).filter((i) => i >= 0);
  }

  function getTotalPages() {
    const filtered = getFilteredIndices();
    return Math.max(1, Math.ceil(filtered.length / rowsPerPage));
  }

  function buildFileInfos(filePaths) {
    return (Array.isArray(filePaths) ? filePaths : []).map((entry) => {
      // Desktop: entry is an absolute path string. Web: entry is a File object (no real path
      // available in a browser), matched and later uploaded by its .name instead.
      const isFileObject = entry && typeof entry === 'object' && typeof entry.name === 'string';
      const name = isFileObject ? entry.name : basename(entry);
      const stem = filenameStem(name);
      const key = normalizeMatchKey(stem);
      return { path: entry, name, stem, key };
    });
  }

  function buildLinkImagesPlan(targetColIndex, sourceColIndex, filePaths = [], cellTest = isImageCell) {
    const sourceRows = rows.map((row, rowIndex) => {
      const rawValue = displayCell(row?.[sourceColIndex] ?? '').trim();
      const key = normalizeMatchKey(basename(rawValue));
      return { rowIndex, rawValue, key };
    });
    const sourceKeyToRows = new Map();
    sourceRows.forEach((row) => {
      if (!row.key) return;
      const bucket = sourceKeyToRows.get(row.key) || [];
      bucket.push(row.rowIndex);
      sourceKeyToRows.set(row.key, bucket);
    });
    const duplicateSourceKeys = [];
    sourceKeyToRows.forEach((rowIndices, key) => {
      if (rowIndices.length > 1) {
        duplicateSourceKeys.push({
          key,
          rowIndices,
          sample: sourceRows[rowIndices[0]]?.rawValue || key,
        });
      }
    });

    const uploadedNameCounts = new Map();
    const rowPlans = new Map();
    const unmatchedFiles = [];
    const ambiguousFiles = [];
    const fileInfos = buildFileInfos(filePaths).map((info) => ({ ...info, matchKey: normalizeMatchKey(info.name) }));
    fileInfos.forEach((info) => {
      if (info.matchKey) uploadedNameCounts.set(info.matchKey, (uploadedNameCounts.get(info.matchKey) || 0) + 1);
      const targetRows = sourceKeyToRows.get(info.matchKey) || [];
      if (targetRows.length === 0) {
        unmatchedFiles.push(info);
        return;
      }
      if (targetRows.length > 1) {
        ambiguousFiles.push({ ...info, rowIndices: targetRows.slice() });
        return;
      }
      const rowIndex = targetRows[0];
      const existing = rowPlans.get(rowIndex) || { rowIndex, files: [] };
      existing.files.push(info);
      rowPlans.set(rowIndex, existing);
    });

    const duplicateUploadedNames = Array.from(uploadedNameCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([name, count]) => ({ name, count }));
    const missingRows = sourceRows.filter((row) => row.key && !fileInfos.some((file) => file.matchKey === row.key));
    const matchedEntries = Array.from(rowPlans.values()).sort((a, b) => a.rowIndex - b.rowIndex);
    const matchedFileEntries = matchedEntries.flatMap((entry) => entry.files.map((file) => ({ ...file, rowIndex: entry.rowIndex })));
    const overwriteRows = matchedEntries.filter(({ rowIndex }) => {
      const current = Number.isInteger(targetColIndex) ? rows[rowIndex]?.[targetColIndex] : null;
      return cellTest(current) && current.assetIds.length > 0;
    });
    const previewRows = matchedEntries.slice(0, 12).map(({ rowIndex, files }) => ({
      rowIndex,
      sourceValue: sourceRows[rowIndex]?.rawValue || '',
      fileNames: files.map((file) => file.name),
      existingCount: Number.isInteger(targetColIndex) && cellTest(rows[rowIndex]?.[targetColIndex])
        ? rows[rowIndex][targetColIndex].assetIds.length
        : 0,
    }));
    return {
      matchedEntries,
      matchedFileEntries,
      unmatchedFiles,
      ambiguousFiles,
      duplicateSourceKeys,
      duplicateUploadedNames,
      missingRows,
      overwriteRows,
      previewRows,
      fileCount: fileInfos.length,
    };
  }

  function buildImageImportPlanByKey(targetColIndex, matchColIndex) {
    const duplicateDatasetKeys = [];
    const datasetKeyToRows = new Map();
    const datasetRows = rows.map((row, rowIndex) => {
      const keyRaw = displayCell(row?.[matchColIndex] ?? '');
      const keys = candidateMatchKeys(keyRaw);
      keys.forEach((key) => {
        const list = datasetKeyToRows.get(key) || [];
        list.push(rowIndex);
        datasetKeyToRows.set(key, list);
      });
      return { rowIndex, keyRaw, keys };
    });
    datasetKeyToRows.forEach((rowIndices, key) => {
      if (rowIndices.length > 1) {
        duplicateDatasetKeys.push({
          key,
          rowIndices,
          sample: displayCell(rows[rowIndices[0]]?.[matchColIndex] ?? ''),
        });
      }
    });

    const rowPlans = new Map();
    const unmatchedFiles = [];
    const ambiguousFiles = [];
    const filesByKey = new Map();
    const fileInfos = buildFileInfos(selectedImagePaths);

    fileInfos.forEach((info) => {
      if (!info.key) {
        unmatchedFiles.push(info);
        return;
      }
      const bucket = filesByKey.get(info.key) || [];
      bucket.push(info);
      filesByKey.set(info.key, bucket);
      const targetRows = datasetKeyToRows.get(info.key) || [];
      if (targetRows.length === 0) {
        unmatchedFiles.push(info);
        return;
      }
      if (targetRows.length > 1) {
        ambiguousFiles.push({ ...info, rowIndices: targetRows.slice() });
        return;
      }
      const rowIndex = targetRows[0];
      const existing = rowPlans.get(rowIndex) || { rowIndex, files: [] };
      existing.files.push(info);
      rowPlans.set(rowIndex, existing);
    });

    const missingRows = datasetRows.filter((row) => row.keys.length > 0 && !row.keys.some((key) => filesByKey.has(key)));
    const matchedEntries = Array.from(rowPlans.values()).sort((a, b) => a.rowIndex - b.rowIndex);
    const matchedFileEntries = matchedEntries.flatMap((entry) => entry.files.map((file) => ({ ...file, rowIndex: entry.rowIndex })));
    const overwriteRows = matchedEntries.filter(({ rowIndex }) => {
      const current = rows[rowIndex]?.[targetColIndex];
      return isImageCell(current) && current.assetIds.length > 0;
    });

    const previewRows = matchedEntries.slice(0, 12).map(({ rowIndex, files }) => ({
      rowIndex,
      matchValue: displayCell(rows[rowIndex]?.[matchColIndex] ?? ''),
      fileNames: files.map((file) => file.name),
      existingCount: isImageCell(rows[rowIndex]?.[targetColIndex]) ? rows[rowIndex][targetColIndex].assetIds.length : 0,
    }));

    return {
      strategy: 'key',
      matchedEntries,
      matchedFileEntries,
      unmatchedFiles,
      ambiguousFiles,
      duplicateDatasetKeys,
      missingRows,
      overwriteRows,
      previewRows,
      fileCount: fileInfos.length,
    };
  }

  function buildImageImportPlanByRowOrder(targetColIndex) {
    const fileInfos = buildFileInfos(selectedImagePaths);
    const matchedEntries = [];
    const unmatchedFiles = [];
    for (let i = 0; i < fileInfos.length; i++) {
      if (i >= rows.length) {
        unmatchedFiles.push(fileInfos[i]);
        continue;
      }
      matchedEntries.push({ rowIndex: i, files: [fileInfos[i]] });
    }
    const matchedFileEntries = matchedEntries.flatMap((entry) => entry.files.map((file) => ({ ...file, rowIndex: entry.rowIndex })));
    const missingRows = rows.slice(fileInfos.length).map((row, rowIndex) => ({
      rowIndex: rowIndex + fileInfos.length,
      keyRaw: `Row ${rowIndex + fileInfos.length + 1}`,
      keys: [],
    }));
    const overwriteRows = matchedEntries.filter(({ rowIndex }) => {
      const current = rows[rowIndex]?.[targetColIndex];
      return isImageCell(current) && current.assetIds.length > 0;
    });
    const previewRows = matchedEntries.slice(0, 12).map(({ rowIndex, files }) => ({
      rowIndex,
      matchValue: `Row ${rowIndex + 1}`,
      fileNames: files.map((file) => file.name),
      existingCount: isImageCell(rows[rowIndex]?.[targetColIndex]) ? rows[rowIndex][targetColIndex].assetIds.length : 0,
    }));
    return {
      strategy: 'row-order',
      matchedEntries,
      matchedFileEntries,
      unmatchedFiles,
      ambiguousFiles: [],
      duplicateDatasetKeys: [],
      missingRows,
      overwriteRows,
      previewRows,
      fileCount: fileInfos.length,
    };
  }

  function buildImageImportPlanFromResolvedRows(targetColIndex, pathColIndex, resolvedRows = []) {
    const matchedEntries = [];
    const missingRows = [];
    const matchedFileEntries = [];
    const previewRows = [];

    rows.forEach((row, rowIndex) => {
      const sourceValue = displayCell(row?.[pathColIndex] ?? '').trim();
      if (!sourceValue) return;
      const resolved = resolvedRows[rowIndex];
      if (!resolved?.ok) {
        missingRows.push({ rowIndex, keyRaw: sourceValue, error: resolved?.error || 'Could not parse image paths.' });
        return;
      }
      const existingFiles = (resolved.files || []).filter((file) => file?.exists);
      const missingFiles = (resolved.files || []).filter((file) => !file?.exists);
      if (existingFiles.length > 0) {
        matchedEntries.push({ rowIndex, files: existingFiles });
        existingFiles.forEach((file) => matchedFileEntries.push({ ...file, rowIndex }));
        previewRows.push({
          rowIndex,
          matchValue: sourceValue,
          fileNames: existingFiles.map((file) => file.name),
          existingCount: isImageCell(rows[rowIndex]?.[targetColIndex]) ? rows[rowIndex][targetColIndex].assetIds.length : 0,
          resultLabel: missingFiles.length > 0 ? 'partial' : 'set',
        });
      }
      if (missingFiles.length > 0 || existingFiles.length === 0) {
        missingRows.push({
          rowIndex,
          keyRaw: sourceValue,
          error: missingFiles.length > 0
            ? `Missing: ${missingFiles.map((file) => file.source || file.name).join(', ')}`
            : 'No valid image files were found.',
        });
      }
    });

    const overwriteRows = matchedEntries.filter(({ rowIndex }) => {
      const current = rows[rowIndex]?.[targetColIndex];
      return isImageCell(current) && current.assetIds.length > 0;
    });

    return {
      strategy: 'path-column',
      matchedEntries,
      matchedFileEntries,
      unmatchedFiles: [],
      ambiguousFiles: [],
      duplicateDatasetKeys: [],
      missingRows,
      overwriteRows,
      previewRows: previewRows.slice(0, 12),
      fileCount: matchedFileEntries.length,
    };
  }

  function buildImageImportPlan(targetColIndex, matchColIndex, strategy = 'key') {
    return strategy === 'row-order'
      ? buildImageImportPlanByRowOrder(targetColIndex)
      : buildImageImportPlanByKey(targetColIndex, matchColIndex);
  }

  let selectedImagePaths = [];

  async function openImageImportModal(targetColIndex) {
    if (!Number.isInteger(targetColIndex) || columnTypes[targetColIndex] !== 'image') {
      alert('Please open batch import from an image column.');
      return;
    }
    const textColumns = headers
      .map((header, index) => ({ index, header: String(header ?? '').trim() || `Column ${index + 1}` }))
      .filter(({ index }) => columnTypes[index] !== 'image');
    if (textColumns.length === 0) {
      alert('Add a filename text column first. Each row should contain a filename like xxx.png.');
      return;
    }
    if (!hasElectron && !getCurrentProjectId()) {
      alert('Open a project first.');
      return;
    }

    const imageColName = headers[targetColIndex] || `Image ${targetColIndex + 1}`;
    let sourceColIndex = textColumns[0].index;
    let selectedFiles = [];
    let plan = buildLinkImagesPlan(targetColIndex, sourceColIndex, selectedFiles);

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-panel modal-panel--dataset-image-import">
        <div class="modal-header">
          <h2 class="modal-title">Batch import images<span class="dataset-image-import-target-note">into "${escapeHtml(imageColName)}"</span></h2>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body dataset-image-import-body">
          <div class="dataset-image-import-form">
            <div class="agent-form-field">
              <label class="dataset-meta-label" for="wd-image-source-column">Filename Column</label>
              <select id="wd-image-source-column" class="dataset-meta-input">
                ${textColumns.map(({ index, header }) => `<option value="${index}" ${index === sourceColIndex ? 'selected' : ''}>${escapeHtml(header)}</option>`).join('')}
              </select>
              <p class="dataset-sheet-hint">Values in this column are matched to uploaded image filenames.</p>
            </div>
            <div class="agent-form-field">
              <label class="dataset-meta-label">Image Files</label>
              <div class="dataset-import-actions">
                <button type="button" class="btn btn-secondary dataset-image-import-pick-files">Choose images</button>
                <span class="dataset-filename dataset-image-import-source-status">No image files selected.</span>
              </div>
            </div>
          </div>
          <div class="prompt-form-error prompt-modal-error dataset-image-import-error" hidden></div>
          <div class="dataset-image-import-summary"></div>
          <div class="dataset-image-import-preview"></div>
        </div>
        <div class="prompt-actions">
          <button type="button" class="btn btn-secondary dataset-image-import-cancel">Cancel</button>
          <button type="button" class="btn btn-primary dataset-image-import-apply">Import</button>
        </div>
      </div>
    `;

    const closeModal = () => modal.remove();
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.dataset-image-import-cancel');
    const applyBtn = modal.querySelector('.dataset-image-import-apply');
    const pickFilesBtn = modal.querySelector('.dataset-image-import-pick-files');
    const sourceColumnSelect = modal.querySelector('#wd-image-source-column');
    const sourceStatusEl = modal.querySelector('.dataset-image-import-source-status');
    const errorEl = modal.querySelector('.dataset-image-import-error');
    const summaryEl = modal.querySelector('.dataset-image-import-summary');
    const previewEl = modal.querySelector('.dataset-image-import-preview');

    function setError(message = '') {
      errorEl.textContent = message;
      errorEl.hidden = !message;
    }

    function renderPlan() {
      sourceColIndex = parseInt(sourceColumnSelect.value, 10);
      plan = buildLinkImagesPlan(targetColIndex, sourceColIndex, selectedFiles);
      sourceStatusEl.textContent = selectedFiles.length
        ? `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} selected.`
        : 'No image files selected.';
      summaryEl.innerHTML = `
        ${selectedFiles.length === 0
          ? '<p class="dataset-image-import-note">Choose image files to preview matches.</p>'
          : `
            <p class="dataset-image-import-summary-line">
              ${plan.matchedFileEntries.length} matched file${plan.matchedFileEntries.length === 1 ? '' : 's'} across ${plan.matchedEntries.length} row${plan.matchedEntries.length === 1 ? '' : 's'}.
            </p>
            <p class="dataset-image-import-note">
              Missing rows: ${plan.missingRows.length} · Unused files: ${plan.unmatchedFiles.length} · Existing images: ${plan.overwriteRows.length}
            </p>
          `}
      `;
      const missingPreview = plan.missingRows.slice(0, 8).map((item) => item.rawValue).join(', ');
      const unmatchedPreview = plan.unmatchedFiles.slice(0, 8).map((item) => item.name).join(', ');
      const duplicatePreview = plan.duplicateSourceKeys.slice(0, 5).map((item) => item.sample).join(', ');
      previewEl.innerHTML = `
        ${missingPreview ? `<p class="dataset-image-import-note">Missing filenames: ${escapeHtml(missingPreview)}${plan.missingRows.length > 8 ? ' ...' : ''}</p>` : ''}
        ${unmatchedPreview ? `<p class="dataset-image-import-note">Unused uploaded files: ${escapeHtml(unmatchedPreview)}${plan.unmatchedFiles.length > 8 ? ' ...' : ''}</p>` : ''}
        ${duplicatePreview ? `<p class="dataset-image-import-note">Duplicate source filenames: ${escapeHtml(duplicatePreview)}${plan.duplicateSourceKeys.length > 5 ? ' ...' : ''}</p>` : ''}
      `;
      const warnings = [];
      if (plan.duplicateSourceKeys.length > 0) {
        warnings.push('The filename column contains duplicate values. Each filename should map to one row.');
      }
      if (selectedFiles.length > 0 && plan.matchedFileEntries.length === 0) {
        warnings.push('No uploaded filenames matched the selected filename column.');
      }
      setError(warnings.join(' '));
      applyBtn.disabled = selectedFiles.length === 0 || plan.matchedFileEntries.length === 0 || plan.duplicateSourceKeys.length > 0;
    }

    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal();
    });
    sourceColumnSelect.addEventListener('change', renderPlan);
    pickFilesBtn.addEventListener('click', async () => {
      selectedFiles = await (hasElectron ? window.electronAPI.pickImageFiles() : webImageApi.pickImageFiles());
      renderPlan();
    });
    applyBtn.addEventListener('click', async () => {
      renderPlan();
      if (applyBtn.disabled) return;
      try {
        applyBtn.disabled = true;
        const paths = plan.matchedFileEntries.map((entry) => entry.path);
        const imported = hasElectron
          ? await window.electronAPI.importImages(paths)
          : await webImageApi.importImages(getCurrentProjectId(), paths);
        const grouped = new Map();
        imported.forEach((asset, index) => {
          const rowIndex = plan.matchedFileEntries[index]?.rowIndex;
          if (!Number.isInteger(rowIndex)) return;
          const list = grouped.get(rowIndex) || [];
          list.push(asset);
          grouped.set(rowIndex, list);
        });
        grouped.forEach((assets, rowIndex) => {
          const nextAssets = [];
          const nextNames = [];
          assets.forEach((asset) => {
            nextAssets.push(asset.id);
            nextNames.push(asset.name);
          });
          rows[rowIndex][targetColIndex] = imageCell(nextAssets, nextNames);
        });
        persistContent();
        render();
        closeModal();
      } catch (error) {
        setError(error?.message || String(error));
        applyBtn.disabled = false;
      }
    });

    document.body.appendChild(modal);
    renderPlan();
  }

  async function openPdfImportModal(targetColIndex) {
    if (!Number.isInteger(targetColIndex) || columnTypes[targetColIndex] !== 'pdf') {
      alert('Please open batch import from a PDF column.');
      return;
    }
    const textColumns = headers
      .map((header, index) => ({ index, header: String(header ?? '').trim() || `Column ${index + 1}` }))
      .filter(({ index }) => columnTypes[index] !== 'pdf');
    if (textColumns.length === 0) {
      alert('Add a filename text column first. Each row should contain a filename like xxx.pdf.');
      return;
    }
    if (!hasElectron && !getCurrentProjectId()) {
      alert('Open a project first.');
      return;
    }

    const pdfColName = headers[targetColIndex] || `PDF ${targetColIndex + 1}`;
    let sourceColIndex = textColumns[0].index;
    let selectedFiles = [];
    let plan = buildLinkImagesPlan(targetColIndex, sourceColIndex, selectedFiles, isPdfCell);

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-panel modal-panel--dataset-image-import">
        <div class="modal-header">
          <h2 class="modal-title">Batch import PDFs<span class="dataset-image-import-target-note">into "${escapeHtml(pdfColName)}"</span></h2>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body dataset-image-import-body">
          <div class="dataset-image-import-form">
            <div class="agent-form-field">
              <label class="dataset-meta-label" for="wd-pdf-source-column">Filename Column</label>
              <select id="wd-pdf-source-column" class="dataset-meta-input">
                ${textColumns.map(({ index, header }) => `<option value="${index}" ${index === sourceColIndex ? 'selected' : ''}>${escapeHtml(header)}</option>`).join('')}
              </select>
              <p class="dataset-sheet-hint">Values in this column are matched to uploaded PDF filenames.</p>
            </div>
            <div class="agent-form-field">
              <label class="dataset-meta-label">PDF Files</label>
              <div class="dataset-import-actions">
                <button type="button" class="btn btn-secondary dataset-image-import-pick-files">Choose PDFs</button>
                <span class="dataset-filename dataset-image-import-source-status">No PDF files selected.</span>
              </div>
            </div>
          </div>
          <div class="prompt-form-error prompt-modal-error dataset-image-import-error" hidden></div>
          <div class="dataset-image-import-summary"></div>
          <div class="dataset-image-import-preview"></div>
        </div>
        <div class="prompt-actions">
          <button type="button" class="btn btn-secondary dataset-image-import-cancel">Cancel</button>
          <button type="button" class="btn btn-primary dataset-image-import-apply">Import</button>
        </div>
      </div>
    `;

    const closeModal = () => modal.remove();
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.dataset-image-import-cancel');
    const applyBtn = modal.querySelector('.dataset-image-import-apply');
    const pickFilesBtn = modal.querySelector('.dataset-image-import-pick-files');
    const sourceColumnSelect = modal.querySelector('#wd-pdf-source-column');
    const sourceStatusEl = modal.querySelector('.dataset-image-import-source-status');
    const errorEl = modal.querySelector('.dataset-image-import-error');
    const summaryEl = modal.querySelector('.dataset-image-import-summary');
    const previewEl = modal.querySelector('.dataset-image-import-preview');

    function setError(message = '') {
      errorEl.textContent = message;
      errorEl.hidden = !message;
    }

    function renderPlan() {
      sourceColIndex = parseInt(sourceColumnSelect.value, 10);
      plan = buildLinkImagesPlan(targetColIndex, sourceColIndex, selectedFiles, isPdfCell);
      sourceStatusEl.textContent = selectedFiles.length
        ? `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} selected.`
        : 'No PDF files selected.';
      summaryEl.innerHTML = `
        ${selectedFiles.length === 0
          ? '<p class="dataset-image-import-note">Choose PDF files to preview matches.</p>'
          : `
            <p class="dataset-image-import-summary-line">
              ${plan.matchedFileEntries.length} matched file${plan.matchedFileEntries.length === 1 ? '' : 's'} across ${plan.matchedEntries.length} row${plan.matchedEntries.length === 1 ? '' : 's'}.
            </p>
            <p class="dataset-image-import-note">
              Missing rows: ${plan.missingRows.length} · Unused files: ${plan.unmatchedFiles.length} · Existing PDFs: ${plan.overwriteRows.length}
            </p>
          `}
      `;
      const missingPreview = plan.missingRows.slice(0, 8).map((item) => item.rawValue).join(', ');
      const unmatchedPreview = plan.unmatchedFiles.slice(0, 8).map((item) => item.name).join(', ');
      const duplicatePreview = plan.duplicateSourceKeys.slice(0, 5).map((item) => item.sample).join(', ');
      previewEl.innerHTML = `
        ${missingPreview ? `<p class="dataset-image-import-note">Missing filenames: ${escapeHtml(missingPreview)}${plan.missingRows.length > 8 ? ' ...' : ''}</p>` : ''}
        ${unmatchedPreview ? `<p class="dataset-image-import-note">Unused uploaded files: ${escapeHtml(unmatchedPreview)}${plan.unmatchedFiles.length > 8 ? ' ...' : ''}</p>` : ''}
        ${duplicatePreview ? `<p class="dataset-image-import-note">Duplicate source filenames: ${escapeHtml(duplicatePreview)}${plan.duplicateSourceKeys.length > 5 ? ' ...' : ''}</p>` : ''}
      `;
      const warnings = [];
      if (plan.duplicateSourceKeys.length > 0) {
        warnings.push('The filename column contains duplicate values. Each filename should map to one row.');
      }
      if (selectedFiles.length > 0 && plan.matchedFileEntries.length === 0) {
        warnings.push('No uploaded filenames matched the selected filename column.');
      }
      setError(warnings.join(' '));
      applyBtn.disabled = selectedFiles.length === 0 || plan.matchedFileEntries.length === 0 || plan.duplicateSourceKeys.length > 0;
    }

    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal();
    });
    sourceColumnSelect.addEventListener('change', renderPlan);
    pickFilesBtn.addEventListener('click', async () => {
      selectedFiles = await (hasElectron ? window.electronAPI.pickPdfFiles() : webImageApi.pickPdfFiles());
      renderPlan();
    });
    applyBtn.addEventListener('click', async () => {
      renderPlan();
      if (applyBtn.disabled) return;
      try {
        applyBtn.disabled = true;
        const paths = plan.matchedFileEntries.map((entry) => entry.path);
        const imported = hasElectron
          ? await window.electronAPI.importPdfs(paths)
          : await webImageApi.importPdfs(getCurrentProjectId(), paths);
        const grouped = new Map();
        imported.forEach((asset, index) => {
          const rowIndex = plan.matchedFileEntries[index]?.rowIndex;
          if (!Number.isInteger(rowIndex)) return;
          const list = grouped.get(rowIndex) || [];
          list.push(asset);
          grouped.set(rowIndex, list);
        });
        grouped.forEach((assets, rowIndex) => {
          const nextAssets = [];
          const nextNames = [];
          assets.forEach((asset) => {
            nextAssets.push(asset.id);
            nextNames.push(asset.name);
          });
          rows[rowIndex][targetColIndex] = pdfCell(nextAssets, nextNames);
        });
        persistContent();
        render();
        closeModal();
      } catch (error) {
        setError(error?.message || String(error));
        applyBtn.disabled = false;
      }
    });

    document.body.appendChild(modal);
    renderPlan();
  }

  async function openImagePathImportModal(targetColIndex, options = {}) {
    const imageColName = headers[targetColIndex] || `Image ${targetColIndex + 1}`;
    const fixedRawValues = Array.isArray(options.rawValues) ? options.rawValues.map((value) => String(value ?? '')) : null;
    const lockedSourceColumnIndex = Number.isInteger(options.sourceColumnIndex) ? options.sourceColumnIndex : null;
    const textColumns = lockedSourceColumnIndex != null
      ? [{ index: lockedSourceColumnIndex, header: String(headers[lockedSourceColumnIndex] ?? '').trim() || `Column ${lockedSourceColumnIndex + 1}` }]
      : headers
          .map((header, index) => ({ index, header: String(header ?? '').trim() || `Column ${index + 1}` }))
          .filter(({ index }) => index !== targetColIndex && columnTypes[index] !== 'image');
    if (textColumns.length === 0) {
      alert('Add a text path column first, then import those paths into this image column.');
      return;
    }
    if (!hasElectron && !getCurrentProjectId()) {
      alert('Open a project first.');
      return;
    }

    let currentPathColIndex = textColumns[0].index;
    let importMode = 'replace';
    let baseDir = ''; // desktop: absolute folder path
    let webFileMap = null; // web: Map from webImageApi.pickImageDirectory()
    const hasBaseSelected = () => (hasElectron ? !!baseDir : !!webFileMap);
    let plan = buildImageImportPlanFromResolvedRows(targetColIndex, currentPathColIndex, []);
    let renderSeq = 0;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-panel modal-panel--dataset-image-import">
        <div class="modal-header">
          <h2 class="modal-title">${fixedRawValues ? `Convert path values into ${escapeHtml(imageColName)}` : `Import from path column into ${escapeHtml(imageColName)}`}</h2>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body dataset-image-import-body">
          <div class="dataset-image-import-grid">
            <div class="dataset-image-import-field">
              <label class="dataset-meta-label" for="wd-image-path-column">Path column</label>
              <select id="wd-image-path-column" class="dataset-meta-input">
                ${textColumns.map(({ index, header }) => `<option value="${index}" ${index === currentPathColIndex ? 'selected' : ''}>${escapeHtml(header)}</option>`).join('')}
              </select>
              <p class="dataset-sheet-hint">${fixedRawValues ? 'Current text values in this column will be resolved as image paths.' : 'Cells may contain one relative path or a JSON array of paths.'}</p>
            </div>
            <div class="dataset-image-import-field dataset-image-import-field--mode">
              <label class="dataset-meta-label" for="wd-image-path-mode">Write mode</label>
              <select id="wd-image-path-mode" class="dataset-meta-input">
                <option value="replace">Replace existing images</option>
                <option value="append">Append to existing images</option>
              </select>
              <p class="dataset-sheet-hint">Choose the folder that relative paths are based on.</p>
            </div>
          </div>
          <div class="dataset-import-actions">
            <button type="button" class="btn btn-secondary dataset-image-import-pick-dir">Choose base folder</button>
            <span class="dataset-filename dataset-image-import-source-status">No base folder selected.</span>
          </div>
          <div class="prompt-form-error prompt-modal-error dataset-image-import-error" hidden></div>
          <div class="dataset-image-import-summary"></div>
          <div class="dataset-image-import-preview"></div>
        </div>
        <div class="prompt-actions">
          <button type="button" class="btn btn-secondary dataset-image-import-cancel">Cancel</button>
          <button type="button" class="btn btn-primary dataset-image-import-apply">Import resolved images</button>
        </div>
      </div>
    `;

    const closeModal = () => modal.remove();
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.dataset-image-import-cancel');
    const applyBtn = modal.querySelector('.dataset-image-import-apply');
    const pathColumnSelect = modal.querySelector('#wd-image-path-column');
    const modeSelect = modal.querySelector('#wd-image-path-mode');
    const pickDirBtn = modal.querySelector('.dataset-image-import-pick-dir');
    if (lockedSourceColumnIndex != null) {
      pathColumnSelect.disabled = true;
    }

    const sourceStatusEl = modal.querySelector('.dataset-image-import-source-status');
    const errorEl = modal.querySelector('.dataset-image-import-error');
    const summaryEl = modal.querySelector('.dataset-image-import-summary');
    const previewEl = modal.querySelector('.dataset-image-import-preview');

    function setError(message = '') {
      errorEl.textContent = message;
      errorEl.hidden = !message;
    }

    function renderPreview() {
      summaryEl.innerHTML = `
        <div class="dataset-image-import-summary-card">
          <strong>${plan.matchedFileEntries.length}</strong> resolved file${plan.matchedFileEntries.length === 1 ? '' : 's'}
          into <strong>${plan.matchedEntries.length}</strong> row${plan.matchedEntries.length === 1 ? '' : 's'}.
          <ul class="dataset-image-import-stats">
            <li>Rows with missing or invalid paths: ${plan.missingRows.length}</li>
            <li>Rows with existing images: ${plan.overwriteRows.length}</li>
          </ul>
        </div>
      `;
      const previewRowsHtml = plan.previewRows.length
        ? `
          <table class="dataset-preview-table dataset-image-import-table">
            <thead>
              <tr><th>Row</th><th>Path value</th><th>Resolved files</th><th>Existing</th><th>Result</th></tr>
            </thead>
            <tbody>
              ${plan.previewRows.map((row) => `
                <tr>
                  <td>${row.rowIndex + 1}</td>
                  <td>${escapeHtml(row.matchValue || '—')}</td>
                  <td>${escapeHtml(row.fileNames.join(', '))}</td>
                  <td>${row.existingCount}</td>
                  <td>${row.resultLabel === 'partial' ? 'partial' : (row.existingCount > 0 ? escapeHtml(importMode === 'append' ? 'append' : 'replace') : 'set')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          ${plan.matchedEntries.length > plan.previewRows.length ? `<p class="dataset-sheet-hint">Showing first ${plan.previewRows.length} matched rows.</p>` : ''}
        `
        : '<p class="dataset-detail-no-data">No rows resolved yet.</p>';
      const missingPreview = plan.missingRows.slice(0, 8).map((item) => `${item.rowIndex + 1}: ${item.error}`).join(' | ');
      previewEl.innerHTML = `
        ${previewRowsHtml}
        ${missingPreview ? `<p class="dataset-sheet-hint"><strong>Path issues:</strong> ${escapeHtml(missingPreview)}${plan.missingRows.length > 8 ? ' ...' : ''}</p>` : ''}
      `;
      applyBtn.disabled = !hasBaseSelected() || plan.matchedFileEntries.length === 0;
      setError(!hasBaseSelected() ? 'Choose a base folder to resolve relative paths.' : '');
    }

    async function refreshPlan() {
      currentPathColIndex = parseInt(pathColumnSelect.value, 10);
      importMode = modeSelect.value === 'append' ? 'append' : 'replace';
      if (!hasBaseSelected()) {
        plan = buildImageImportPlanFromResolvedRows(targetColIndex, currentPathColIndex, []);
        renderPreview();
        return;
      }
      const seq = ++renderSeq;
      summaryEl.innerHTML = '<div class="dataset-image-import-summary-card">Scanning path column...</div>';
      previewEl.innerHTML = '';
      const rawValues = fixedRawValues || rows.map((row) => displayCell(row?.[currentPathColIndex] ?? ''));
      const resolvedRows = hasElectron
        ? await window.electronAPI.resolveImageCandidates(rawValues, baseDir)
        : webImageApi.resolveImageCandidatesFromFileMap(rawValues, webFileMap);
      if (seq !== renderSeq) return;
      plan = buildImageImportPlanFromResolvedRows(targetColIndex, currentPathColIndex, resolvedRows);
      renderPreview();
    }

    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal();
    });
    pathColumnSelect.addEventListener('change', () => { void refreshPlan(); });
    modeSelect.addEventListener('change', () => { void refreshPlan(); });
    pickDirBtn.addEventListener('click', async () => {
      if (hasElectron) {
        const picked = await window.electronAPI.pickImageDirectory();
        if (!picked) return;
        baseDir = picked;
        sourceStatusEl.textContent = picked;
      } else {
        const picked = await webImageApi.pickImageDirectory();
        if (!picked) return;
        webFileMap = picked.fileMap;
        sourceStatusEl.textContent = `${picked.fileCount} file${picked.fileCount === 1 ? '' : 's'} in "${picked.name}"`;
      }
      void refreshPlan();
    });
    applyBtn.addEventListener('click', async () => {
      await refreshPlan();
      if (applyBtn.disabled) return;
      try {
        applyBtn.disabled = true;
        const paths = plan.matchedFileEntries.map((entry) => entry.path);
        const imported = hasElectron
          ? await window.electronAPI.importImages(paths)
          : await webImageApi.importImages(getCurrentProjectId(), paths);
        const grouped = new Map();
        imported.forEach((asset, index) => {
          const rowIndex = plan.matchedFileEntries[index]?.rowIndex;
          if (!Number.isInteger(rowIndex)) return;
          const list = grouped.get(rowIndex) || [];
          list.push(asset);
          grouped.set(rowIndex, list);
        });
        grouped.forEach((assets, rowIndex) => {
          const existing = isImageCell(rows[rowIndex]?.[targetColIndex]) ? rows[rowIndex][targetColIndex] : imageCell();
          const nextAssets = importMode === 'append' ? existing.assetIds.slice() : [];
          const nextNames = importMode === 'append' ? (existing.names || []).slice() : [];
          assets.forEach((asset) => {
            nextAssets.push(asset.id);
            nextNames.push(asset.name);
          });
          rows[rowIndex][targetColIndex] = imageCell(nextAssets, nextNames);
        });
        if (fixedRawValues) {
          rows.forEach((row, rowIndex) => {
            if (!grouped.has(rowIndex)) row[targetColIndex] = imageCell();
          });
          columnTypes[targetColIndex] = 'image';
        }
        persistContent();
        render();
        closeModal();
      } catch (error) {
        setError(error?.message || String(error));
        applyBtn.disabled = false;
      }
    });

    document.body.appendChild(modal);
    renderPreview();
  }

  function closeAddColumnMenu() {
    if (!activeAddColumnMenu) return;
    activeAddColumnMenu.remove();
    activeAddColumnMenu = null;
  }

  function addTextColumn() {
    headers.push(`Column ${headers.length + 1}`);
    columnTypes.push('text');
    columnWidths.push(140);
    rows.forEach((row) => row.push(''));
    render();
    persistContent();
  }

  function addImageColumn() {
    headers.push(`Image ${headers.length + 1}`);
    columnTypes.push('image');
    columnWidths.push(180);
    rows.forEach((row) => row.push(imageCell()));
    const nextIndex = headers.length - 1;
    render();
    persistContent();
    return nextIndex;
  }

  function addPdfColumn() {
    headers.push(`PDF ${headers.length + 1}`);
    columnTypes.push('pdf');
    columnWidths.push(160);
    rows.forEach((row) => row.push(pdfCell()));
    const nextIndex = headers.length - 1;
    render();
    persistContent();
    return nextIndex;
  }

  function openAddColumnMenu(anchor) {
    closeAddColumnMenu();
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'wd-add-column-menu';
    menu.innerHTML = `
      <button type="button" class="wd-add-column-menu__item" data-kind="text">Text column</button>
      <button type="button" class="wd-add-column-menu__item" data-kind="image">Image column</button>
      <button type="button" class="wd-add-column-menu__item" data-kind="pdf">PDF column</button>
    `;
    menu.style.left = `${Math.max(8, rect.left)}px`;
    menu.style.top = `${rect.bottom}px`;
    const onDocPointerDown = (event) => {
      if (!menu.contains(event.target) && event.target !== anchor) {
        closeAddColumnMenu();
        document.removeEventListener('pointerdown', onDocPointerDown, true);
      }
    };
    menu.addEventListener('click', (event) => {
      const item = event.target.closest('.wd-add-column-menu__item');
      if (!item) return;
      if (item.dataset.kind === 'image') addImageColumn();
      else if (item.dataset.kind === 'pdf') addPdfColumn();
      else addTextColumn();
      closeAddColumnMenu();
      document.removeEventListener('pointerdown', onDocPointerDown, true);
    });
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.body.appendChild(menu);
    activeAddColumnMenu = menu;
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
      while (columnWidths.length < headers.length) columnWidths.push(columnTypes[columnWidths.length] === 'image' ? 180 : columnTypes[columnWidths.length] === 'pdf' ? 160 : 140);
      if (columnWidths.length > headers.length) columnWidths = columnWidths.slice(0, headers.length);
    }
    applyTableLayout();

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
        if (Number.isFinite(idx) && idx >= 0 && idx < headers.length) {
          headers[idx] = inp.value.trim() || '';
          persistContent();
        }
      });
      inp.addEventListener('click', (e) => e.stopPropagation());
      if (columnTypes[colIdx] === 'image' || columnTypes[colIdx] === 'pdf') {
        const isPdfCol = columnTypes[colIdx] === 'pdf';
        const headerTop = document.createElement('div');
        headerTop.className = 'wd-header-top';
        headerTop.appendChild(inp);
        const batchBtn = document.createElement('button');
        batchBtn.type = 'button';
        batchBtn.className = 'btn btn-secondary wd-header-batch-btn';
        batchBtn.title = isPdfCol ? 'Batch import PDFs' : 'Batch import images';
        batchBtn.setAttribute('aria-label', isPdfCol ? 'Batch import PDFs' : 'Batch import images');
        batchBtn.appendChild(isPdfCol ? iconFileText(14) : iconImageAdd(14));
        batchBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isPdfCol) await openPdfImportModal(colIdx);
          else await openImageImportModal(colIdx);
        });
        headerTop.appendChild(batchBtn);
        th.appendChild(headerTop);
      } else {
        th.appendChild(inp);
      }
      const resizeHandle = document.createElement('div');
      resizeHandle.className = 'wd-col-resize-handle';
      resizeHandle.setAttribute('aria-label', 'Resize column');
      resizeHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = columnWidths[colIdx] ?? 140;
        document.body.classList.add('wd-col-resizing');
        const onMove = (moveE) => {
          const dx = moveE.clientX - startX;
          const newW = Math.max(60, startW + dx);
          columnWidths[colIdx] = newW;
          applyTableLayout();
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
        if (columnTypes[colIdx] === 'image') {
          const cell = isImageCell(rowData[colIdx]) ? rowData[colIdx] : imageCell();
          const imageBox = document.createElement('div');
          imageBox.className = 'wd-image-cell';
          if (!cell.assetIds.length) imageBox.classList.add('wd-image-cell--empty');
          const overlayActions = document.createElement('div');
          overlayActions.className = 'wd-image-overlay-actions';
          const add = document.createElement('button');
          add.type = 'button';
          add.className = 'btn btn-secondary wd-image-import-btn';
          add.title = 'Import image';
          add.setAttribute('aria-label', 'Import image');
          add.appendChild(iconImageAdd(14));
          add.addEventListener('click', async () => {
            try {
              let assets;
              if (hasElectron) {
                assets = await window.electronAPI.importImages();
              } else {
                const files = await webImageApi.pickImageFiles();
                assets = files.length ? await webImageApi.importImages(getCurrentProjectId(), files) : [];
              }
              if (!assets.length) return;
              rows[originalRowIdx][colIdx] = imageCell(
                [...cell.assetIds, ...assets.map((a) => a.id)],
                [...(cell.names || []), ...assets.map((a) => a.name)],
              );
              persistContent();
              render();
            } catch (error) { alert(error.message); }
          });
          overlayActions.appendChild(add);
          imageBox.appendChild(overlayActions);
          const strip = document.createElement('div');
          strip.className = 'wd-image-strip';
          cell.assetIds.forEach((assetId, imageIndex) => {
            const wrap = document.createElement('div');
            wrap.className = 'wd-image-thumb-wrap';
            const tile = document.createElement('button');
            tile.type = 'button';
            tile.className = 'wd-image-thumb';
            tile.title = cell.names?.[imageIndex] || 'View image';
            tile.textContent = 'Loading…';
            tile.addEventListener('click', async () => {
              try {
                const full = hasElectron
                  ? await window.electronAPI.imagePreview(assetId, false)
                  : await webImageApi.imagePreview(getCurrentProjectId(), assetId, false);
                const viewer = document.createElement('div');
                viewer.className = 'modal-overlay wd-image-viewer';
                viewer.innerHTML = `<div class="wd-image-viewer-panel"><button type="button" class="modal-close" aria-label="Close">×</button><img alt="${escapeHtml(full.name || 'Dataset image')}" src="${full.url}"><p>${escapeHtml(full.name || '')} · ${full.width}×${full.height}</p></div>`;
                viewer.querySelector('.modal-close').onclick = () => viewer.remove();
                viewer.addEventListener('click', (event) => { if (event.target === viewer) viewer.remove(); });
                document.body.appendChild(viewer);
              } catch (error) { alert(error.message); }
            });
            wrap.appendChild(tile);
            // Sibling, not nested inside the thumb <button> (buttons can't contain buttons) —
            // positioned over the corner via CSS, only shown while hovering this one wrap.
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'wd-image-thumb-remove';
            remove.title = 'Remove this image';
            remove.setAttribute('aria-label', 'Remove this image');
            remove.textContent = '×';
            remove.addEventListener('click', (e) => {
              e.stopPropagation();
              rows[originalRowIdx][colIdx] = imageCell(
                cell.assetIds.filter((_, i) => i !== imageIndex),
                (cell.names || []).filter((_, i) => i !== imageIndex),
              );
              persistContent();
              render();
            });
            wrap.appendChild(remove);
            strip.appendChild(wrap);
            (hasElectron ? window.electronAPI.imagePreview(assetId) : webImageApi.imagePreview(getCurrentProjectId(), assetId)).then((preview) => {
              if (!tile.isConnected) return;
              tile.textContent = '';
              const img = document.createElement('img');
              img.src = preview.url;
              img.alt = preview.name || 'Image';
              tile.appendChild(img);
            }).catch(() => { tile.textContent = 'Missing'; tile.classList.add('wd-image-thumb--error'); });
          });
          imageBox.append(strip);
          td.appendChild(imageBox);
          tr.appendChild(td);
          return;
        }
        if (columnTypes[colIdx] === 'pdf') {
          const cell = isPdfCell(rowData[colIdx]) ? rowData[colIdx] : pdfCell();
          const pdfBox = document.createElement('div');
          pdfBox.className = 'wd-pdf-cell';
          if (!cell.assetIds.length) pdfBox.classList.add('wd-pdf-cell--empty');
          const overlayActions = document.createElement('div');
          overlayActions.className = 'wd-image-overlay-actions';
          const add = document.createElement('button');
          add.type = 'button';
          add.className = 'btn btn-secondary wd-image-import-btn';
          add.title = 'Upload PDF';
          add.setAttribute('aria-label', 'Upload PDF');
          add.appendChild(iconFileText(14));
          add.addEventListener('click', async () => {
            try {
              let assets;
              if (hasElectron) {
                assets = await window.electronAPI.importPdfs();
              } else {
                const files = await webImageApi.pickPdfFiles();
                assets = files.length ? await webImageApi.importPdfs(getCurrentProjectId(), files) : [];
              }
              if (!assets.length) return;
              rows[originalRowIdx][colIdx] = pdfCell(
                [...cell.assetIds, ...assets.map((a) => a.id)],
                [...(cell.names || []), ...assets.map((a) => a.name)],
              );
              persistContent();
              render();
            } catch (error) { alert(error.message); }
          });
          overlayActions.appendChild(add);
          pdfBox.appendChild(overlayActions);
          const strip = document.createElement('div');
          strip.className = 'wd-pdf-strip';
          cell.assetIds.forEach((assetId, fileIndex) => {
            const wrap = document.createElement('div');
            wrap.className = 'wd-pdf-chip-wrap';
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'wd-pdf-chip';
            const chipName = cell.names?.[fileIndex] || 'PDF';
            chip.title = chipName;
            chip.appendChild(iconFileText(14));
            const label = document.createElement('span');
            label.className = 'wd-pdf-chip-name';
            label.textContent = chipName;
            chip.appendChild(label);
            chip.addEventListener('click', async () => {
              try {
                const full = hasElectron
                  ? await window.electronAPI.imagePreview(assetId, false)
                  : await webImageApi.imagePreview(getCurrentProjectId(), assetId, false);
                const blob = await (await fetch(full.url)).blob();
                window.open(URL.createObjectURL(blob), '_blank');
              } catch (error) { alert(error.message); }
            });
            wrap.appendChild(chip);
            // Sibling, not nested inside the chip <button> (buttons can't contain buttons) —
            // positioned over the corner via CSS, only shown while hovering this one wrap.
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'wd-pdf-chip-remove';
            remove.title = 'Remove this PDF';
            remove.setAttribute('aria-label', 'Remove this PDF');
            remove.textContent = '×';
            remove.addEventListener('click', (e) => {
              e.stopPropagation();
              rows[originalRowIdx][colIdx] = pdfCell(
                cell.assetIds.filter((_, i) => i !== fileIndex),
                (cell.names || []).filter((_, i) => i !== fileIndex),
              );
              persistContent();
              render();
            });
            wrap.appendChild(remove);
            strip.appendChild(wrap);
          });
          pdfBox.append(strip);
          td.appendChild(pdfBox);
          tr.appendChild(td);
          return;
        }
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
            persistContent();
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
          document.body.classList.add('wd-col-resizing');
          const onMove = (moveE) => {
            const dx = moveE.clientX - startX;
            const newW = Math.max(60, startW + dx);
            columnWidths[colIdx] = newW;
          applyTableLayout();
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
    rows.push(columnTypes.map((type) => type === 'image' ? imageCell() : type === 'pdf' ? pdfCell() : ''));
    rowIds.push(crypto.randomUUID());
    rowHeights.push(undefined);
    render();
    persistContent();
  });

  addColBtn.addEventListener('click', () => {
    addTextColumn();
  });

  if (linkImagesBtn) {
    linkImagesBtn.addEventListener('click', () => {
      const newIndex = addImageColumn();
      selectedColIndex = newIndex;
      selectedRowIndex = -1;
      render();
    });
  }

  if (linkPdfBtn) {
    linkPdfBtn.addEventListener('click', () => {
      const newIndex = addPdfColumn();
      selectedColIndex = newIndex;
      selectedRowIndex = -1;
      render();
    });
  }

  deleteRowBtn.addEventListener('click', () => {
    if (rows.length === 0 || selectedRowIndex < 0 || selectedRowIndex >= rows.length) return;
    rows.splice(selectedRowIndex, 1);
    rowIds.splice(selectedRowIndex, 1);
    rowHeights.splice(selectedRowIndex, 1);
    selectedRowIndex = -1;
    const totalPages = Math.max(1, Math.ceil(rows.length / rowsPerPage));
    if (currentPage > totalPages) currentPage = totalPages;
    render();
    persistContent();
  });

  deleteColBtn.addEventListener('click', () => {
    if (headers.length <= 1 || selectedColIndex < 0 || selectedColIndex >= headers.length) return;
    headers.splice(selectedColIndex, 1);
    columnTypes.splice(selectedColIndex, 1);
    columnWidths.splice(selectedColIndex, 1);
    rows.forEach((r) => r.splice(selectedColIndex, 1));
    selectedColIndex = -1;
    render();
    persistContent();
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

  if (exportLocalBtn) {
    exportLocalBtn.addEventListener('click', async () => {
      const defaultBase = sanitizeFilename(name);
      const api = window.electronAPI;
      const filters = [
        { name: 'CSV', extensions: ['csv'] },
        { name: 'TSV', extensions: ['tsv'] },
        { name: 'Excel', extensions: ['xlsx'] },
      ];
      const hasAssetColumn = columnTypes.includes('image') || columnTypes.includes('pdf');
      if (hasAssetColumn) filters.splice(1);
      let path;
      let encoding = 'utf8';
      let payload;
      if (api?.showSaveFileDialog && api?.writeFile) {
        path = await api.showSaveFileDialog({
          title: 'Save dataset',
          defaultPath: `${defaultBase}.csv`,
          filters,
        });
      }
      if (!path && !api?.showSaveFileDialog) {
        path = `${defaultBase}.csv`;
      }
      if (path) {
        if (hasAssetColumn) {
          if (hasElectron) {
            await api.exportImageDataset(path, { headers, columnTypes, rowIds, rows });
          } else {
            await webImageApi.exportDatasetZip(getCurrentProjectId(), { headers, columnTypes, rowIds, rows });
          }
          return;
        }
        const ext = path.toLowerCase().slice(path.lastIndexOf('.'));
        if (ext === '.tsv') {
          const headerLine = headers.map(escapeTsvField).join('\t');
          const dataLines = rows.map((row) => headers.map((_, i) => escapeTsvField(row[i] ?? '')).join('\t'));
          payload = [headerLine, ...dataLines].join('\r\n');
        } else if (ext === '.xlsx' || ext === '.xls') {
          const wb = XLSX.utils.book_new();
          const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
          XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1');
          payload = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
          encoding = 'base64';
        } else {
          const headerLine = headers.map(escapeCsvField).join(',');
          const dataLines = rows.map((row) => headers.map((_, i) => escapeCsvField(row[i] ?? '')).join(','));
          payload = '\ufeff' + [headerLine, ...dataLines].join('\r\n');
        }
        if (api?.writeFile) {
          await api.writeFile(path, payload, encoding);
        } else {
          const mime = ext === '.tsv' ? 'text/tab-separated-values' : ext === '.xlsx' || ext === '.xls' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv';
          const blob = encoding === 'base64' ? new Blob([Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))], { type: mime }) : new Blob([payload], { type: mime + ';charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = path.split(/[/\\]/).pop() || `${defaultBase}.csv`;
          a.click();
          URL.revokeObjectURL(a.href);
        }
      }
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
  let layoutFrame = 0;
  const scheduleTableLayout = () => {
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      applyTableLayout();
    });
  };
  const resizeObserver = typeof ResizeObserver === 'function' && tableWrap
    ? new ResizeObserver(scheduleTableLayout)
    : null;
  resizeObserver?.observe(tableWrap);
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

  function persistContent() {
    saveContent({ headers, columnTypes, rowIds, rows });
  }

  function close() {
    persistContent();
    closeAddColumnMenu();
    resizeObserver?.disconnect();
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    overlay.remove();
    document.body.style.overflow = '';
  }

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  render();
}
