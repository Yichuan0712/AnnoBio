/**
 * "Add a new dataset" modal: import CSV/TSV file, show parsed headers.
 */

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

export function openAddDatasetModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'new-dataset-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--dataset">
      <div class="modal-header">
        <h2 id="new-dataset-title" class="modal-title">Add a new dataset</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body modal-body--dataset">
        <div class="dataset-main">
          <div class="dataset-import">
            <input type="file" id="dataset-file-input" accept=".csv,.tsv,text/csv,text/tab-separated-values" hidden />
            <button type="button" class="btn btn-secondary dataset-import-btn">Import file (CSV / TSV)</button>
            <span class="dataset-filename" aria-live="polite"></span>
          </div>
          <div class="dataset-headers-wrap">
            <h3 class="dataset-headers-title">Columns</h3>
            <div class="dataset-headers-list" aria-live="polite">No file imported yet.</div>
          </div>
          <div class="dataset-meta-wrap">
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="dataset-name-input">Dataset name</label>
              <input type="text" id="dataset-name-input" class="dataset-meta-input" placeholder="File name" />
            </div>
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="dataset-notes-input">Dataset notes</label>
              <textarea id="dataset-notes-input" class="dataset-meta-input dataset-meta-textarea" rows="3" placeholder="This dataset has no notes"></textarea>
            </div>
            <button type="button" class="btn btn-secondary dataset-add-btn">Add this dataset</button>
          </div>
        </div>
        <div class="dataset-preview-wrap">
          <div class="dataset-preview-file-info" aria-live="polite"></div>
          <h3 class="dataset-preview-title">Preview</h3>
          <div class="dataset-preview" aria-live="polite">No file imported yet.</div>
        </div>
      </div>
    </div>
  `;

  const fileInput = overlay.querySelector('#dataset-file-input');
  const importBtn = overlay.querySelector('.dataset-import-btn');
  const filenameEl = overlay.querySelector('.dataset-filename');
  const previewFileInfoEl = overlay.querySelector('.dataset-preview-file-info');
  const headersListEl = overlay.querySelector('.dataset-headers-list');
  const previewEl = overlay.querySelector('.dataset-preview');
  const nameInput = overlay.querySelector('#dataset-name-input');
  const notesInput = overlay.querySelector('#dataset-notes-input');
  const addBtn = overlay.querySelector('.dataset-add-btn');

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatDate(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

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
    if (!isCsv && !isTsv) {
      filenameEl.textContent = 'Please choose a .csv or .tsv file.';
      previewFileInfoEl.innerHTML = '';
      headersListEl.textContent = 'No file imported yet.';
      previewEl.textContent = 'No file imported yet.';
      return;
    }
    filenameEl.textContent = file.name;
    nameInput.value = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      let text = reader.result;
      text = text.replace(/^\uFEFF/, '');
      const lines = text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      const parseLine = isTsv ? parseTsvLine : parseCsvLine;
      const headerLine = lines[0] ?? '';
      const headers = parseLine(headerLine).filter((c) => c.length > 0);

      const rowCount = Math.max(0, lines.length - 1);
      previewFileInfoEl.innerHTML = `
        <div class="dataset-file-info-row"><span class="dataset-file-info-label">Rows</span><span class="dataset-file-info-value">${rowCount.toLocaleString()}</span></div>
        <div class="dataset-file-info-row"><span class="dataset-file-info-label">File size</span><span class="dataset-file-info-value">${formatSize(file.size)}</span></div>
        <div class="dataset-file-info-row"><span class="dataset-file-info-label">Modified</span><span class="dataset-file-info-value">${formatDate(file.lastModified)}</span></div>
      `;
      previewFileInfoEl.classList.add('dataset-preview-file-info--filled');

      if (headers.length === 0) {
        headersListEl.textContent = 'No columns found in first line.';
        previewEl.textContent = 'No columns found in first line.';
        return;
      }
      headersListEl.innerHTML = '';
      headersListEl.classList.add('dataset-headers-list--loaded');
      headers.forEach((h) => {
        const span = document.createElement('span');
        span.className = 'dataset-header-tag';
        span.textContent = h;
        headersListEl.appendChild(span);
      });
      function truncate(str) {
        const s = String(str ?? '');
        return s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS) + '…' : s;
      }
      const dataLines = lines.slice(1, 1 + MAX_PREVIEW_ROWS);
      const rows = dataLines.map((line) => parseLine(line));
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
      if (lines.length - 1 > MAX_PREVIEW_ROWS) {
        const cap = document.createElement('p');
        cap.className = 'dataset-preview-cap';
        cap.textContent = `Showing first ${MAX_PREVIEW_ROWS} rows.`;
        previewEl.appendChild(cap);
      }
    };
    reader.onerror = () => {
      filenameEl.textContent = 'Failed to read file.';
      previewFileInfoEl.innerHTML = '';
      previewFileInfoEl.classList.remove('dataset-preview-file-info--filled');
      headersListEl.textContent = 'No file imported yet.';
      previewEl.textContent = 'No file imported yet.';
    };
    reader.readAsText(file, 'UTF-8');
  });

  addBtn.addEventListener('click', () => {
    const name = (nameInput.value || '').trim() || nameInput.placeholder;
    const notes = (notesInput.value || '').trim() || '';
    // TODO: persist dataset (name, notes, file/headers) and close
    console.log('Add dataset:', { name, notes });
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
