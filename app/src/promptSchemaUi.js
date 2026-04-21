function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderFieldEditorScalarRow(typeVal, value, rowIdx) {
  const isFloat = typeVal === 'float';
  const hasValue = value != null && String(value) !== '';
  const v = hasValue ? String(value) : '';
  const valAttr = isFloat ? ` value="${escapeHtml(String(v))}"` : '';
  const inp = isFloat
    ? `<input type="number" step="any" class="dataset-meta-input field-editor-scalar-inp" data-row-index="${rowIdx}"${valAttr} aria-label="Example" />`
    : `<textarea class="dataset-meta-input dataset-meta-textarea field-editor-scalar-inp" rows="1" data-row-index="${rowIdx}" aria-label="Example">${escapeHtml(String(v))}</textarea>`;
  return `<div class="field-editor-scalar-row" data-row-index="${rowIdx}"><div class="field-editor-scalar-input-wrap">${inp}</div><button type="button" class="btn btn-secondary field-editor-scalar-del" aria-label="Delete example">Delete</button></div>`;
}

function renderFieldEditorListRow(typeVal, elements, exIdx) {
  const elList = Array.isArray(elements) ? elements : [];
  const isListStr = typeVal === 'list_str';
  const makeElementRow = (val, elIdx) => {
    const hasValue = val != null && String(val) !== '';
    const v = escapeHtml(hasValue ? String(val) : '');
    const inp = isListStr
      ? `<textarea class="dataset-meta-input dataset-meta-textarea field-editor-element-inp" rows="1" data-el-index="${elIdx}">${v}</textarea>`
      : `<input type="number" step="any" class="dataset-meta-input field-editor-element-inp" value="${v}" data-el-index="${elIdx}" />`;
    return `<div class="field-editor-element-row"><div class="field-editor-element-input-wrap">${inp}</div><button type="button" class="btn btn-secondary field-editor-del-element" aria-label="Delete element">Delete</button></div>`;
  };
  const rows = elList.length > 0 ? elList.map((el, i) => makeElementRow(el, i)) : [makeElementRow('', 0)];
  const rowsHtml = rows.join('');
  return `<div class="field-editor-list-example-block" data-ex-index="${exIdx}"><div class="field-editor-element-rows">${rowsHtml}</div><div class="field-editor-list-example-actions"><button type="button" class="btn btn-secondary field-editor-add-element" data-ex-index="${exIdx}">+ Add element</button><button type="button" class="btn btn-secondary field-editor-del-example" aria-label="Delete list example" data-ex-index="${exIdx}">Delete list</button></div></div>`;
}

export function openPromptFieldEditor({ fields, fieldIndex = null, outputTypes, onDone }) {
  const isEdit = fieldIndex !== null && fieldIndex >= 0;
  const field = isEdit ? fields[fieldIndex] : { key: '', type: 'str', description: '', examples: [], allowNone: false };
  const type = field.type || 'str';
  const isListType = type === 'list_str' || type === 'list_float';
  const typeOptions = outputTypes.map((t) => `<option value="${t.value}" ${t.value === type ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('');
  const editorOverlay = document.createElement('div');
  editorOverlay.className = 'modal-overlay modal-overlay--section-editor modal-overlay--field-editor';
  editorOverlay.setAttribute('aria-modal', 'true');
  editorOverlay.innerHTML = `
    <div class="modal-panel modal-panel--section-editor modal-panel--field-editor">
      <div class="modal-header">
        <h3 class="modal-title">${isEdit ? 'Edit field' : 'Add field'}</h3>
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
              <button type="button" class="btn btn-secondary field-editor-add-scalar-row">+ Add example</button>
            </div>
            <div id="field-editor-examples-list" class="field-editor-examples-list prompt-output-examples-wrap" style="${isListType ? '' : 'display:none'}">
              <div class="prompt-output-examples-list field-editor-list-rows"></div>
              <button type="button" class="btn btn-secondary field-editor-add-list-row">+ Add list example</button>
            </div>
          </div>
        </div>
        <div class="prompt-form-error section-editor-error field-editor-error" role="alert" aria-live="polite" hidden></div>
        <div class="modal-footer-actions">
          <button type="button" class="btn btn-secondary section-editor-save">${isEdit ? 'Save' : 'Add field'}</button>
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

  function close() {
    editorOverlay.remove();
  }

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
    const list = Array.isArray(examples) ? examples : [];
    scalarRowsContainer.innerHTML = '';
    if (list.length === 0) {
      scalarRowsContainer.insertAdjacentHTML('beforeend', renderFieldEditorScalarRow(typeVal, '', 0));
    } else {
      list.forEach((val, i) => {
        scalarRowsContainer.insertAdjacentHTML('beforeend', renderFieldEditorScalarRow(typeVal, val, i));
      });
    }
    wireScalarExampleEvents(typeVal);
  }

  function wireScalarExampleEvents(typeVal) {
    scalarRowsContainer.querySelectorAll('.field-editor-scalar-del').forEach((btn) => {
      btn.replaceWith(btn.cloneNode(true));
    });
    scalarRowsContainer.querySelectorAll('.field-editor-scalar-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.field-editor-scalar-row');
        const rows = scalarRowsContainer.querySelectorAll('.field-editor-scalar-row');
        if (rows.length > 1 && row) row.remove();
        reindexScalarRows();
        wireScalarExampleEvents(getCurrentType());
      });
    });
  }

  function reindexScalarRows() {
    const rows = scalarRowsContainer.querySelectorAll('.field-editor-scalar-row');
    rows.forEach((row, i) => {
      row.setAttribute('data-row-index', String(i));
      const inp = row.querySelector('.field-editor-scalar-inp');
      if (inp) inp.setAttribute('data-row-index', String(i));
    });
  }

  function readListExamplesFromDOM() {
    const blocks = listRowsContainer.querySelectorAll('.field-editor-list-example-block');
    return Array.from(blocks).map((block) =>
      Array.from(block.querySelectorAll('.field-editor-element-inp')).map((inp) => (inp?.value ?? '').trim())
    );
  }

  function buildListExamplesUI(typeVal, examples) {
    const list = Array.isArray(examples) ? examples : [];
    listRowsContainer.innerHTML = '';
    if (list.length === 0) {
      listRowsContainer.innerHTML = renderFieldEditorListRow(typeVal, [], 0);
    } else {
      list.forEach((arr, exIdx) => {
        listRowsContainer.insertAdjacentHTML('beforeend', renderFieldEditorListRow(typeVal, arr, exIdx));
      });
    }
    wireListExampleEvents(typeVal);
  }

  function wireListExampleEvents(typeVal) {
    listRowsContainer.querySelectorAll('.field-editor-add-element').forEach((btn) => {
      btn.replaceWith(btn.cloneNode(true));
    });
    listRowsContainer.querySelectorAll('.field-editor-del-example').forEach((btn) => {
      btn.replaceWith(btn.cloneNode(true));
    });
    listRowsContainer.querySelectorAll('.field-editor-del-element').forEach((btn) => {
      btn.replaceWith(btn.cloneNode(true));
    });
    listRowsContainer.querySelectorAll('.field-editor-add-element').forEach((btn) => {
      const exIdx = btn.getAttribute('data-ex-index');
      btn.addEventListener('click', () => {
        const block = listRowsContainer.querySelector(`.field-editor-list-example-block[data-ex-index="${exIdx}"]`);
        const container = block?.querySelector('.field-editor-element-rows');
        if (!container) return;
        const isListStr = typeVal === 'list_str';
        const elIdx = container.querySelectorAll('.field-editor-element-row').length;
        const inp = isListStr
          ? `<textarea class="dataset-meta-input dataset-meta-textarea field-editor-element-inp" rows="1" data-el-index="${elIdx}"></textarea>`
          : `<input type="number" step="any" class="dataset-meta-input field-editor-element-inp" data-el-index="${elIdx}" />`;
        const row = `<div class="field-editor-element-row"><div class="field-editor-element-input-wrap">${inp}</div><button type="button" class="btn btn-secondary field-editor-del-element" aria-label="Delete element">Delete</button></div>`;
        container.insertAdjacentHTML('beforeend', row);
        wireListExampleEvents(typeVal);
      });
    });
    listRowsContainer.querySelectorAll('.field-editor-del-example').forEach((btn) => {
      const exIdx = btn.getAttribute('data-ex-index');
      btn.addEventListener('click', () => {
        const block = listRowsContainer.querySelector(`.field-editor-list-example-block[data-ex-index="${exIdx}"]`);
        if (block && listRowsContainer.querySelectorAll('.field-editor-list-example-block').length > 1) {
          block.remove();
          reindexListRows();
          wireListExampleEvents(getCurrentType());
        }
      });
    });
    listRowsContainer.querySelectorAll('.field-editor-del-element').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.field-editor-element-row');
        const block = row?.closest('.field-editor-list-example-block');
        const rows = block?.querySelectorAll('.field-editor-element-row') || [];
        if (rows.length > 1 && row) row.remove();
      });
    });
  }

  function reindexListRows() {
    const blocks = listRowsContainer.querySelectorAll('.field-editor-list-example-block');
    blocks.forEach((block, i) => {
      block.setAttribute('data-ex-index', String(i));
      block.querySelector('.field-editor-add-element')?.setAttribute('data-ex-index', String(i));
      block.querySelector('.field-editor-del-example')?.setAttribute('data-ex-index', String(i));
    });
  }

  if (isListType) buildListExamplesUI(type, field.examples || []);
  else buildScalarExamplesUI(type, field.examples || []);

  addScalarRowBtn?.addEventListener('click', () => {
    const typeVal = getCurrentType();
    const nextIdx = scalarRowsContainer.querySelectorAll('.field-editor-scalar-row').length;
    scalarRowsContainer.insertAdjacentHTML('beforeend', renderFieldEditorScalarRow(typeVal, '', nextIdx));
    reindexScalarRows();
    wireScalarExampleEvents(typeVal);
  });

  addListRowBtn?.addEventListener('click', () => {
    const typeVal = getCurrentType();
    const nextIdx = listRowsContainer.querySelectorAll('.field-editor-list-example-block').length;
    listRowsContainer.insertAdjacentHTML('beforeend', renderFieldEditorListRow(typeVal, [], nextIdx));
    wireListExampleEvents(typeVal);
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
    close();
    if (typeof onDone === 'function') onDone();
    return true;
  }

  keyInput?.addEventListener('input', clearError);
  descInput?.addEventListener('input', clearError);
  editorOverlay.querySelector('.modal-close')?.addEventListener('click', close);
  editorOverlay.querySelector('.section-editor-save')?.addEventListener('click', save);

  document.body.appendChild(editorOverlay);
  keyInput?.focus();
}

export function renderPromptFieldCards({ fields, container, outputTypes, onChange }) {
  if (!container) return;
  container.innerHTML = '';
  fields.forEach((field, index) => {
    const card = document.createElement('div');
    card.className = 'prompt-output-field-card';
    const displayName = (field.key || '').trim() || 'Unnamed field';
    const openEditor = () => openPromptFieldEditor({ fields, fieldIndex: index, outputTypes, onDone: onChange });
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
