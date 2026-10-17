import { mountModalDialog as mountPromptDialog } from './modalDialog.js';
import { iconPlus, iconTrash, iconX } from './icons.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

export const PROMPT_OUTPUT_TYPES = [
  { value: 'str', label: 'String' },
  { value: 'float', label: 'Number' },
  { value: 'list_str', label: 'List of string' },
  { value: 'list_float', label: 'List of number' },
];

export function validatePromptSchema(fields) {
  if (!fields.length) return 'At least one output field is required.';
  if (fields.some((field) => !String(field.key || '').trim())) return 'Field name is required for all fields.';
  if (fields.some((field) => !String(field.description || '').trim())) return 'Field description is required for all fields.';
  const names = fields.map((field) => field.key.trim().toLowerCase());
  if (new Set(names).size !== names.length) return 'Field names must be unique within this prompt.';
  return '';
}

/** Shared by the creation wizard and the existing Prompt's schema window. */
export function mountPromptSchemaSettings(container, { fields, returnShape = 'table', onChange }) {
  container.classList.add('prompt-schema-settings');
  container.innerHTML = `
    <p class="prompt-hint">Define the fields in each output row. Choose whether each input row produces one output row or multiple output rows.</p>
    <div class="prompt-output-return-shape-wrap">
      <span class="prompt-output-return-shape-label">For each input row</span>
      <div class="review-detail-view-switch prompt-output-row-switch" role="group" aria-label="Output rows per input row">
        <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab prompt-output-row-btn" data-return-shape="single">One output row</button>
        <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab prompt-output-row-btn" data-return-shape="table">Multiple output rows</button>
      </div>
    </div>
    <div class="prompt-output-format-wrap"><div class="prompt-output-keys-list"></div>
      <div class="prompt-add-field-wrap"><button type="button" class="btn btn-secondary prompt-output-add-key">+ Add a field</button></div></div>`;
  const list = container.querySelector('.prompt-output-keys-list');
  let fieldDialog = null;
  function notify() { onChange?.({ fields, returnShape }); }
  function edit(fieldIndex = null) {
    if (fieldDialog) return;
    fieldDialog = openPromptFieldEditor({
      fields, fieldIndex, outputTypes: PROMPT_OUTPUT_TYPES,
      onDone() { render(); notify(); },
      onClose() { fieldDialog = null; },
    });
  }
  function render() {
    renderPromptFieldCards({ fields, container: list, outputTypes: PROMPT_OUTPUT_TYPES,
      onChange() { render(); notify(); }, onEdit: edit });
    container.querySelectorAll('.prompt-output-row-btn').forEach((button) => {
      const active = button.dataset.returnShape === returnShape;
      button.classList.toggle('review-detail-tab--active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }
  container.querySelectorAll('.prompt-output-row-btn').forEach((button) => {
    button.addEventListener('click', () => { returnShape = button.dataset.returnShape; render(); notify(); });
  });
  container.querySelector('.prompt-output-add-key').addEventListener('click', () => edit());
  render();
  return { dispose() { fieldDialog?.close(); } };
}

export function openPromptSchemaEditor({ fields, returnShape, renderPreview, onChange, onClose }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay--prompt-schema';
  overlay.setAttribute('aria-labelledby', 'prompt-schema-editor-title');
  overlay.innerHTML = `<div class="modal-panel modal-panel--prompt-schema">
    <div class="modal-header"><h2 class="modal-title" id="prompt-schema-editor-title">Edit output schema</h2>
      <button type="button" class="modal-close" aria-label="Close">&times;</button></div>
    <div class="modal-body prompt-schema-editor-body">
      <div class="prompt-schema-editor-settings"><h3 class="prompt-schema-preview-title">Output settings</h3><div class="prompt-schema-settings"></div>
        <div class="prompt-form-error prompt-modal-error" role="alert" hidden></div></div>
      <div class="prompt-schema-preview-wrap"><h3 class="prompt-schema-preview-title">Output schema</h3>
        <div class="prompt-schema-editor-content score-detail-preview-content">
        <div class="prompt-schema-editor-results run-detail-results-card">
        <div class="prompt-schema-editor-preview"></div>
        <div class="modal-footer-actions prompt-schema-footer"><button type="button" class="btn btn-primary prompt-schema-done">Done</button></div>
        </div></div></div>
    </div>
  </div>`;
  const error = overlay.querySelector('.prompt-modal-error');
  const preview = overlay.querySelector('.prompt-schema-editor-preview');
  let currentFields = structuredClone(fields);
  let currentShape = returnShape;
  const settings = mountPromptSchemaSettings(overlay.querySelector('.prompt-schema-settings'), {
    fields: currentFields, returnShape: currentShape,
    onChange(value) {
      currentFields = value.fields;
      currentShape = value.returnShape;
      updatePreview();
      const message = validatePromptSchema(currentFields);
      error.textContent = message;
      error.hidden = !message;
      if (!message) onChange?.({ fields: structuredClone(currentFields), returnShape: currentShape });
    },
  });
  function updatePreview() {
    preview.innerHTML = renderPreview(currentFields, currentShape);
    preview.querySelectorAll('[data-fulltext]').forEach((cell) => { cell.title = cell.dataset.fulltext; });
  }
  updatePreview();
  const close = mountPromptDialog(overlay, () => { settings.dispose(); onClose?.(); });
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.querySelector('.prompt-schema-done').addEventListener('click', () => {
    const message = validatePromptSchema(currentFields);
    if (message) { error.textContent = message; error.hidden = false; return; }
    close();
  });
  overlay.querySelector('.prompt-output-row-btn')?.focus();
  return { close };
}

function renderFieldEditorScalarRow(typeVal, value, rowIdx) {
  const isFloat = typeVal === 'float';
  const hasValue = value != null && String(value) !== '';
  const v = hasValue ? String(value) : '';
  const valAttr = isFloat ? ` value="${escapeHtml(String(v))}"` : '';
  const inp = isFloat
    ? `<input type="number" step="any" class="dataset-meta-input field-editor-scalar-inp" data-row-index="${rowIdx}"${valAttr} aria-label="Example" />`
    : `<textarea class="dataset-meta-input dataset-meta-textarea field-editor-scalar-inp" rows="1" data-row-index="${rowIdx}" aria-label="Example">${escapeHtml(String(v))}</textarea>`;
  return `<div class="field-editor-scalar-row field-editor-input-box" data-row-index="${rowIdx}"><div class="field-editor-scalar-input-wrap">${inp}</div>${renderFieldEditorIconButton('field-editor-scalar-del', 'Delete example', iconX(14))}</div>`;
}

function renderFieldEditorIconButton(className, label, icon) {
  return `<button type="button" class="field-editor-icon-btn ${className}" aria-label="${label}" title="${label}">${icon.outerHTML}</button>`;
}

function renderFieldEditorAddButton(className, label, block = false) {
  return `<button type="button" class="field-editor-add-btn${block ? ' field-editor-add-btn--block' : ''} ${className}">${iconPlus(14).outerHTML}<span>${label}</span></button>`;
}

function renderFieldEditorElementRow(isListStr, val, elIdx) {
  const hasValue = val != null && String(val) !== '';
  const v = escapeHtml(hasValue ? String(val) : '');
  const inp = isListStr
    ? `<textarea class="dataset-meta-input dataset-meta-textarea field-editor-element-inp" rows="1" data-el-index="${elIdx}">${v}</textarea>`
    : `<input type="number" step="any" class="dataset-meta-input field-editor-element-inp" value="${v}" data-el-index="${elIdx}" />`;
  return `<div class="field-editor-element-row field-editor-input-box"><div class="field-editor-element-input-wrap">${inp}</div>${renderFieldEditorIconButton('field-editor-del-element', 'Delete element', iconX(14))}</div>`;
}

function renderFieldEditorListRow(typeVal, elements, exIdx) {
  const elList = Array.isArray(elements) && elements.length > 0 ? elements : [''];
  const isListStr = typeVal === 'list_str';
  const rowsHtml = elList.map((el, i) => renderFieldEditorElementRow(isListStr, el, i)).join('');
  return `<div class="field-editor-list-example-block" data-ex-index="${exIdx}">`
    + `<div class="field-editor-list-example-head"><span class="field-editor-list-example-title">Example ${exIdx + 1}</span>${renderFieldEditorIconButton('field-editor-del-example', 'Delete list example', iconTrash(15))}</div>`
    + `<div class="field-editor-element-rows">${rowsHtml}</div>`
    + renderFieldEditorAddButton('field-editor-add-element', 'Add element')
    + '</div>';
}

/** Fit example text, including wrapped lines, padding and both borders. */
function autoSizeExampleTextareas(overlay) {
  const examples = overlay.querySelector('.field-editor-examples-wrap');
  let frame = null;
  let previousWidth = 0;
  function resize() {
    frame = null;
    examples.querySelectorAll('textarea').forEach((textarea) => {
      if (!textarea.getClientRects().length) return;
      const style = getComputedStyle(textarea);
      textarea.style.height = 'auto';
      const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      textarea.style.height = `${Math.ceil(textarea.scrollHeight + borders)}px`;
      // Growing the dialog can reveal its scrollbar and wrap the text onto another line.
      if (textarea.scrollHeight > textarea.clientHeight) {
        textarea.style.height = `${Math.ceil(textarea.scrollHeight + borders)}px`;
      }
    });
  }
  function schedule() {
    if (frame === null) frame = requestAnimationFrame(resize);
  }
  const widthObserver = new ResizeObserver(([entry]) => {
    if (entry.contentRect.width === previousWidth) return;
    previousWidth = entry.contentRect.width;
    schedule();
  });
  const rowsObserver = new MutationObserver(schedule);
  widthObserver.observe(examples);
  rowsObserver.observe(examples, { childList: true, subtree: true });
  examples.addEventListener('input', schedule);
  schedule();
  return () => {
    widthObserver.disconnect();
    rowsObserver.disconnect();
    examples.removeEventListener('input', schedule);
    if (frame !== null) cancelAnimationFrame(frame);
  };
}

export function openPromptFieldEditor({ fields, fieldIndex = null, outputTypes = PROMPT_OUTPUT_TYPES, onDone, onClose }) {
  const isEdit = fieldIndex !== null && fieldIndex >= 0;
  const field = isEdit ? fields[fieldIndex] : { key: '', type: 'str', description: '', examples: [], allowNone: false };
  const type = field.type || 'str';
  const isListType = type === 'list_str' || type === 'list_float';
  const typeOptions = outputTypes.map((t) => `<option value="${t.value}" ${t.value === type ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('');
  const editorOverlay = document.createElement('div');
  editorOverlay.className = 'modal-overlay modal-overlay--section-editor modal-overlay--field-editor';
  editorOverlay.setAttribute('aria-labelledby', 'prompt-field-editor-title');
  editorOverlay.innerHTML = `
    <div class="modal-panel modal-panel--section-editor modal-panel--field-editor">
      <div class="modal-header">
        <h3 class="modal-title" id="prompt-field-editor-title">${isEdit ? 'Edit field' : 'Add field'}</h3>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="dataset-meta-wrap">
          <div class="dataset-meta-field">
            <label class="dataset-meta-label" for="field-editor-key">Field name</label>
            <input type="text" id="field-editor-key" class="dataset-meta-input" value="${escapeHtml(field.key || '')}" aria-label="Field name" />
          </div>
          <div class="dataset-meta-field">
            <label class="dataset-meta-label" for="field-editor-type">Type</label>
            <select id="field-editor-type" class="dataset-meta-input" aria-label="Type">${typeOptions}</select>
          </div>
          <div class="dataset-meta-field">
            <label class="dataset-meta-label" for="field-editor-desc">Description</label>
            <textarea id="field-editor-desc" class="dataset-meta-input dataset-meta-textarea" rows="4" aria-label="Field description">${escapeHtml(field.description ?? '')}</textarea>
          </div>
          <div class="dataset-meta-field">
            <label class="dataset-meta-label"><input type="checkbox" id="field-editor-allow-none" ${field.allowNone ? 'checked' : ''} aria-label="Allow None" /> Allow None</label>
          </div>
          <div class="dataset-meta-field field-editor-examples-wrap">
            <label class="dataset-meta-label">Examples</label>
            <div id="field-editor-examples-scalar" class="field-editor-examples-scalar" style="${isListType ? 'display:none' : ''}">
              <div class="field-editor-scalar-rows"></div>
              ${renderFieldEditorAddButton('field-editor-add-scalar-row', 'Add example', true)}
            </div>
            <div id="field-editor-examples-list" class="field-editor-examples-list prompt-output-examples-wrap" style="${isListType ? '' : 'display:none'}">
              <div class="prompt-output-examples-list field-editor-list-rows"></div>
              ${renderFieldEditorAddButton('field-editor-add-list-row', 'Add list example', true)}
            </div>
          </div>
        </div>
        <div class="prompt-form-error section-editor-error field-editor-error" role="alert" aria-live="polite" hidden></div>
        <div class="modal-footer-actions">
          <button type="button" class="btn btn-primary section-editor-save">${isEdit ? 'Save' : 'Add field'}</button>
        </div>
      </div>
    </div>
  `;
  const keyInput = editorOverlay.querySelector('#field-editor-key');
  const typeSelect = editorOverlay.querySelector('#field-editor-type');
  const descInput = editorOverlay.querySelector('#field-editor-desc');
  const allowNoneInput = editorOverlay.querySelector('#field-editor-allow-none');
  const examplesScalarWrap = editorOverlay.querySelector('#field-editor-examples-scalar');
  const examplesListWrap = editorOverlay.querySelector('#field-editor-examples-list');
  const scalarRowsContainer = editorOverlay.querySelector('.field-editor-scalar-rows');
  const addScalarRowBtn = editorOverlay.querySelector('.field-editor-add-scalar-row');
  const listRowsContainer = editorOverlay.querySelector('.field-editor-list-rows');
  const addListRowBtn = editorOverlay.querySelector('.field-editor-add-list-row');
  const errorEl = editorOverlay.querySelector('.field-editor-error');

  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  function clearError() {
    if (!errorEl) return;
    errorEl.textContent = '';
    errorEl.hidden = true;
  }

  function getCurrentType() {
    return (typeSelect?.value ?? 'str') || 'str';
  }

  function readScalarExamplesFromDOM() {
    const typeVal = getCurrentType();
    const isFloat = typeVal === 'float';
    const rows = scalarRowsContainer.querySelectorAll('.field-editor-scalar-row');
    return Array.from(rows).map((row) => {
      const inp = row.querySelector('.field-editor-scalar-inp');
      const raw = (inp?.value ?? '').trim();
      return isFloat ? (raw === '' ? null : Number(raw)) : raw;
    }).filter((v) => v !== null && v !== '');
  }

  function buildScalarExamplesUI(typeVal, examples) {
    const list = Array.isArray(examples) && examples.length > 0 ? examples : [''];
    scalarRowsContainer.innerHTML = list.map((val, i) => renderFieldEditorScalarRow(typeVal, val, i)).join('');
    syncExampleRows();
  }

  /** Renumbers rows and lists; the last example, list or element keeps a disabled remove button. */
  function syncExampleRows() {
    const scalarRows = scalarRowsContainer.querySelectorAll('.field-editor-scalar-row');
    scalarRows.forEach((row, i) => {
      row.setAttribute('data-row-index', String(i));
      row.querySelector('.field-editor-scalar-inp')?.setAttribute('data-row-index', String(i));
      row.querySelector('.field-editor-scalar-del').disabled = scalarRows.length < 2;
    });
    const blocks = listRowsContainer.querySelectorAll('.field-editor-list-example-block');
    blocks.forEach((block, i) => {
      block.setAttribute('data-ex-index', String(i));
      block.querySelector('.field-editor-list-example-title').textContent = `Example ${i + 1}`;
      block.querySelector('.field-editor-del-example').disabled = blocks.length < 2;
      const elementDels = block.querySelectorAll('.field-editor-del-element');
      elementDels.forEach((btn) => { btn.disabled = elementDels.length < 2; });
    });
  }

  /** Focus moves to the input that takes the removed row's place, so keyboard users keep their spot. */
  function removeExampleRow(row, inputSelector) {
    const next = row.nextElementSibling ?? row.previousElementSibling;
    row.remove();
    syncExampleRows();
    next?.querySelector(inputSelector)?.focus();
  }

  scalarRowsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.field-editor-scalar-del');
    if (btn && !btn.disabled) removeExampleRow(btn.closest('.field-editor-scalar-row'), '.field-editor-scalar-inp');
  });

  function readListExamplesFromDOM() {
    const blocks = listRowsContainer.querySelectorAll('.field-editor-list-example-block');
    return Array.from(blocks).map((block) =>
      Array.from(block.querySelectorAll('.field-editor-element-inp')).map((inp) => (inp?.value ?? '').trim())
    );
  }

  function buildListExamplesUI(typeVal, examples) {
    const list = Array.isArray(examples) && examples.length > 0 ? examples : [[]];
    listRowsContainer.innerHTML = list.map((arr, exIdx) => renderFieldEditorListRow(typeVal, arr, exIdx)).join('');
    syncExampleRows();
  }

  listRowsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    if (btn.classList.contains('field-editor-del-element')) {
      removeExampleRow(btn.closest('.field-editor-element-row'), '.field-editor-element-inp');
    } else if (btn.classList.contains('field-editor-del-example')) {
      removeExampleRow(btn.closest('.field-editor-list-example-block'), '.field-editor-element-inp');
    } else if (btn.classList.contains('field-editor-add-element')) {
      const rows = btn.closest('.field-editor-list-example-block').querySelector('.field-editor-element-rows');
      const elIdx = rows.querySelectorAll('.field-editor-element-row').length;
      rows.insertAdjacentHTML('beforeend', renderFieldEditorElementRow(getCurrentType() === 'list_str', '', elIdx));
      syncExampleRows();
      rows.lastElementChild.querySelector('.field-editor-element-inp').focus();
    }
  });

  if (isListType) buildListExamplesUI(type, field.examples || []);
  else buildScalarExamplesUI(type, field.examples || []);

  addScalarRowBtn?.addEventListener('click', () => {
    const nextIdx = scalarRowsContainer.querySelectorAll('.field-editor-scalar-row').length;
    scalarRowsContainer.insertAdjacentHTML('beforeend', renderFieldEditorScalarRow(getCurrentType(), '', nextIdx));
    syncExampleRows();
    scalarRowsContainer.lastElementChild.querySelector('.field-editor-scalar-inp').focus();
  });

  addListRowBtn?.addEventListener('click', () => {
    const nextIdx = listRowsContainer.querySelectorAll('.field-editor-list-example-block').length;
    listRowsContainer.insertAdjacentHTML('beforeend', renderFieldEditorListRow(getCurrentType(), [], nextIdx));
    syncExampleRows();
    listRowsContainer.lastElementChild.querySelector('.field-editor-element-inp').focus();
  });

  typeSelect?.addEventListener('change', () => {
    const typeVal = getCurrentType();
    const nowList = typeVal === 'list_str' || typeVal === 'list_float';
    if (nowList) {
      const prevList = examplesListWrap.style.display !== 'none';
      let examples;
      if (prevList) examples = readListExamplesFromDOM();
      else {
        const scalar = readScalarExamplesFromDOM();
        examples = scalar.map((v) => (Array.isArray(v) ? v : [v]));
      }
      examplesScalarWrap.style.display = 'none';
      examplesListWrap.style.display = '';
      buildListExamplesUI(typeVal, examples);
    } else {
      const prevList = examplesListWrap.style.display !== 'none';
      let scalarExamples;
      if (prevList) {
        const listEx = readListExamplesFromDOM();
        if (typeVal === 'float') {
          scalarExamples = listEx.map((arr) => (Array.isArray(arr) && arr.length ? arr[0] : null)).filter((x) => x != null);
        } else {
          scalarExamples = listEx.map((arr) => (Array.isArray(arr) ? arr.join(', ') : String(arr ?? '')));
        }
      } else {
        scalarExamples = readScalarExamplesFromDOM();
      }
      examplesListWrap.style.display = 'none';
      examplesScalarWrap.style.display = '';
      buildScalarExamplesUI(typeVal, scalarExamples.length ? scalarExamples : []);
    }
    clearError();
  });

  function buildPayload() {
    const key = (keyInput?.value ?? '').trim();
    const typeVal = getCurrentType();
    const description = (descInput?.value ?? '').trim();
    const allowNone = !!(allowNoneInput && allowNoneInput.checked);
    const isList = typeVal === 'list_str' || typeVal === 'list_float';
    const examples = isList ? readListExamplesFromDOM() : readScalarExamplesFromDOM();
    return { key, type: typeVal, description, examples, allowNone };
  }

  function save() {
    const payload = buildPayload();
    if (!payload.key) {
      showError('Please enter a field name.');
      return false;
    }
    if (!payload.description) {
      showError('Please enter a field description.');
      return false;
    }
    const otherKeys = fields
      .map((o, i) => (i === fieldIndex ? null : (o.key || '').trim().toLowerCase()))
      .filter(Boolean);
    if (otherKeys.includes(payload.key.toLowerCase())) {
      showError('This field name is already used. Please choose another.');
      return false;
    }
    if (isEdit) fields[fieldIndex] = payload;
    else fields.push(payload);
    if (typeof onDone === 'function') onDone();
    close();
    return true;
  }

  const stopSizingExamples = autoSizeExampleTextareas(editorOverlay);
  const close = mountPromptDialog(editorOverlay, () => { stopSizingExamples(); onClose?.(); });
  keyInput?.addEventListener('input', clearError);
  descInput?.addEventListener('input', clearError);
  editorOverlay.querySelector('.modal-close')?.addEventListener('click', close);
  editorOverlay.querySelector('.section-editor-save')?.addEventListener('click', save);

  keyInput?.focus();
  return { close };
}

export function renderPromptFieldCards({ fields, container, outputTypes, onChange, onEdit }) {
  if (!container) return;
  container.innerHTML = '';
  fields.forEach((field, index) => {
    const card = document.createElement('div');
    card.className = 'prompt-output-field-card';
    const displayName = (field.key || '').trim() || 'Unnamed field';
    const openEditor = () => onEdit
      ? onEdit(index)
      : openPromptFieldEditor({ fields, fieldIndex: index, outputTypes, onDone: onChange });
    card.innerHTML = `
      <div class="prompt-output-field-card-inner" tabindex="0" role="button">
        <span class="prompt-output-field-card-name">${escapeHtml(displayName)}</span>
      </div>
      <button type="button" class="prompt-output-field-card-remove" aria-label="Remove field">×</button>
    `;
    const inner = card.querySelector('.prompt-output-field-card-inner');
    const removeBtn = card.querySelector('.prompt-output-field-card-remove');
    inner?.addEventListener('click', openEditor);
    inner?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEditor();
      }
    });
    removeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      fields.splice(index, 1);
      if (typeof onChange === 'function') onChange();
    });
    container.appendChild(card);
  });
}
