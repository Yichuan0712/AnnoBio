/**
 * "Add a new prompt" modal: sections, preview, Add section / Add this prompt.
 */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * @param {{ isPromptNameAlreadyUsed?: (name: string, excludeNodeId?: string | null) => boolean } | undefined } workflowCanvasApi - canvas API for name uniqueness check
 */
export function openAddPromptModal(workflowCanvasApi) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'new-project-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--prompt" data-add-prompt-step="1">
      <div class="modal-header">
        <h2 id="new-project-title" class="modal-title">Create a new prompt</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="prompt-main">
          <div class="prompt-step prompt-step-1">
            <p class="prompt-step-label">Step 1 of 3 — Name & description</p>
            <div class="dataset-meta-wrap prompt-meta-wrap">
              <div class="dataset-meta-field">
                <label class="dataset-meta-label" for="prompt-name-input">Prompt name</label>
                <input type="text" id="prompt-name-input" class="dataset-meta-input" placeholder="My prompt" />
              </div>
              <div class="dataset-meta-field">
                <label class="dataset-meta-label" for="prompt-note-input">Prompt description</label>
                <textarea id="prompt-note-input" class="dataset-meta-input dataset-meta-textarea" rows="3" placeholder="What it does"></textarea>
              </div>
            </div>
            <div class="prompt-form-error prompt-modal-error" role="alert" aria-live="polite" hidden></div>
            <div class="prompt-actions">
              <button type="button" class="btn btn-secondary prompt-btn-next">Next</button>
            </div>
          </div>
          <div class="prompt-step prompt-step-2">
            <p class="prompt-step-label">Step 2 of 3 — Sections</p>
            <p class="prompt-hint">Add named sections and enter your prompt content. You can add or remove sections.</p>
            <div class="prompt-step-scroll prompt-step-2-scroll">
              <div class="prompt-sections"></div>
              <div class="prompt-add-section-wrap">
                <button type="button" class="btn btn-secondary prompt-add-section">+ Add a section</button>
              </div>
            </div>
            <div class="prompt-form-error prompt-modal-error" role="alert" aria-live="polite" hidden></div>
            <div class="prompt-actions">
              <button type="button" class="btn btn-secondary prompt-btn-back-from-2">Back</button>
              <button type="button" class="btn btn-secondary prompt-btn-next-to-3">Next</button>
            </div>
          </div>
          <div class="prompt-step prompt-step-3">
            <p class="prompt-step-label">Step 3 of 3 — LLM output schema</p>
            <p class="prompt-hint">The LLM will return items with these fields. Add a field, then add example values for that field.</p>
            <div class="prompt-output-return-shape-wrap">
              <span class="prompt-output-return-shape-label">Return shape:</span>
              <label class="prompt-output-return-shape-option"><input type="radio" name="prompt-output-return-shape" value="single" /> Single row</label>
              <label class="prompt-output-return-shape-option"><input type="radio" name="prompt-output-return-shape" value="table" checked /> Multiple rows</label>
              </div>
            <div class="prompt-output-format-wrap">
              <div class="prompt-step-scroll prompt-step-3-format-scroll">
                <div class="prompt-output-keys-list"></div>
              </div>
            </div>
            <div class="prompt-form-error prompt-modal-error" role="alert" aria-live="polite" hidden></div>
            <div class="prompt-actions">
              <button type="button" class="btn btn-secondary prompt-btn-back">Back</button>
              <button type="button" class="btn btn-primary prompt-generate-node">Create this prompt</button>
            </div>
          </div>
        </div>
        <div class="prompt-preview-wrap">
          <h3 class="prompt-preview-title">Prompt sections</h3>
          <div class="prompt-preview" aria-readonly="true"></div>
        </div>
        <div class="prompt-schema-preview-wrap">
          <h3 class="prompt-schema-preview-title">Output schema</h3>
          <p class="prompt-schema-preview-return-shape"><span class="prompt-schema-meta-label">Return shape:</span> <span class="prompt-schema-preview-return-shape-value">Multiple rows</span></p>
          <div class="prompt-schema-preview-table-wrap">
            <table class="prompt-schema-preview-table" aria-readonly="true">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Description</th>
                  <th>Examples</th>
                </tr>
              </thead>
              <tbody class="prompt-schema-preview-tbody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;

  const panel = overlay.querySelector('.modal-panel--prompt');
  const container = overlay.querySelector('.prompt-sections');
  const addBtn = overlay.querySelector('.prompt-add-section');
  const previewEl = overlay.querySelector('.prompt-preview');
  let sections = [];

  function goToStep(step) {
    panel.setAttribute('data-add-prompt-step', String(step));
  }

  function validateStep1() {
    const nameInput = overlay.querySelector('#prompt-name-input');
    const noteInput = overlay.querySelector('#prompt-note-input');
    const name = (nameInput?.value ?? '').trim();
    const note = (noteInput?.value ?? '').trim();
    if (!name) return { valid: false, message: 'Please enter a prompt name.' };
    if (!note) return { valid: false, message: 'Please enter a prompt description.' };
    return { valid: true };
  }

  function getCurrentStepErrorEl() {
    const step = panel.getAttribute('data-add-prompt-step') || '1';
    return overlay.querySelector(`.prompt-step-${step} .prompt-modal-error`);
  }

  function showPromptError(message) {
    const el = getCurrentStepErrorEl();
    if (el) {
      el.textContent = message;
      el.hidden = false;
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function clearPromptError() {
    overlay.querySelectorAll('.prompt-modal-error').forEach((el) => {
      el.textContent = '';
      el.hidden = true;
    });
  }

  overlay.querySelector('.prompt-btn-next').addEventListener('click', () => {
    const result = validateStep1();
    if (!result.valid) {
      showPromptError(result.message);
      return;
    }
    clearPromptError();
    goToStep(2);
    renderSections();
  });

  overlay.querySelector('#prompt-name-input')?.addEventListener('input', clearPromptError);
  overlay.querySelector('#prompt-note-input')?.addEventListener('input', clearPromptError);

  overlay.querySelector('.prompt-btn-back-from-2').addEventListener('click', () => goToStep(1));

  function validateStep2() {
    const sectionsPayload = sections.map((s) => ({ name: s.name, content: s.content }));
    const sectionsWithBoth = sectionsPayload.filter((s) => (s.name || '').trim() && (s.content ?? '').trim());
    const hasPartialSection = sectionsPayload.some((s) => {
      const n = (s.name || '').trim();
      const c = (s.content ?? '').trim();
      return (n || c) && (!n || !c);
    });
    if (hasPartialSection) return { valid: false, message: 'Section name and content are required for each section.' };
    if (sectionsWithBoth.length === 0) return { valid: false, message: 'At least one section with name and content is required.' };
    if (hasDuplicateSectionNames(sectionsWithBoth)) return { valid: false, message: 'Section names must be unique. Please fix duplicate names.' };
    return { valid: true };
  }

  overlay.querySelector('.prompt-btn-next-to-3').addEventListener('click', () => {
    const result = validateStep2();
    if (!result.valid) {
      showPromptError(result.message);
      return;
    }
    clearPromptError();
    updateSchemaPreview();
    goToStep(3);
  });
  overlay.querySelector('.prompt-btn-back').addEventListener('click', () => goToStep(2));

  const OUTPUT_TYPES = [
    { value: 'str', label: 'String' },
    { value: 'float', label: 'Number' },
    { value: 'list_str', label: 'List of string' },
    { value: 'list_float', label: 'List of number' },
  ];

  let outputFields = [];
  let outputReturnShape = 'table'; // 'single' | 'table'
  const outputKeysListEl = overlay.querySelector('.prompt-output-keys-list');
  const returnShapeRadios = overlay.querySelectorAll('input[name="prompt-output-return-shape"]');
  returnShapeRadios.forEach((r) => {
    r.addEventListener('change', () => {
      outputReturnShape = overlay.querySelector('input[name="prompt-output-return-shape"]:checked')?.value || 'table';
      updateSchemaPreview();
    });
  });

  function examplesToText(examples, type) {
    if (!Array.isArray(examples) || examples.length === 0) return '';
    if (type === 'list_str' || type === 'list_float') {
      return examples.map((arr) => (Array.isArray(arr) ? arr.map(String) : []).join(', ')).join('\n');
    }
    return examples.map((ex) => (typeof ex === 'string' ? ex : String(ex ?? ''))).join('\n');
  }

  function textToExamples(text, type) {
    const lines = (text || '').split(/\n/).map((s) => s.trim()).filter(Boolean);
    if (type === 'list_str') return lines.map((line) => line.split(',').map((s) => s.trim()).filter(Boolean));
    if (type === 'list_float') return lines.map((line) => line.split(',').map((s) => s.trim()).filter((s) => s !== '').map(Number));
    if (type === 'float') return lines.map(Number);
    return lines;
  }

  function renderFieldEditorScalarRow(typeVal, value, rowIdx) {
    const isFloat = typeVal === 'float';
    const v = value != null ? (isFloat ? Number(value) : String(value)) : '';
    const valAttr = isFloat ? ` value="${escapeHtml(String(v))}"` : '';
    const inp = isFloat
      ? `<input type="number" step="any" class="dataset-meta-input field-editor-scalar-inp" data-row-index="${rowIdx}"${valAttr} aria-label="Example" />`
      : `<input type="text" class="dataset-meta-input field-editor-scalar-inp" value="${escapeHtml(String(v))}" data-row-index="${rowIdx}" aria-label="Example" />`;
    return `<div class="field-editor-scalar-row" data-row-index="${rowIdx}"><div class="field-editor-scalar-input-wrap">${inp}</div><button type="button" class="field-editor-scalar-del" aria-label="Remove">Delete</button></div>`;
  }

  function renderFieldEditorListRow(typeVal, elements, exIdx) {
    const elList = Array.isArray(elements) ? elements : [];
    const isListStr = typeVal === 'list_str';
    const makeElementRow = (val, elIdx) => {
      const v = escapeHtml(typeof val === 'string' ? val : String(val ?? ''));
      const inp = isListStr
        ? `<textarea class="dataset-meta-input dataset-meta-textarea field-editor-element-inp" rows="1" data-el-index="${elIdx}">${v}</textarea>`
        : `<input type="number" step="any" class="dataset-meta-input field-editor-element-inp" value="${v}" data-el-index="${elIdx}" />`;
      return `<div class="field-editor-element-row"><div class="field-editor-element-input-wrap">${inp}</div><button type="button" class="field-editor-del-element" aria-label="Remove">Delete</button></div>`;
    };
    const rows = elList.length > 0 ? elList.map((el, i) => makeElementRow(el, i)) : [makeElementRow('', 0)];
    const rowsHtml = rows.join('');
    return `<div class="field-editor-list-example-block" data-ex-index="${exIdx}"><div class="field-editor-element-rows">${rowsHtml}</div><div class="field-editor-list-example-actions"><button type="button" class="btn btn-secondary field-editor-add-element" data-ex-index="${exIdx}">+ Add element</button><button type="button" class="field-editor-del-example" aria-label="Remove list example" data-ex-index="${exIdx}">Delete list</button></div></div>`;
  }

  const SCHEMA_PREVIEW_MAX_CHARS = 30;

  function escapeAttr(str) {
    const s = String(str ?? '');
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  function truncateForSchema(str) {
    const s = String(str ?? '').trim();
    return s.length > SCHEMA_PREVIEW_MAX_CHARS ? s.slice(0, SCHEMA_PREVIEW_MAX_CHARS) + '…' : s;
  }

  function formatExamplesForPreview(examples, type) {
    if (!Array.isArray(examples) || examples.length === 0) return '';
    const isStr = type === 'str';
    const isListStr = type === 'list_str';
    if (type === 'list_str' || type === 'list_float') {
      return examples.map((arr) => {
        if (!Array.isArray(arr)) return '[]';
        if (isListStr) return '[' + arr.map((el) => '"' + String(el ?? '').replace(/"/g, '\\"') + '"').join(', ') + ']';
        return '[' + arr.join(', ') + ']';
      }).join('; ');
    }
    if (isStr) return examples.map((ex) => '"' + String(ex ?? '').replace(/"/g, '\\"') + '"').join(', ');
    return examples.join(', ');
  }

  function updateSchemaPreview() {
    const tbody = overlay.querySelector('.prompt-schema-preview-tbody');
    const returnShapeEl = overlay.querySelector('.prompt-schema-preview-return-shape-value');
    if (!tbody) return;
    if (returnShapeEl) {
      returnShapeEl.textContent = outputReturnShape === 'single' ? 'Single row' : 'Multiple rows';
    }
    tbody.innerHTML = outputFields.map((f) => {
      const nameRaw = (f.key || '').trim();
      const descRaw = (f.description ?? '').trim();
      const exRaw = formatExamplesForPreview(f.examples, f.type || 'str');
      const name = escapeHtml(truncateForSchema(nameRaw));
      const desc = escapeHtml(truncateForSchema(descRaw));
      const ex = escapeHtml(truncateForSchema(exRaw));
      const nameFull = escapeAttr(nameRaw);
      const descFull = escapeAttr(descRaw);
      const exFull = escapeAttr(exRaw);
      return `<tr><td class="prompt-detail-schema-cell" data-fulltext="${nameFull}">${name}</td><td class="prompt-detail-schema-cell" data-fulltext="${descFull}">${desc}</td><td class="prompt-detail-schema-cell" data-fulltext="${exFull}">${ex}</td></tr>`;
    }).join('');
  }

  function decodeAttr(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  function initSchemaPreviewTooltip() {
    const schemaWrap = overlay.querySelector('.prompt-schema-preview-wrap');
    if (!schemaWrap) return;
    let tooltip = overlay.querySelector('.prompt-detail-schema-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'prompt-detail-schema-tooltip';
      tooltip.setAttribute('role', 'tooltip');
      tooltip.hidden = true;
      overlay.appendChild(tooltip);
    }
    const showTooltip = (e) => {
      const cell = e.target.closest('.prompt-detail-schema-cell');
      if (!cell) {
        tooltip.hidden = true;
        return;
      }
      const raw = cell.getAttribute('data-fulltext');
      if (raw == null || raw === '') {
        tooltip.hidden = true;
        return;
      }
      tooltip.textContent = decodeAttr(raw);
      tooltip.hidden = false;
    };
    const hideTooltip = (e) => {
      if (!e.relatedTarget || !schemaWrap.contains(e.relatedTarget)) {
        tooltip.hidden = true;
      }
    };
    const moveTooltip = (e) => {
      if (tooltip.hidden) return;
      const gap = 10;
      let left = e.clientX + gap;
      let top = e.clientY + gap;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
      const rect = tooltip.getBoundingClientRect();
      if (rect.right > window.innerWidth) left = e.clientX - rect.width - gap;
      if (rect.bottom > window.innerHeight) top = e.clientY - rect.height - gap;
      if (left < gap) left = gap;
      if (top < gap) top = gap;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };
    schemaWrap.removeEventListener('mouseover', showTooltip);
    schemaWrap.removeEventListener('mouseout', hideTooltip);
    schemaWrap.removeEventListener('mousemove', moveTooltip);
    schemaWrap.addEventListener('mouseover', showTooltip);
    schemaWrap.addEventListener('mouseout', hideTooltip);
    schemaWrap.addEventListener('mousemove', moveTooltip);
  }

  function openFieldEditor(fieldIndex, onDone) {
    const isEdit = fieldIndex !== null && fieldIndex >= 0;
    const field = isEdit ? outputFields[fieldIndex] : { key: '', type: 'str', description: '', examples: [], allowNone: false };
    const type = field.type || 'str';
    const isListType = type === 'list_str' || type === 'list_float';
    const typeOptions = OUTPUT_TYPES.map((t) => `<option value="${t.value}" ${t.value === type ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('');
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
              <textarea id="field-editor-desc" class="dataset-meta-input dataset-meta-textarea" rows="3" aria-label="Field description">${escapeHtml(field.description ?? '')}</textarea>
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
            <button type="button" class="btn btn-secondary section-editor-cancel">Cancel</button>
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
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.hidden = false;
      }
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
          const row = `<div class="field-editor-element-row"><div class="field-editor-element-input-wrap">${inp}</div><button type="button" class="field-editor-del-element" aria-label="Remove">Delete</button></div>`;
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

    if (isListType) {
      buildListExamplesUI(type, field.examples || []);
    } else {
      buildScalarExamplesUI(type, field.examples || []);
    }

    addScalarRowBtn.addEventListener('click', () => {
      const typeVal = getCurrentType();
      const nextIdx = scalarRowsContainer.querySelectorAll('.field-editor-scalar-row').length;
      scalarRowsContainer.insertAdjacentHTML('beforeend', renderFieldEditorScalarRow(typeVal, '', nextIdx));
      reindexScalarRows();
      wireScalarExampleEvents(typeVal);
    });

    addListRowBtn.addEventListener('click', () => {
      const typeVal = getCurrentType();
      const nextIdx = listRowsContainer.querySelectorAll('.field-editor-list-example-block').length;
      listRowsContainer.insertAdjacentHTML('beforeend', renderFieldEditorListRow(typeVal, [], nextIdx));
      wireListExampleEvents(typeVal);
    });

    typeSelect.addEventListener('change', () => {
      const typeVal = getCurrentType();
      const nowList = typeVal === 'list_str' || typeVal === 'list_float';
      if (nowList) {
        const prevList = examplesListWrap.style.display !== 'none';
        let examples;
        if (prevList) {
          examples = readListExamplesFromDOM();
        } else {
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
    });

    function save() {
      const key = (keyInput?.value ?? '').trim();
      const typeVal = getCurrentType();
      const description = (descInput?.value ?? '').trim();
      const allowNone = !!(allowNoneInput && allowNoneInput.checked);
      const isList = typeVal === 'list_str' || typeVal === 'list_float';
      const examples = isList ? readListExamplesFromDOM() : readScalarExamplesFromDOM();
      if (!key) {
        showError('Please enter a field name.');
        return;
      }
      if (!description) {
        showError('Please enter a field description.');
        return;
      }
      const otherKeys = outputFields
        .map((o, i) => (i === fieldIndex ? null : (o.key || '').trim().toLowerCase()))
        .filter(Boolean);
      if (otherKeys.includes(key.toLowerCase())) {
        showError('This field name is already used. Please choose another.');
        return;
      }
      const payload = { key, type: typeVal, description, examples, allowNone };
      if (isEdit) {
        outputFields[fieldIndex] = payload;
      } else {
        outputFields.push(payload);
      }
      close();
      onDone();
    }

    editorOverlay.querySelector('.modal-close').addEventListener('click', close);
    editorOverlay.querySelector('.section-editor-cancel').addEventListener('click', close);
    editorOverlay.querySelector('.section-editor-save').addEventListener('click', save);
    editorOverlay.addEventListener('click', (e) => {
      if (e.target === editorOverlay) close();
    });

    document.body.appendChild(editorOverlay);
    keyInput?.focus();
  }

  function createFieldCard(field, index) {
    const card = document.createElement('div');
    card.className = 'prompt-output-field-card';
    const displayName = (field.key || '').trim() || 'Unnamed field';
    const openEditor = () =>
      openFieldEditor(index, () => {
        renderOutputFieldCards();
        updateSchemaPreview();
      });
    card.innerHTML = `
      <div class="prompt-output-field-card-inner" tabindex="0" role="button">
        <span class="prompt-output-field-card-name">${escapeHtml(displayName)}</span>
      </div>
      <button type="button" class="prompt-output-field-card-edit" aria-label="Edit field">Edit</button>
      <button type="button" class="prompt-output-field-card-remove" aria-label="Remove field">Delete</button>
    `;
    const inner = card.querySelector('.prompt-output-field-card-inner');
    const editBtn = card.querySelector('.prompt-output-field-card-edit');
    const removeBtn = card.querySelector('.prompt-output-field-card-remove');
    inner.addEventListener('click', openEditor);
    inner.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEditor();
      }
    });
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditor();
    });
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      outputFields.splice(index, 1);
      renderOutputFieldCards();
      updateSchemaPreview();
    });
    return card;
  }

  function renderOutputFieldCards() {
    outputKeysListEl.innerHTML = '';
    outputFields.forEach((field, index) => outputKeysListEl.appendChild(createFieldCard(field, index)));
    const addWrap = document.createElement('div');
    addWrap.className = 'prompt-add-field-wrap';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-secondary prompt-output-add-key';
    addBtn.textContent = '+ Add a field';
    addBtn.addEventListener('click', () => {
      openFieldEditor(null, () => {
        renderOutputFieldCards();
        updateSchemaPreview();
      });
    });
    addWrap.appendChild(addBtn);
    outputKeysListEl.appendChild(addWrap);
    updateSchemaPreview();
  }

  function openSectionEditor(sectionIndex, onDone) {
    const isEdit = sectionIndex !== null && sectionIndex >= 0;
    const section = isEdit ? sections[sectionIndex] : { name: '', content: '' };
    const editorOverlay = document.createElement('div');
    editorOverlay.className = 'modal-overlay modal-overlay--section-editor';
    editorOverlay.setAttribute('aria-modal', 'true');
    editorOverlay.innerHTML = `
      <div class="modal-panel modal-panel--section-editor">
        <div class="modal-header">
          <h3 class="modal-title">${isEdit ? 'Edit section' : 'Add section'}</h3>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <div class="dataset-meta-wrap">
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="section-editor-name">Section name</label>
              <input type="text" id="section-editor-name" class="dataset-meta-input" value="${escapeHtml(section.name)}" aria-label="Section name" />
            </div>
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="section-editor-content">Content</label>
              <textarea id="section-editor-content" class="dataset-meta-input dataset-meta-textarea" rows="6" aria-label="Section content">${escapeHtml(section.content)}</textarea>
              <p class="section-editor-hint">Use <code>{variable}</code> for input placeholders; <code>{{</code> for a literal brace</p>
            </div>
          </div>
          <div class="prompt-form-error section-editor-error" role="alert" aria-live="polite" hidden></div>
          <div class="modal-footer-actions">
            <button type="button" class="btn btn-secondary section-editor-cancel">Cancel</button>
            <button type="button" class="btn btn-secondary section-editor-save">${isEdit ? 'Save' : 'Add section'}</button>
          </div>
        </div>
      </div>
    `;
    const nameInput = editorOverlay.querySelector('#section-editor-name');
    const contentInput = editorOverlay.querySelector('#section-editor-content');
    const errorEl = editorOverlay.querySelector('.section-editor-error');

    function close() {
      editorOverlay.remove();
    }

    function showError(msg) {
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.hidden = false;
      }
    }

    function clearError() {
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.hidden = true;
      }
    }

    function save() {
      const name = (nameInput?.value ?? '').trim();
      const content = (contentInput?.value ?? '').trim();
      if (!name) {
        showError('Please enter a section name.');
        return;
      }
      if (!content) {
        showError('Please enter section content.');
        return;
      }
      const otherNames = sections
        .map((s, i) => (i === sectionIndex ? null : (s.name || '').trim().toLowerCase()))
        .filter(Boolean);
      if (otherNames.includes(name.toLowerCase())) {
        showError('This section name is already used. Please choose another.');
        return;
      }
      if (isEdit) {
        sections[sectionIndex] = { name, content };
      } else {
        sections.push({ name, content });
      }
      close();
      onDone();
    }

    editorOverlay.querySelector('.modal-close').addEventListener('click', close);
    editorOverlay.querySelector('.section-editor-cancel').addEventListener('click', close);
    editorOverlay.querySelector('.section-editor-save').addEventListener('click', save);
    nameInput?.addEventListener('input', clearError);
    contentInput?.addEventListener('input', clearError);
    editorOverlay.addEventListener('click', (e) => {
      if (e.target === editorOverlay) close();
    });

    document.body.appendChild(editorOverlay);
    nameInput?.focus();
  }

  function createSectionCard(section, index) {
    const card = document.createElement('div');
    card.className = 'prompt-section-card';
    const displayName = (section.name || '').trim() || 'Unnamed section';
    const openEditor = () => openSectionEditor(index, () => { renderSections(); updatePreview(); });
    card.innerHTML = `
      <div class="prompt-section-card-inner" tabindex="0" role="button">
        <span class="prompt-section-card-name">${escapeHtml(displayName)}</span>
      </div>
      <button type="button" class="prompt-section-card-edit" aria-label="Edit section">Edit</button>
      <button type="button" class="prompt-section-card-remove" aria-label="Remove section">Delete</button>
    `;
    const inner = card.querySelector('.prompt-section-card-inner');
    const editBtn = card.querySelector('.prompt-section-card-edit');
    const removeBtn = card.querySelector('.prompt-section-card-remove');
    inner.addEventListener('click', openEditor);
    inner.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEditor();
      }
    });
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditor();
    });
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sections.splice(index, 1);
      renderSections();
      updatePreview();
    });
    return card;
  }

  function updatePreview() {
    const blocks = sections.filter((s) => s.name || s.content);
    if (blocks.length === 0) {
      previewEl.innerHTML = '';
      previewEl.textContent = 'Enter sections on the left to see the combined prompt here';
      previewEl.classList.add('prompt-preview--empty');
      return;
    }
    previewEl.classList.remove('prompt-preview--empty');
    previewEl.innerHTML = blocks
      .map(
        (s) => `
      <div class="preview-field-block">
        <div class="preview-field-divider">
          <span class="preview-field-line" aria-hidden="true"></span>
          <span class="preview-field-name">${escapeHtml(s.name || 'Unnamed')}</span>
          <span class="preview-field-line" aria-hidden="true"></span>
        </div>
        <div class="preview-field-content">${escapeHtml(s.content)}</div>
      </div>
    `
      )
      .join('');
  }

  function renderSections() {
    container.innerHTML = '';
    sections.forEach((section, index) => container.appendChild(createSectionCard(section, index)));
    updatePreview();
  }

  addBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openSectionEditor(null, () => {
      renderSections();
      updatePreview();
    });
  });

  function hasDuplicateSectionNames(sectionsList) {
    const names = sectionsList.map((s) => (s.name || '').trim().toLowerCase());
    return names.length !== new Set(names).size;
  }

  function hasDuplicateFieldNames(fieldsList) {
    const keys = fieldsList.map((o) => (o.key || '').trim().toLowerCase());
    return keys.length !== new Set(keys).size;
  }

  overlay.querySelector('.prompt-generate-node').addEventListener('click', () => {
    const sectionsPayload = sections.map((s) => ({ name: s.name, content: s.content }));
    clearPromptError();
    const sectionsWithBoth = sectionsPayload.filter((s) => (s.name || '').trim() && (s.content ?? '').trim());
    const hasPartialSection = sectionsPayload.some((s) => {
      const n = (s.name || '').trim();
      const c = (s.content ?? '').trim();
      return (n || c) && (!n || !c);
    });
    if (hasPartialSection) {
      showPromptError('Section name and content are required for each section.');
      return;
    }
    if (sectionsWithBoth.length === 0) {
      showPromptError('At least one section with name and content is required.');
      return;
    }
    if (hasDuplicateSectionNames(sectionsWithBoth)) {
      showPromptError('Section names must be unique within this prompt. Please fix duplicate section names.');
      return;
    }
    const outputFormat = {
      returnShape: overlay.querySelector('input[name="prompt-output-return-shape"]:checked')?.value || 'table',
      fields: outputFields.map((o) => ({
        key: o.key || '',
        type: o.type || 'str',
        description: (o.description ?? '').trim() || '',
        examples: (o.examples || []).map((ex) => (Array.isArray(ex) ? ex.slice() : ex)),
        allowNone: o.allowNone === true,
      })),
    };
    if (outputFormat.fields.length === 0) {
      showPromptError('At least one output field is required.');
      return;
    }
    const missingFieldName = outputFormat.fields.some((f) => !(f.key ?? '').trim());
    if (missingFieldName) {
      showPromptError('Field name is required for all fields.');
      return;
    }
    if (hasDuplicateFieldNames(outputFormat.fields)) {
      showPromptError('Field names must be unique within this prompt. Please fix duplicate field names.');
      return;
    }
    const missingFieldDesc = outputFormat.fields.some((f) => !(f.description ?? '').trim());
    if (missingFieldDesc) {
      showPromptError('Field description is required for all fields.');
      return;
    }
    outputReturnShape = outputFormat.returnShape;
    const nameInput = overlay.querySelector('#prompt-name-input');
    const noteInput = overlay.querySelector('#prompt-note-input');
    const name = (nameInput?.value ?? '').trim();
    const note = (noteInput?.value ?? '').trim();
    if (!name) {
      showPromptError('Please enter a prompt name.');
      return;
    }
    if (!note) {
      showPromptError('Please enter a prompt description.');
      return;
    }
    if (workflowCanvasApi?.isPromptNameAlreadyUsed?.(name)) {
      showPromptError('This prompt name is already used on the canvas. Please choose another.');
      return;
    }
    document.dispatchEvent(
      new CustomEvent('workflow:add-prompt-node', { detail: { name, note, sections: sectionsWithBoth, outputFormat } })
    );
    close();
  });

  renderSections();
  outputReturnShape = overlay.querySelector('input[name="prompt-output-return-shape"]:checked')?.value || 'table';
  renderOutputFieldCards();

  const close = () => {
    overlay.remove();
    document.body.style.overflow = '';
  };
  overlay.querySelector('.modal-close').addEventListener('click', close);

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  initSchemaPreviewTooltip();
}
