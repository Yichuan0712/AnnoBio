/**
 * "Add a new dataset" modal: two steps.
 * Step 1: Name & description.
 * Step 2: Left = upload CSV/TSV/XLSX, Right = preview.
 */

import * as XLSX from 'xlsx';

function parseCsvLine(line) {
  line = String(line ?? '').trim();
  const cols = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      const end = line.indexOf('"', i + 1);
      if (end === -1) {
        cols.push(line.slice(i + 1).trim());
        break;
      }
      cols.push(line.slice(i + 1, end).replace(/""/g, '"'));
      i = end + 1;
      if (line[i] === ',') i += 1;
    } else {
      const comma = line.indexOf(',', i);
      if (comma === -1) {
        cols.push(line.slice(i).trim());
        break;
      }
      cols.push(line.slice(i, comma).trim());
      i = comma + 1;
    }
  }
  return cols;
}

function parseTsvLine(line) {
  return line.split('\t').map((s) => s.trim());
}

const MAX_PREVIEW_ROWS = 10;
const MAX_CELL_CHARS = 30;

export function openAddDatasetModal(workflowCanvasApi) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'new-dataset-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--dataset" data-add-dataset-step="1">
      <div class="modal-header">
        <h2 id="new-dataset-title" class="modal-title">Create a new dataset</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body modal-body--dataset">
        <div class="dataset-add-main">
          <div class="dataset-add-step dataset-add-step-1">
            <p class="prompt-step-label">Step 1 of 2 — Name & description</p>
            <div class="dataset-meta-wrap prompt-meta-wrap">
              <div class="dataset-meta-field">
                <label class="dataset-meta-label" for="dataset-name-input">Dataset name</label>
                <input type="text" id="dataset-name-input" class="dataset-meta-input" placeholder="My dataset" />
              </div>
              <div class="dataset-meta-field">
                <label class="dataset-meta-label" for="dataset-notes-input">Dataset description</label>
                <textarea id="dataset-notes-input" class="dataset-meta-input dataset-meta-textarea" rows="3" placeholder="What this dataset is for"></textarea>
              </div>
            </div>
            <div class="prompt-form-error prompt-modal-error dataset-add-error" role="alert" aria-live="polite" hidden></div>
            <div class="prompt-actions">
              <button type="button" class="btn btn-secondary dataset-add-btn-next">Next</button>
            </div>
          </div>
          <div class="dataset-add-step dataset-add-step-2">
            <p class="prompt-step-label">Step 2 of 2 — Upload file</p>
            <div class="dataset-add-step2-scroll">
              <div class="dataset-add-step2-left">
                <div class="dataset-import">
                  <h3 class="dataset-import-title">Select file</h3>
                  <div class="dataset-import-actions">
                    <input type="file" id="dataset-file-input" accept=".csv,.tsv,.xlsx,.xls,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" hidden />
                    <button type="button" class="btn btn-secondary dataset-import-btn">Choose CSV / TSV / XLSX file</button>
                    <span class="dataset-filename" aria-live="polite"></span>
                  </div>
                  <div class="dataset-sheet-wrap" id="dataset-sheet-wrap" style="display:none">
                    <label class="dataset-meta-label" for="dataset-sheet-select">Sheet</label>
                    <p class="dataset-sheet-hint" id="dataset-sheet-hint">This file has multiple sheets. Select which sheet to import.</p>
                    <select id="dataset-sheet-select" class="dataset-meta-input" aria-label="Select sheet"></select>
                  </div>
                  <div class="dataset-file-info" id="dataset-file-info" aria-live="polite">
                    <span class="dataset-file-info-placeholder">No file selected.</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="prompt-form-error prompt-modal-error dataset-add-error" role="alert" aria-live="polite" hidden></div>
            <div class="prompt-actions">
              <button type="button" class="btn btn-secondary dataset-add-btn-back">Back</button>
              <button type="button" class="btn btn-primary dataset-add-btn">Create this dataset</button>
            </div>
          </div>
        </div>
        <div class="dataset-add-preview-wrap prompt-preview-wrap">
          <h3 class="prompt-preview-title">Dataset preview</h3>
          <div class="dataset-preview prompt-preview prompt-preview--empty" aria-live="polite">No file selected yet.</div>
        </div>
      </div>
    </div>
  `;

  const panel = overlay.querySelector('.modal-panel--dataset');
  const fileInput = overlay.querySelector('#dataset-file-input');
  const importBtn = overlay.querySelector('.dataset-import-btn');
  const filenameEl = overlay.querySelector('.dataset-filename');
  const sheetWrap = overlay.querySelector('#dataset-sheet-wrap');
  const sheetSelect = overlay.querySelector('#dataset-sheet-select');
  const fileInfoEl = overlay.querySelector('#dataset-file-info');
  const previewEl = overlay.querySelector('.dataset-add-preview-wrap .dataset-preview');
  const nameInput = overlay.querySelector('#dataset-name-input');
  const notesInput = overlay.querySelector('#dataset-notes-input');
  const nextBtn = overlay.querySelector('.dataset-add-btn-next');
  const backBtn = overlay.querySelector('.dataset-add-btn-back');
  const addBtn = overlay.querySelector('.dataset-add-btn');
  const formErrorEls = overlay.querySelectorAll('.dataset-add-error');

  let fileImported = false;
  /** @type {{ headers: string[], rows: string[][] } | null} */
  let parsedDatasetContent = null;
  /** @type {import('xlsx').WorkBook | null} */
  let xlsxWorkbook = null;

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function setFileInfoPlaceholder(msg) {
    if (!fileInfoEl) return;
    fileInfoEl.className = 'dataset-file-info';
    fileInfoEl.innerHTML = `<span class="dataset-file-info-placeholder">${escapeHtml(msg || 'No file selected.')}</span>`;
  }

  function formatDate(ms) {
    if (ms == null || Number.isNaN(ms)) return '—';
    const d = new Date(ms);
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  }

  function setFileInfo(file, format, numColumns, numRows, headers) {
    if (!fileInfoEl) return;
    const delimiter = format === 'TSV' ? 'Tab' : (format === 'XLSX' ? '—' : 'Comma');
    const headersLabel = (headers || []).map((h) => escapeHtml(String(h))).join(', ');
    fileInfoEl.className = 'dataset-file-info dataset-file-info--filled';
    fileInfoEl.innerHTML = `
      <div class="dataset-file-info-row"><span class="dataset-file-info-label">File size</span><span class="dataset-file-info-value">${escapeHtml(formatSize(file.size))}</span></div>
      <div class="dataset-file-info-row"><span class="dataset-file-info-label">Format</span><span class="dataset-file-info-value">${escapeHtml(format)}</span></div>
      <div class="dataset-file-info-row"><span class="dataset-file-info-label">Delimiter</span><span class="dataset-file-info-value">${escapeHtml(delimiter)}</span></div>
      <div class="dataset-file-info-row"><span class="dataset-file-info-label">Encoding</span><span class="dataset-file-info-value">UTF-8</span></div>
      <div class="dataset-file-info-row"><span class="dataset-file-info-label">Columns</span><span class="dataset-file-info-value">${String(numColumns)}</span></div>
      <div class="dataset-file-info-row"><span class="dataset-file-info-label">Rows</span><span class="dataset-file-info-value">${numRows.toLocaleString()}</span></div>
      <div class="dataset-file-info-row"><span class="dataset-file-info-label">Modified</span><span class="dataset-file-info-value">${escapeHtml(formatDate(file.lastModified))}</span></div>
      <div class="dataset-file-info-row dataset-file-info-row--headers"><span class="dataset-file-info-label">Headers</span><span class="dataset-file-info-value">${headersLabel}</span></div>
    `;
  }

  function truncate(str) {
    const s = String(str ?? '');
    return s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS) + '…' : s;
  }

  function renderPreviewTable(headers, rows, totalRows) {
    previewEl.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'dataset-preview-table';
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headers.forEach((h) => {
      const th = document.createElement('th');
      th.textContent = truncate(h);
      th.title = h;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      headers.forEach((_, i) => {
        const td = document.createElement('td');
        td.textContent = truncate(row[i]);
        td.title = row[i] ?? '';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    previewEl.appendChild(table);
    if (totalRows > MAX_PREVIEW_ROWS) {
      const cap = document.createElement('p');
      cap.className = 'dataset-preview-cap';
      cap.textContent = `Showing first ${MAX_PREVIEW_ROWS} rows. (${totalRows.toLocaleString()} rows in total.)`;
      previewEl.appendChild(cap);
    }
    previewEl.classList.remove('prompt-preview--empty');
  }

  function applyXlsxSheet(wb, sheetName, file) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return;
    const arr = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!arr || arr.length === 0) {
      fileImported = false;
      parsedDatasetContent = null;
      setFileInfoPlaceholder('Sheet is empty.');
      previewEl.textContent = 'Sheet is empty.';
      previewEl.classList.add('prompt-preview--empty');
      return;
    }
    const headerRow = arr[0];
    const headers = (headerRow || []).map((c) => String(c ?? '').trim());
    if (headers.length === 0 || headers.every((h) => !h)) {
      setFileInfoPlaceholder('No columns in first row.');
      previewEl.textContent = 'No columns in first row.';
      previewEl.classList.add('prompt-preview--empty');
      return;
    }
    const allRows = arr.slice(1).map((row) => headers.map((_, i) => (row && row[i] != null ? String(row[i]) : '')));
    fileImported = true;
    parsedDatasetContent = { headers, rows: allRows };
    setFileInfo(file, 'XLSX', headers.length, allRows.length, headers);
    const previewRows = allRows.slice(0, MAX_PREVIEW_ROWS);
    renderPreviewTable(headers, previewRows, allRows.length);
  }

  function showError(msg) {
    formErrorEls.forEach((el) => {
      if (el) {
        el.textContent = msg;
        el.hidden = false;
      }
    });
  }

  function hideError() {
    formErrorEls.forEach((el) => {
      if (el) el.hidden = true;
    });
  }

  function goToStep(step) {
    panel.setAttribute('data-add-dataset-step', String(step));
  }

  nextBtn.addEventListener('click', () => {
    hideError();
    const name = (nameInput.value || '').trim();
    const notes = (notesInput.value || '').trim();
    if (!name) {
      showError('Dataset name is required.');
      return;
    }
    if (!notes) {
      showError('Dataset description is required.');
      return;
    }
    const isNameUsed = workflowCanvasApi?.isDatasetNameAlreadyUsed?.(name);
    if (isNameUsed) {
      showError('This dataset name is already used on the canvas. Please choose another.');
      return;
    }
    goToStep(2);
  });

  backBtn.addEventListener('click', () => goToStep(1));

  importBtn.addEventListener('click', () => fileInput.click());

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    const isCsv = name.endsWith('.csv');
    const isTsv = name.endsWith('.tsv');
    const isXlsx = name.endsWith('.xlsx') || name.endsWith('.xls');
    if (!isCsv && !isTsv && !isXlsx) {
      fileImported = false;
      parsedDatasetContent = null;
      xlsxWorkbook = null;
      if (sheetWrap) sheetWrap.style.display = 'none';
      filenameEl.textContent = 'Please choose a .csv, .tsv or .xlsx file.';
      setFileInfoPlaceholder('Please choose a .csv, .tsv or .xlsx file.');
      previewEl.textContent = 'No file selected yet.';
      previewEl.classList.add('prompt-preview--empty');
      return;
    }
    fileImported = false;
    parsedDatasetContent = null;
    xlsxWorkbook = null;
    if (sheetWrap) sheetWrap.style.display = 'none';
    filenameEl.textContent = file.name;
    setFileInfoPlaceholder('Loading…');

    if (isXlsx) {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = new Uint8Array(reader.result);
          const wb = XLSX.read(data, { type: 'array' });
          xlsxWorkbook = wb;
          const sheetNames = wb.SheetNames || [];
          if (sheetNames.length === 0) {
            setFileInfoPlaceholder('No sheets in workbook.');
            previewEl.textContent = 'No sheets in workbook.';
            previewEl.classList.add('prompt-preview--empty');
            return;
          }
          if (sheetNames.length > 1) {
            sheetWrap.style.display = '';
            sheetSelect.innerHTML = sheetNames.map((s, i) => `<option value="${escapeHtml(s)}" ${i === 0 ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('');
            sheetSelect.onchange = () => {
              if (xlsxWorkbook) applyXlsxSheet(xlsxWorkbook, sheetSelect.value, file);
            };
          }
          applyXlsxSheet(wb, sheetNames[0], file);
        } catch (err) {
          fileImported = false;
          parsedDatasetContent = null;
          xlsxWorkbook = null;
          setFileInfoPlaceholder('Failed to parse XLSX.');
          previewEl.textContent = 'Failed to parse XLSX.';
          previewEl.classList.add('prompt-preview--empty');
        }
      };
      reader.onerror = () => {
        fileImported = false;
        parsedDatasetContent = null;
        xlsxWorkbook = null;
        filenameEl.textContent = 'Failed to read file.';
        setFileInfoPlaceholder('Failed to read file.');
        previewEl.textContent = 'No file selected yet.';
        previewEl.classList.add('prompt-preview--empty');
      };
      reader.readAsArrayBuffer(file);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      let text = reader.result;
      text = text.replace(/^\uFEFF/, '');
      const lines = text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      const parseLine = isTsv ? parseTsvLine : parseCsvLine;
      const headerLine = lines[0] ?? '';
      const headers = parseLine(headerLine).filter((c) => c.length > 0);

      if (headers.length === 0) {
        fileImported = false;
        parsedDatasetContent = null;
        setFileInfoPlaceholder('No columns found in first line.');
        previewEl.textContent = 'No columns found in first line.';
        previewEl.classList.add('prompt-preview--empty');
        return;
      }
      fileImported = true;
      const allDataLines = lines.slice(1);
      const allRows = allDataLines.map((line) => parseLine(line));
      parsedDatasetContent = { headers, rows: allRows };
      setFileInfo(file, isTsv ? 'TSV' : 'CSV', headers.length, allRows.length, headers);
      const dataLines = lines.slice(1, 1 + MAX_PREVIEW_ROWS);
      const rows = dataLines.map((line) => parseLine(line));
      renderPreviewTable(headers, rows, allRows.length);
    };
    reader.onerror = () => {
      fileImported = false;
      parsedDatasetContent = null;
      filenameEl.textContent = 'Failed to read file.';
      setFileInfoPlaceholder('Failed to read file.');
      previewEl.textContent = 'No file selected yet.';
      previewEl.classList.add('prompt-preview--empty');
    };
    reader.readAsText(file, 'UTF-8');
  });

  addBtn.addEventListener('click', () => {
    hideError();
    const name = (nameInput.value || '').trim();
    const notes = (notesInput.value || '').trim();
    if (!name) {
      showError('Dataset name is required.');
      return;
    }
    if (!notes) {
      showError('Dataset description is required.');
      return;
    }
    const isNameUsed = workflowCanvasApi?.isDatasetNameAlreadyUsed?.(name);
    if (isNameUsed) {
      showError('This dataset name is already used on the canvas. Please choose another.');
      return;
    }
    const headers = fileImported && parsedDatasetContent?.headers ? parsedDatasetContent.headers : [];
    const rows = fileImported && parsedDatasetContent?.rows ? parsedDatasetContent.rows : [];
    document.dispatchEvent(
      new CustomEvent('workflow:add-dataset-node', {
        detail: {
          name,
          notes,
          headers,
          rows,
        },
      })
    );
    close();
  });

  const close = () => {
    overlay.remove();
    document.body.style.overflow = '';
  };
  overlay.querySelector('.modal-close').addEventListener('click', close);

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
