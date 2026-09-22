/**
 * "Add a new dataset" modal: two steps.
 * Step 1: Name & description.
 * Step 2: choose a data source -- upload CSV/TSV/XLSX, import from PubMed, ClinicalTrials.gov,
 * bioRxiv/medRxiv or ChEMBL -- then preview.
 */

import * as XLSX from 'xlsx';
import { BACKEND_API_BASE } from './backendConfig.js';
import { showConfirm } from './alertModal.js';
import { pdfCell } from './datasetContent.js';
import { getCurrentProjectId } from './currentProject.js';
import * as webImageApi from './webImageApi.js';

const API_BASE = BACKEND_API_BASE;
const PUBMED_POLL_INTERVAL_MS = 1200;
const CLINICALTRIALS_POLL_INTERVAL_MS = 1200;
const PREPRINT_POLL_INTERVAL_MS = 1200;
const CHEMBL_POLL_INTERVAL_MS = 1200;

/** Keep in sync with backend/pubmed_client.py PUBMED_FIELDS. */
const PUBMED_FIELD_OPTIONS = [
  { key: 'pmid', label: 'PMID', defaultOn: true },
  { key: 'title', label: 'Title', defaultOn: true },
  { key: 'abstract', label: 'Abstract', defaultOn: true },
  { key: 'authors', label: 'Authors', defaultOn: true },
  { key: 'year', label: 'Year', defaultOn: true },
  { key: 'journal', label: 'Journal', defaultOn: false },
  { key: 'doi', label: 'DOI', defaultOn: false },
  { key: 'mesh_terms', label: 'MeSH Terms', defaultOn: false },
  { key: 'publication_type', label: 'Publication Type', defaultOn: false },
];

/** Keep in sync with backend/clinicaltrials_client.py CT_FIELDS. */
const CLINICALTRIALS_FIELD_OPTIONS = [
  { key: 'nct_id', label: 'NCT ID', defaultOn: true },
  { key: 'brief_title', label: 'Brief Title', defaultOn: true },
  { key: 'brief_summary', label: 'Brief Summary', defaultOn: true },
  { key: 'conditions', label: 'Conditions', defaultOn: true },
  { key: 'phase', label: 'Phase', defaultOn: true },
  { key: 'overall_status', label: 'Overall Status', defaultOn: true },
  { key: 'official_title', label: 'Official Title', defaultOn: false },
  { key: 'detailed_description', label: 'Detailed Description', defaultOn: false },
  { key: 'interventions', label: 'Interventions', defaultOn: false },
  { key: 'study_type', label: 'Study Type', defaultOn: false },
  { key: 'start_date', label: 'Start Date', defaultOn: false },
  { key: 'completion_date', label: 'Completion Date', defaultOn: false },
  { key: 'sponsor', label: 'Sponsor', defaultOn: false },
  { key: 'eligibility_criteria', label: 'Eligibility Criteria', defaultOn: false },
  { key: 'sex', label: 'Sex', defaultOn: false },
  { key: 'minimum_age', label: 'Minimum Age', defaultOn: false },
  { key: 'maximum_age', label: 'Maximum Age', defaultOn: false },
];

/** Keep in sync with backend/preprint_client.py PREPRINT_FIELDS. */
const PREPRINT_FIELD_OPTIONS = [
  { key: 'doi', label: 'DOI', defaultOn: true },
  { key: 'title', label: 'Title', defaultOn: true },
  { key: 'abstract', label: 'Abstract', defaultOn: true },
  { key: 'authors', label: 'Authors', defaultOn: true },
  { key: 'date', label: 'Date', defaultOn: true },
  { key: 'server', label: 'Server', defaultOn: true },
  { key: 'corresponding_author', label: 'Corresponding Author', defaultOn: false },
  { key: 'corresponding_institution', label: 'Corresponding Institution', defaultOn: false },
  { key: 'category', label: 'Category', defaultOn: false },
  { key: 'version', label: 'Version', defaultOn: false },
  { key: 'license', label: 'License', defaultOn: false },
  { key: 'published', label: 'Published DOI', defaultOn: false },
];

/** Keep in sync with backend/chembl_client.py CHEMBL_FIELDS. */
const CHEMBL_FIELD_OPTIONS = [
  { key: 'chembl_id', label: 'ChEMBL ID', defaultOn: true },
  { key: 'pref_name', label: 'Preferred Name', defaultOn: true },
  { key: 'molecule_type', label: 'Molecule Type', defaultOn: true },
  { key: 'max_phase', label: 'Max Phase', defaultOn: true },
  { key: 'canonical_smiles', label: 'Canonical SMILES', defaultOn: true },
  { key: 'molecular_formula', label: 'Molecular Formula', defaultOn: true },
  { key: 'synonyms', label: 'Synonyms', defaultOn: false },
  { key: 'first_approval', label: 'First Approval Year', defaultOn: false },
  { key: 'therapeutic_flag', label: 'Therapeutic', defaultOn: false },
  { key: 'oral', label: 'Oral', defaultOn: false },
  { key: 'black_box_warning', label: 'Black Box Warning', defaultOn: false },
  { key: 'natural_product', label: 'Natural Product', defaultOn: false },
  { key: 'atc_classifications', label: 'ATC Classifications', defaultOn: false },
  { key: 'standard_inchi', label: 'Standard InChI', defaultOn: false },
  { key: 'standard_inchi_key', label: 'InChI Key', defaultOn: false },
  { key: 'molecular_weight', label: 'Molecular Weight', defaultOn: false },
  { key: 'alogp', label: 'AlogP', defaultOn: false },
];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function parsePubmedIdsInput(text) {
  return (text || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseClinicaltrialsIdsInput(text) {
  return parsePubmedIdsInput(text).map((s) => s.toUpperCase());
}

function parsePreprintIdsInput(text) {
  return parsePubmedIdsInput(text);
}

function parseChemblIdsInput(text) {
  return parsePubmedIdsInput(text).map((s) => s.toUpperCase());
}

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
            <p class="prompt-step-label">Step 2 of 2 — Add data</p>
            <div class="dataset-source-tabs-row">
              <div class="review-detail-view-switch dataset-source-switch" role="tablist" aria-label="Data source">
                <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" data-source="empty">Empty table</button>
                <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab review-detail-tab--active" role="tab" aria-selected="true" data-source="upload">Upload Table</button>
                <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" data-source="pdf">Upload PDF</button>
                <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" data-source="pubmed">Import from PubMed</button>
                <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" data-source="clinicaltrials">Import from ClinicalTrials.gov</button>
                <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" data-source="preprint">Import from bioRxiv / medRxiv</button>
                <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" data-source="chembl">Import from ChEMBL</button>
              </div>
            </div>
            <div class="dataset-add-step2-scroll">
              <div class="dataset-add-step2-left">
                <div class="dataset-source-panel dataset-source-panel--active" data-source-panel="upload">
                  <div class="dataset-import">
                    <h3 class="dataset-import-title">Upload a table</h3>
                    <p class="dataset-sheet-hint">Import rows from a spreadsheet file on your computer (CSV, TSV, or XLSX). Each column becomes a text column you can retype as Image afterward.</p>
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
                <div class="dataset-source-panel" data-source-panel="pdf" hidden>
                  <div class="dataset-import">
                    <h3 class="dataset-import-title">Upload PDFs</h3>
                    <p class="dataset-sheet-hint">One row per PDF, with a Filename column and a PDF column — the file itself is attached, not parsed, so it can be sent straight to models that accept PDF input.</p>
                    <div class="dataset-import-actions">
                      <input type="file" id="pdf-file-input" accept=".pdf,application/pdf" multiple hidden />
                      <button type="button" class="btn btn-secondary pdf-import-choose-btn">Choose PDFs</button>
                      <span class="dataset-filename pdf-import-filenames" aria-live="polite"></span>
                    </div>
                  </div>
                </div>
                <div class="dataset-source-panel" data-source-panel="empty" hidden>
                  <div class="dataset-import">
                    <h3 class="dataset-import-title">Create an empty dataset</h3>
                    <p class="dataset-sheet-hint">Start with a regular empty table, then add text columns, image columns and rows in the dataset editor.</p>
                  </div>
                </div>
                <div class="dataset-source-panel" data-source-panel="pubmed" hidden>
                  <div class="dataset-import">
                    <h3 class="dataset-import-title">Import from PubMed</h3>
                    <p class="dataset-sheet-hint">Look up articles by PMID and import whichever fields you pick (title, abstract, authors, ...) as columns — one row per article.</p>
                    <label class="dataset-meta-label" for="pm-ids">PMIDs (one per line, or comma/space separated)</label>
                    <textarea id="pm-ids" class="dataset-meta-input dataset-meta-textarea pubmed-import-ids" rows="6" placeholder="13252012&#10;7834742&#10;11988757"></textarea>
                    <div class="pubmed-import-fields">
                      <div class="dataset-meta-label">Columns to import</div>
                      <div class="pubmed-import-checkboxes">
                        ${PUBMED_FIELD_OPTIONS.map(
                          (f) => `
                          <label class="pubmed-import-checkbox-label">
                            <input type="checkbox" class="pm-field-checkbox" value="${f.key}" ${f.defaultOn ? 'checked' : ''} />
                            ${escapeHtml(f.label)}
                          </label>`,
                        ).join('')}
                      </div>
                    </div>
                    <div class="dataset-import-actions">
                      <button type="button" class="btn btn-secondary pubmed-import-fetch-btn">Fetch from PubMed</button>
                      <span class="dataset-filename pubmed-import-fetch-status" aria-live="polite"></span>
                    </div>
                  </div>
                </div>
                <div class="dataset-source-panel" data-source-panel="clinicaltrials" hidden>
                  <div class="dataset-import">
                    <h3 class="dataset-import-title">Import from ClinicalTrials.gov</h3>
                    <p class="dataset-sheet-hint">Look up studies by NCT ID and import whichever fields you pick (title, status, conditions, ...) as columns — one row per study.</p>
                    <label class="dataset-meta-label" for="ct-ids">NCT IDs (one per line, or comma/space separated)</label>
                    <textarea id="ct-ids" class="dataset-meta-input dataset-meta-textarea clinicaltrials-import-ids" rows="6" placeholder="NCT00001372&#10;NCT04280705"></textarea>
                    <div class="clinicaltrials-import-fields">
                      <div class="dataset-meta-label">Columns to import</div>
                      <div class="clinicaltrials-import-checkboxes">
                        ${CLINICALTRIALS_FIELD_OPTIONS.map(
                          (f) => `
                          <label class="clinicaltrials-import-checkbox-label">
                            <input type="checkbox" class="ct-field-checkbox" value="${f.key}" ${f.defaultOn ? 'checked' : ''} />
                            ${escapeHtml(f.label)}
                          </label>`,
                        ).join('')}
                      </div>
                    </div>
                    <div class="dataset-import-actions">
                      <button type="button" class="btn btn-secondary clinicaltrials-import-fetch-btn">Fetch from ClinicalTrials.gov</button>
                      <span class="dataset-filename clinicaltrials-import-fetch-status" aria-live="polite"></span>
                    </div>
                  </div>
                </div>
                <div class="dataset-source-panel" data-source-panel="preprint" hidden>
                  <div class="dataset-import">
                    <h3 class="dataset-import-title">Import from bioRxiv / medRxiv</h3>
                    <p class="dataset-sheet-hint">Look up preprints by DOI and import whichever fields you pick (title, abstract, authors, ...) as columns — one row per preprint.</p>
                    <label class="dataset-meta-label" for="pp-ids">DOIs (one per line, or comma/space separated)</label>
                    <textarea id="pp-ids" class="dataset-meta-input dataset-meta-textarea preprint-import-ids" rows="6" placeholder="10.1101/2020.09.16.300343"></textarea>
                    <div class="preprint-import-fields">
                      <div class="dataset-meta-label">Columns to import</div>
                      <div class="preprint-import-checkboxes">
                        ${PREPRINT_FIELD_OPTIONS.map(
                          (f) => `
                          <label class="preprint-import-checkbox-label">
                            <input type="checkbox" class="pp-field-checkbox" value="${f.key}" ${f.defaultOn ? 'checked' : ''} />
                            ${escapeHtml(f.label)}
                          </label>`,
                        ).join('')}
                      </div>
                    </div>
                    <div class="dataset-import-actions">
                      <button type="button" class="btn btn-secondary preprint-import-fetch-btn">Fetch from bioRxiv / medRxiv</button>
                      <span class="dataset-filename preprint-import-fetch-status" aria-live="polite"></span>
                    </div>
                  </div>
                </div>
                <div class="dataset-source-panel" data-source-panel="chembl" hidden>
                  <div class="dataset-import">
                    <h3 class="dataset-import-title">Import from ChEMBL</h3>
                    <p class="dataset-sheet-hint">Look up molecules by ChEMBL ID and import whichever fields you pick (name, structure, properties, ...) as columns — one row per molecule.</p>
                    <label class="dataset-meta-label" for="chembl-ids">ChEMBL IDs (one per line, or comma/space separated)</label>
                    <textarea id="chembl-ids" class="dataset-meta-input dataset-meta-textarea chembl-import-ids" rows="6" placeholder="CHEMBL25&#10;CHEMBL192"></textarea>
                    <div class="chembl-import-fields">
                      <div class="dataset-meta-label">Columns to import</div>
                      <div class="chembl-import-checkboxes">
                        ${CHEMBL_FIELD_OPTIONS.map(
                          (f) => `
                          <label class="chembl-import-checkbox-label">
                            <input type="checkbox" class="chembl-field-checkbox" value="${f.key}" ${f.defaultOn ? 'checked' : ''} />
                            ${escapeHtml(f.label)}
                          </label>`,
                        ).join('')}
                      </div>
                    </div>
                    <div class="dataset-import-actions">
                      <button type="button" class="btn btn-secondary chembl-import-fetch-btn">Fetch from ChEMBL</button>
                      <span class="dataset-filename chembl-import-fetch-status" aria-live="polite"></span>
                    </div>
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

  const sourcePanels = overlay.querySelectorAll('.dataset-source-panel');
  const sourceSwitchBtns = overlay.querySelectorAll('.dataset-source-switch .review-detail-tab');
  const pmIdsInput = overlay.querySelector('#pm-ids');
  const pubmedFetchBtn = overlay.querySelector('.pubmed-import-fetch-btn');
  const pubmedFetchStatusEl = overlay.querySelector('.pubmed-import-fetch-status');
  const ctIdsInput = overlay.querySelector('#ct-ids');
  const clinicaltrialsFetchBtn = overlay.querySelector('.clinicaltrials-import-fetch-btn');
  const clinicaltrialsFetchStatusEl = overlay.querySelector('.clinicaltrials-import-fetch-status');
  const ppIdsInput = overlay.querySelector('#pp-ids');
  const preprintFetchBtn = overlay.querySelector('.preprint-import-fetch-btn');
  const preprintFetchStatusEl = overlay.querySelector('.preprint-import-fetch-status');
  const chemblIdsInput = overlay.querySelector('#chembl-ids');
  const chemblFetchBtn = overlay.querySelector('.chembl-import-fetch-btn');
  const chemblFetchStatusEl = overlay.querySelector('.chembl-import-fetch-status');
  const pdfFileInput = overlay.querySelector('#pdf-file-input');
  const pdfChooseBtn = overlay.querySelector('.pdf-import-choose-btn');
  const pdfFilenamesEl = overlay.querySelector('.pdf-import-filenames');
  let dataSource = 'upload';
  let pubmedJobId = null;
  let pubmedPollTimer = null;
  let clinicaltrialsJobId = null;
  let clinicaltrialsPollTimer = null;
  let preprintJobId = null;
  let preprintPollTimer = null;
  let chemblJobId = null;
  let chemblPollTimer = null;
  /** @type {File[]} */
  let selectedPdfFiles = [];

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

  function stopPubmedPolling() {
    if (pubmedPollTimer) clearTimeout(pubmedPollTimer);
    pubmedPollTimer = null;
  }

  function setPubmedRunningUi(running) {
    pubmedFetchBtn.disabled = running;
    addBtn.disabled = running;
  }

  /** Mirrors .dataset-filename next to "Choose CSV / TSV / XLSX file": a short result, not a full status line. */
  function setPubmedFetchStatus(text) {
    if (pubmedFetchStatusEl) pubmedFetchStatusEl.textContent = text || '';
  }

  function stopClinicaltrialsPolling() {
    if (clinicaltrialsPollTimer) clearTimeout(clinicaltrialsPollTimer);
    clinicaltrialsPollTimer = null;
  }

  function setClinicaltrialsRunningUi(running) {
    clinicaltrialsFetchBtn.disabled = running;
    addBtn.disabled = running;
  }

  /** Mirrors .dataset-filename next to "Choose CSV / TSV / XLSX file": a short result, not a full status line. */
  function setClinicaltrialsFetchStatus(text) {
    if (clinicaltrialsFetchStatusEl) clinicaltrialsFetchStatusEl.textContent = text || '';
  }

  function stopPreprintPolling() {
    if (preprintPollTimer) clearTimeout(preprintPollTimer);
    preprintPollTimer = null;
  }

  function setPreprintRunningUi(running) {
    preprintFetchBtn.disabled = running;
    addBtn.disabled = running;
  }

  /** Mirrors .dataset-filename next to "Choose CSV / TSV / XLSX file": a short result, not a full status line. */
  function setPreprintFetchStatus(text) {
    if (preprintFetchStatusEl) preprintFetchStatusEl.textContent = text || '';
  }

  function stopChemblPolling() {
    if (chemblPollTimer) clearTimeout(chemblPollTimer);
    chemblPollTimer = null;
  }

  function setChemblRunningUi(running) {
    chemblFetchBtn.disabled = running;
    addBtn.disabled = running;
  }

  /** Mirrors .dataset-filename next to "Choose CSV / TSV / XLSX file": a short result, not a full status line. */
  function setChemblFetchStatus(text) {
    if (chemblFetchStatusEl) chemblFetchStatusEl.textContent = text || '';
  }

  /** Switching source panels always drops whatever was staged for submission (see comment above). */
  function resetStagedContent() {
    fileImported = false;
    parsedDatasetContent = null;
    xlsxWorkbook = null;
    previewEl.textContent = 'No file selected yet.';
    previewEl.classList.add('prompt-preview--empty');
    setPubmedFetchStatus('');
    setClinicaltrialsFetchStatus('');
    setPreprintFetchStatus('');
    setChemblFetchStatus('');
  }

  function stageEmptyDataset() {
    fileImported = true;
    parsedDatasetContent = {
      schemaVersion: 2,
      headers: ['Column 1'],
      columnTypes: ['text'],
      rowIds: [],
      rows: [],
    };
    previewEl.innerHTML = '<p class="dataset-preview-cap">Empty dataset. Add rows and text/image columns after creating it.</p>';
    previewEl.classList.remove('prompt-preview--empty');
  }

  async function switchDataSource(target) {
    if (target === dataSource) return;
    if (fileImported) {
      const ok = await showConfirm('Switching will clear the current preview data. Continue?', {
        title: 'Switch data source',
        confirmText: 'Switch',
      });
      if (!ok) return;
    }
    if (dataSource === 'pubmed') {
      stopPubmedPolling();
      if (pubmedJobId) fetch(`${API_BASE}/api/pubmed/import/cancel/${pubmedJobId}`, { method: 'POST' }).catch(() => {});
      pubmedJobId = null;
      setPubmedRunningUi(false);
    }
    if (dataSource === 'clinicaltrials') {
      stopClinicaltrialsPolling();
      if (clinicaltrialsJobId) fetch(`${API_BASE}/api/clinicaltrials/import/cancel/${clinicaltrialsJobId}`, { method: 'POST' }).catch(() => {});
      clinicaltrialsJobId = null;
      setClinicaltrialsRunningUi(false);
    }
    if (dataSource === 'preprint') {
      stopPreprintPolling();
      if (preprintJobId) fetch(`${API_BASE}/api/preprint/import/cancel/${preprintJobId}`, { method: 'POST' }).catch(() => {});
      preprintJobId = null;
      setPreprintRunningUi(false);
    }
    if (dataSource === 'chembl') {
      stopChemblPolling();
      if (chemblJobId) fetch(`${API_BASE}/api/chembl/import/cancel/${chemblJobId}`, { method: 'POST' }).catch(() => {});
      chemblJobId = null;
      setChemblRunningUi(false);
    }
    dataSource = target;
    sourceSwitchBtns.forEach((b) => {
      const on = b.dataset.source === target;
      b.classList.toggle('review-detail-tab--active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    sourcePanels.forEach((p) => {
      const on = p.dataset.sourcePanel === target;
      p.classList.toggle('dataset-source-panel--active', on);
      p.hidden = !on;
    });
    hideError();
    resetStagedContent();
    if (target === 'empty') {
      stageEmptyDataset();
    }
  }

  sourceSwitchBtns.forEach((btn) => {
    btn.addEventListener('click', () => switchDataSource(btn.dataset.source));
  });

  async function pollPubmedJob(jobId) {
    try {
      const res = await fetch(`${API_BASE}/api/pubmed/import/result/${jobId}`);
      const data = await res.json().catch(() => ({}));
      if (data.status === 'running') {
        setPubmedFetchStatus(`Fetching… ${data.completed ?? 0}/${data.total ?? '?'}`);
        pubmedPollTimer = setTimeout(() => pollPubmedJob(jobId), PUBMED_POLL_INTERVAL_MS);
        return;
      }
      setPubmedRunningUi(false);
      pubmedJobId = null;
      if (data.error) {
        showError(`PubMed import failed: ${data.error}`);
        setPubmedFetchStatus('');
        return;
      }
      const headers = data.headers || [];
      const rows = data.rows || [];
      const notFound = data.not_found || [];
      const total = data.total ?? rows.length;
      if (rows.length === 0) {
        setPubmedFetchStatus(data.status === 'cancelled' ? 'Cancelled.' : `0/${total} PMID${total === 1 ? '' : 's'} fetched`);
        if (data.status !== 'cancelled' && notFound.length > 0) {
          showError(`None of the ${notFound.length} PMID${notFound.length === 1 ? '' : 's'} were found on PubMed.`);
        }
        return;
      }
      fileImported = true;
      parsedDatasetContent = { headers, rows };
      const previewRows = rows.slice(0, MAX_PREVIEW_ROWS);
      renderPreviewTable(headers, previewRows, rows.length);
      setPubmedFetchStatus(`${rows.length}/${total} PMID${total === 1 ? '' : 's'} fetched${data.status === 'cancelled' ? ' (cancelled early)' : ''}`);
      if (notFound.length > 0) {
        showError(`${notFound.length} PMID${notFound.length === 1 ? '' : 's'} not found on PubMed and skipped: ${notFound.join(', ')}`);
      }
    } catch (e) {
      setPubmedRunningUi(false);
      pubmedJobId = null;
      showError(`Could not reach backend: ${(e && e.message) || e}`);
      setPubmedFetchStatus('');
    }
  }

  pubmedFetchBtn.addEventListener('click', async () => {
    hideError();
    const fields = Array.from(overlay.querySelectorAll('.pm-field-checkbox:checked')).map((el) => el.value);
    if (fields.length === 0) {
      showError('Pick at least one column to import from PubMed.');
      return;
    }
    const ids = parsePubmedIdsInput(pmIdsInput.value);
    if (ids.length === 0) {
      showError('Paste at least one PMID.');
      return;
    }
    const body = { fields, ids };

    setPubmedRunningUi(true);
    setPubmedFetchStatus('Starting…');
    try {
      const res = await fetch(`${API_BASE}/api/pubmed/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPubmedRunningUi(false);
        showError(`Could not start import: ${typeof data.detail === 'string' ? data.detail : 'unknown error'}`);
        setPubmedFetchStatus('');
        return;
      }
      pubmedJobId = data.job_id;
      pollPubmedJob(pubmedJobId);
    } catch (e) {
      setPubmedRunningUi(false);
      showError(`Could not reach backend: ${(e && e.message) || e}`);
      setPubmedFetchStatus('');
    }
  });

  async function pollClinicaltrialsJob(jobId) {
    try {
      const res = await fetch(`${API_BASE}/api/clinicaltrials/import/result/${jobId}`);
      const data = await res.json().catch(() => ({}));
      if (data.status === 'running') {
        setClinicaltrialsFetchStatus(`Fetching… ${data.completed ?? 0}/${data.total ?? '?'}`);
        clinicaltrialsPollTimer = setTimeout(() => pollClinicaltrialsJob(jobId), CLINICALTRIALS_POLL_INTERVAL_MS);
        return;
      }
      setClinicaltrialsRunningUi(false);
      clinicaltrialsJobId = null;
      if (data.error) {
        showError(`ClinicalTrials.gov import failed: ${data.error}`);
        setClinicaltrialsFetchStatus('');
        return;
      }
      const headers = data.headers || [];
      const rows = data.rows || [];
      const notFound = data.not_found || [];
      const total = data.total ?? rows.length;
      if (rows.length === 0) {
        setClinicaltrialsFetchStatus(data.status === 'cancelled' ? 'Cancelled.' : `0/${total} NCT ID${total === 1 ? '' : 's'} fetched`);
        if (data.status !== 'cancelled' && notFound.length > 0) {
          showError(`None of the ${notFound.length} NCT ID${notFound.length === 1 ? '' : 's'} were found on ClinicalTrials.gov.`);
        }
        return;
      }
      fileImported = true;
      parsedDatasetContent = { headers, rows };
      const previewRows = rows.slice(0, MAX_PREVIEW_ROWS);
      renderPreviewTable(headers, previewRows, rows.length);
      setClinicaltrialsFetchStatus(`${rows.length}/${total} stud${total === 1 ? 'y' : 'ies'} fetched${data.status === 'cancelled' ? ' (cancelled early)' : ''}`);
      if (notFound.length > 0) {
        showError(`${notFound.length} NCT ID${notFound.length === 1 ? '' : 's'} not found on ClinicalTrials.gov and skipped: ${notFound.join(', ')}`);
      }
    } catch (e) {
      setClinicaltrialsRunningUi(false);
      clinicaltrialsJobId = null;
      showError(`Could not reach backend: ${(e && e.message) || e}`);
      setClinicaltrialsFetchStatus('');
    }
  }

  clinicaltrialsFetchBtn.addEventListener('click', async () => {
    hideError();
    const fields = Array.from(overlay.querySelectorAll('.ct-field-checkbox:checked')).map((el) => el.value);
    if (fields.length === 0) {
      showError('Pick at least one column to import from ClinicalTrials.gov.');
      return;
    }
    const ids = parseClinicaltrialsIdsInput(ctIdsInput.value);
    if (ids.length === 0) {
      showError('Paste at least one NCT ID.');
      return;
    }
    const body = { fields, ids };

    setClinicaltrialsRunningUi(true);
    setClinicaltrialsFetchStatus('Starting…');
    try {
      const res = await fetch(`${API_BASE}/api/clinicaltrials/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setClinicaltrialsRunningUi(false);
        showError(`Could not start import: ${typeof data.detail === 'string' ? data.detail : 'unknown error'}`);
        setClinicaltrialsFetchStatus('');
        return;
      }
      clinicaltrialsJobId = data.job_id;
      pollClinicaltrialsJob(clinicaltrialsJobId);
    } catch (e) {
      setClinicaltrialsRunningUi(false);
      showError(`Could not reach backend: ${(e && e.message) || e}`);
      setClinicaltrialsFetchStatus('');
    }
  });

  async function pollPreprintJob(jobId) {
    try {
      const res = await fetch(`${API_BASE}/api/preprint/import/result/${jobId}`);
      const data = await res.json().catch(() => ({}));
      if (data.status === 'running') {
        setPreprintFetchStatus(`Fetching… ${data.completed ?? 0}/${data.total ?? '?'}`);
        preprintPollTimer = setTimeout(() => pollPreprintJob(jobId), PREPRINT_POLL_INTERVAL_MS);
        return;
      }
      setPreprintRunningUi(false);
      preprintJobId = null;
      if (data.error) {
        showError(`bioRxiv/medRxiv import failed: ${data.error}`);
        setPreprintFetchStatus('');
        return;
      }
      const headers = data.headers || [];
      const rows = data.rows || [];
      const notFound = data.not_found || [];
      const total = data.total ?? rows.length;
      if (rows.length === 0) {
        setPreprintFetchStatus(data.status === 'cancelled' ? 'Cancelled.' : `0/${total} DOI${total === 1 ? '' : 's'} fetched`);
        if (data.status !== 'cancelled' && notFound.length > 0) {
          showError(`None of the ${notFound.length} DOI${notFound.length === 1 ? '' : 's'} were found on bioRxiv or medRxiv.`);
        }
        return;
      }
      fileImported = true;
      parsedDatasetContent = { headers, rows };
      const previewRows = rows.slice(0, MAX_PREVIEW_ROWS);
      renderPreviewTable(headers, previewRows, rows.length);
      setPreprintFetchStatus(`${rows.length}/${total} preprint${total === 1 ? '' : 's'} fetched${data.status === 'cancelled' ? ' (cancelled early)' : ''}`);
      if (notFound.length > 0) {
        showError(`${notFound.length} DOI${notFound.length === 1 ? '' : 's'} not found on bioRxiv or medRxiv and skipped: ${notFound.join(', ')}`);
      }
    } catch (e) {
      setPreprintRunningUi(false);
      preprintJobId = null;
      showError(`Could not reach backend: ${(e && e.message) || e}`);
      setPreprintFetchStatus('');
    }
  }

  preprintFetchBtn.addEventListener('click', async () => {
    hideError();
    const fields = Array.from(overlay.querySelectorAll('.pp-field-checkbox:checked')).map((el) => el.value);
    if (fields.length === 0) {
      showError('Pick at least one column to import from bioRxiv / medRxiv.');
      return;
    }
    const ids = parsePreprintIdsInput(ppIdsInput.value);
    if (ids.length === 0) {
      showError('Paste at least one DOI.');
      return;
    }
    const body = { fields, ids };

    setPreprintRunningUi(true);
    setPreprintFetchStatus('Starting…');
    try {
      const res = await fetch(`${API_BASE}/api/preprint/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPreprintRunningUi(false);
        showError(`Could not start import: ${typeof data.detail === 'string' ? data.detail : 'unknown error'}`);
        setPreprintFetchStatus('');
        return;
      }
      preprintJobId = data.job_id;
      pollPreprintJob(preprintJobId);
    } catch (e) {
      setPreprintRunningUi(false);
      showError(`Could not reach backend: ${(e && e.message) || e}`);
      setPreprintFetchStatus('');
    }
  });

  async function pollChemblJob(jobId) {
    try {
      const res = await fetch(`${API_BASE}/api/chembl/import/result/${jobId}`);
      const data = await res.json().catch(() => ({}));
      if (data.status === 'running') {
        setChemblFetchStatus(`Fetching… ${data.completed ?? 0}/${data.total ?? '?'}`);
        chemblPollTimer = setTimeout(() => pollChemblJob(jobId), CHEMBL_POLL_INTERVAL_MS);
        return;
      }
      setChemblRunningUi(false);
      chemblJobId = null;
      if (data.error) {
        showError(`ChEMBL import failed: ${data.error}`);
        setChemblFetchStatus('');
        return;
      }
      const headers = data.headers || [];
      const rows = data.rows || [];
      const notFound = data.not_found || [];
      const total = data.total ?? rows.length;
      if (rows.length === 0) {
        setChemblFetchStatus(data.status === 'cancelled' ? 'Cancelled.' : `0/${total} ChEMBL ID${total === 1 ? '' : 's'} fetched`);
        if (data.status !== 'cancelled' && notFound.length > 0) {
          showError(`None of the ${notFound.length} ChEMBL ID${notFound.length === 1 ? '' : 's'} were found on ChEMBL.`);
        }
        return;
      }
      fileImported = true;
      parsedDatasetContent = { headers, rows };
      const previewRows = rows.slice(0, MAX_PREVIEW_ROWS);
      renderPreviewTable(headers, previewRows, rows.length);
      setChemblFetchStatus(`${rows.length}/${total} molecule${total === 1 ? '' : 's'} fetched${data.status === 'cancelled' ? ' (cancelled early)' : ''}`);
      if (notFound.length > 0) {
        showError(`${notFound.length} ChEMBL ID${notFound.length === 1 ? '' : 's'} not found on ChEMBL and skipped: ${notFound.join(', ')}`);
      }
    } catch (e) {
      setChemblRunningUi(false);
      chemblJobId = null;
      showError(`Could not reach backend: ${(e && e.message) || e}`);
      setChemblFetchStatus('');
    }
  }

  chemblFetchBtn.addEventListener('click', async () => {
    hideError();
    const fields = Array.from(overlay.querySelectorAll('.chembl-field-checkbox:checked')).map((el) => el.value);
    if (fields.length === 0) {
      showError('Pick at least one column to import from ChEMBL.');
      return;
    }
    const ids = parseChemblIdsInput(chemblIdsInput.value);
    if (ids.length === 0) {
      showError('Paste at least one ChEMBL ID.');
      return;
    }
    const body = { fields, ids };

    setChemblRunningUi(true);
    setChemblFetchStatus('Starting…');
    try {
      const res = await fetch(`${API_BASE}/api/chembl/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setChemblRunningUi(false);
        showError(`Could not start import: ${typeof data.detail === 'string' ? data.detail : 'unknown error'}`);
        setChemblFetchStatus('');
        return;
      }
      chemblJobId = data.job_id;
      pollChemblJob(chemblJobId);
    } catch (e) {
      setChemblRunningUi(false);
      showError(`Could not reach backend: ${(e && e.message) || e}`);
      setChemblFetchStatus('');
    }
  });

  function setPdfRunningUi(running) {
    pdfChooseBtn.disabled = running;
    addBtn.disabled = running;
  }

  /** Registers each picked PDF as a project asset (not parsed) and builds a Filename + PDF
   * column dataset from them, one row per file — mirrors datasetDetailModal.js's PDF-column
   * import branching. */
  async function importPdfFiles(files) {
    hideError();
    if (files.length === 0) {
      showError('Choose at least one PDF file.');
      return;
    }
    const hasElectron = !!window.electronAPI;
    if (!hasElectron && !getCurrentProjectId()) {
      showError('Open a project first.');
      return;
    }
    setPdfRunningUi(true);
    try {
      const registered = hasElectron
        ? await window.electronAPI.importPdfs(files.map((f) => window.electronAPI.getPathForFile(f)))
        : await webImageApi.importPdfs(getCurrentProjectId(), files);
      const headers = ['Filename', 'PDF'];
      const columnTypes = ['text', 'pdf'];
      const rows = registered.map((asset) => [asset.name, pdfCell([asset.id], [asset.name])]);
      fileImported = true;
      parsedDatasetContent = { headers, rows, columnTypes };
      renderPreviewTable(headers, rows.slice(0, MAX_PREVIEW_ROWS), rows.length);
    } catch (e) {
      showError(`Could not upload PDFs: ${(e && e.message) || e}`);
    } finally {
      setPdfRunningUi(false);
    }
  }

  pdfChooseBtn.addEventListener('click', () => pdfFileInput.click());
  pdfFileInput.addEventListener('change', () => {
    selectedPdfFiles = Array.from(pdfFileInput.files || []);
    pdfFilenamesEl.textContent = selectedPdfFiles.length === 0
      ? ''
      : selectedPdfFiles.length === 1
        ? selectedPdfFiles[0].name
        : `${selectedPdfFiles.length} files selected`;
    if (selectedPdfFiles.length > 0) importPdfFiles(selectedPdfFiles);
  });

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
    if (!fileImported || (!parsedDatasetContent?.rows?.length && dataSource !== 'empty')) {
      showError(dataSource === 'pubmed'
        ? 'Fetch at least one article from PubMed first.'
        : dataSource === 'clinicaltrials'
          ? 'Fetch at least one study from ClinicalTrials.gov first.'
          : dataSource === 'preprint'
            ? 'Fetch at least one preprint from bioRxiv / medRxiv first.'
            : dataSource === 'chembl'
              ? 'Fetch at least one molecule from ChEMBL first.'
              : dataSource === 'pdf'
                ? 'Choose at least one PDF file first.'
                : dataSource === 'empty'
                  ? 'Empty dataset is not ready yet.'
                  : 'Choose a file to import first.');
      return;
    }
    const headers = parsedDatasetContent.headers;
    const rows = parsedDatasetContent.rows;
    document.dispatchEvent(
      new CustomEvent('workflow:add-dataset-node', {
        detail: {
          name,
          notes,
          headers,
          rows,
          columnTypes: parsedDatasetContent.columnTypes,
          rowIds: parsedDatasetContent.rowIds,
        },
      })
    );
    close();
  });

  const close = () => {
    stopPubmedPolling();
    if (pubmedJobId) fetch(`${API_BASE}/api/pubmed/import/cancel/${pubmedJobId}`, { method: 'POST' }).catch(() => {});
    stopClinicaltrialsPolling();
    if (clinicaltrialsJobId) fetch(`${API_BASE}/api/clinicaltrials/import/cancel/${clinicaltrialsJobId}`, { method: 'POST' }).catch(() => {});
    stopPreprintPolling();
    if (preprintJobId) fetch(`${API_BASE}/api/preprint/import/cancel/${preprintJobId}`, { method: 'POST' }).catch(() => {});
    stopChemblPolling();
    if (chemblJobId) fetch(`${API_BASE}/api/chembl/import/cancel/${chemblJobId}`, { method: 'POST' }).catch(() => {});
    overlay.remove();
    document.body.style.overflow = '';
  };
  overlay.querySelector('.modal-close').addEventListener('click', close);

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
