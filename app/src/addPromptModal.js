/**
 * "Add a new prompt" modal: sections, preview, Add section / Add this prompt.
 */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function openAddPromptModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'new-project-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--prompt" data-add-prompt-step="1">
      <div class="modal-header">
        <h2 id="new-project-title" class="modal-title">Add a new prompt</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="prompt-main">
          <div class="prompt-step prompt-step-1">
            <p class="prompt-step-label">Step 1 of 3 — Sections</p>
            <p class="prompt-hint">Add named sections and enter your prompt content. You can add or remove sections.</p>
            <div class="prompt-sections"></div>
            <div class="prompt-add-section-wrap">
              <button type="button" class="btn btn-secondary prompt-add-section">+ Add section</button>
            </div>
            <div class="prompt-actions">
              <button type="button" class="btn btn-secondary prompt-btn-next">Next</button>
            </div>
          </div>
          <div class="prompt-step prompt-step-2">
            <p class="prompt-step-label">Step 2 of 3 — LLM output schema</p>
            <p class="prompt-hint">The LLM will return items with these fields. Add a field, then add example values for that field.</p>
            <div class="prompt-output-return-shape-wrap">
              <span class="prompt-output-return-shape-label">Return shape:</span>
              <label class="prompt-output-return-shape-option"><input type="radio" name="prompt-output-return-shape" value="single" /> Single row of fields</label>
              <label class="prompt-output-return-shape-option"><input type="radio" name="prompt-output-return-shape" value="table" checked /> Table of fields (multiple rows)</label>
            </div>
            <div class="prompt-output-format-wrap">
              <div class="prompt-output-keys-list"></div>
              <div class="prompt-output-format-actions">
                <button type="button" class="btn btn-secondary prompt-output-add-key">+ Add field</button>
              </div>
            </div>
            <div class="prompt-actions">
              <button type="button" class="btn btn-secondary prompt-btn-back-from-2">Back</button>
              <button type="button" class="btn btn-secondary prompt-btn-next-to-3">Next</button>
            </div>
          </div>
          <div class="prompt-step prompt-step-3">
            <p class="prompt-step-label">Step 3 of 3 — Name & description</p>
            <div class="dataset-meta-wrap prompt-meta-wrap">
              <div class="dataset-meta-field">
                <label class="dataset-meta-label" for="prompt-name-input">Prompt name</label>
                <input type="text" id="prompt-name-input" class="dataset-meta-input" placeholder="Prompt name" />
              </div>
              <div class="dataset-meta-field">
                <label class="dataset-meta-label" for="prompt-note-input">Prompt description</label>
                <textarea id="prompt-note-input" class="dataset-meta-input dataset-meta-textarea" rows="3" placeholder="This prompt has no description"></textarea>
              </div>
            </div>
            <div class="prompt-actions">
              <button type="button" class="btn btn-secondary prompt-btn-back">Back</button>
              <button type="button" class="btn btn-secondary prompt-generate-node">Add this prompt</button>
            </div>
          </div>
        </div>
        <div class="prompt-preview-wrap">
          <h3 class="prompt-preview-title">Overall prompt</h3>
          <div class="prompt-preview" aria-readonly="true"></div>
        </div>
        <div class="prompt-schema-preview-wrap">
          <h3 class="prompt-schema-preview-title">Output schema</h3>
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
  let sections = [{ name: '', content: '' }];

  function goToStep(step) {
    panel.setAttribute('data-add-prompt-step', String(step));
  }

  overlay.querySelector('.prompt-btn-next').addEventListener('click', () => goToStep(2));
  overlay.querySelector('.prompt-btn-back-from-2').addEventListener('click', () => goToStep(1));
  overlay.querySelector('.prompt-btn-next-to-3').addEventListener('click', () => {
    syncOutputFormatFromDOM();
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

  // Step 2: each item = { key, type, description, examples }; at least one field
  let outputFields = [{ key: '', type: 'str', description: '', examples: [] }];
  let outputReturnShape = 'table'; // 'single' | 'table'
  const outputKeysListEl = overlay.querySelector('.prompt-output-keys-list');
  const returnShapeRadios = overlay.querySelectorAll('input[name="prompt-output-return-shape"]');
  returnShapeRadios.forEach((r) => {
    r.addEventListener('change', () => {
      outputReturnShape = overlay.querySelector('input[name="prompt-output-return-shape"]:checked')?.value || 'table';
    });
  });

  function syncOutputFormatFromDOM() {
    const blocks = outputKeysListEl.querySelectorAll('.prompt-output-key-block');
    outputFields = Array.from(blocks).map((block) => {
      const fieldInp = block.querySelector('.prompt-output-key-inp');
      const key = (fieldInp?.value ?? '').trim() || '';
      const typeSel = block.querySelector('.prompt-output-type-select');
      const type = (typeSel?.value ?? 'str') || 'str';
      const descInp = block.querySelector('.prompt-output-description-inp');
      const description = (descInp?.value ?? '').trim() || '';
      const isList = type === 'list_str' || type === 'list_float';
      if (isList) {
        const exampleRows = block.querySelectorAll('.prompt-output-list-example-row');
        const examples = Array.from(exampleRows).map((row) =>
          Array.from(row.querySelectorAll('.prompt-output-list-element-inp')).map((inp) => (inp?.value ?? '').trim())
        );
        return { key, type, description, examples };
      }
      const exampleInputs = block.querySelectorAll('.prompt-output-example-inp');
      const examples = Array.from(exampleInputs).map((inp) => (inp?.value ?? '').trim());
      return { key, type, description, examples };
    });
  }

  const SCHEMA_PREVIEW_MAX_CHARS = 30;

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

  function updateSchemaPreview(syncFromDOM = false) {
    const tbody = overlay.querySelector('.prompt-schema-preview-tbody');
    if (!tbody) return;
    if (syncFromDOM) syncOutputFormatFromDOM();
    tbody.innerHTML = outputFields.map((f) => {
      const nameRaw = (f.key || '').trim();
      const descRaw = (f.description ?? '').trim();
      const exRaw = formatExamplesForPreview(f.examples, f.type || 'str');
      const name = escapeHtml(truncateForSchema(nameRaw));
      const desc = escapeHtml(truncateForSchema(descRaw));
      const ex = escapeHtml(truncateForSchema(exRaw));
      const nameTitle = nameRaw ? escapeHtml(nameRaw) : '';
      const descTitle = descRaw ? escapeHtml(descRaw) : '';
      const exTitle = exRaw ? escapeHtml(exRaw) : '';
      return `<tr><td title="${nameTitle}">${name}</td><td title="${descTitle}">${desc}</td><td title="${exTitle}">${ex}</td></tr>`;
    }).join('');
  }

  function renderOneExampleScalar(type, ex, fieldIdx, exIdx) {
    const valEsc = escapeHtml(typeof ex === 'string' ? ex : String(ex ?? ''));
    if (type === 'float') {
      return `<input type="number" step="any" class="prompt-field-name prompt-output-example-inp" value="${valEsc}" placeholder="" data-field-index="${fieldIdx}" data-ex-index="${exIdx}" />`;
    }
    return `<textarea class="prompt-field-name prompt-output-example-inp prompt-output-example-textarea" rows="2" placeholder="" data-field-index="${fieldIdx}" data-ex-index="${exIdx}">${valEsc}</textarea>`;
  }

  function renderOneExampleList(type, elements, fieldIdx, exIdx) {
    const elList = Array.isArray(elements) ? elements : [];
    const isListStr = type === 'list_str';
    const isListNum = type === 'list_float';
    const commaSpan = '<span class="prompt-output-list-comma">,</span>';
    const makeEl = (el, elIdx) => {
      const raw = isListNum ? (typeof el === 'number' ? el : (el != null && el !== '' ? Number(el) : '')) : (typeof el === 'string' ? el : '');
      const v = escapeHtml(String(raw ?? ''));
      const inp = isListNum
        ? `<input type="number" step="any" class="prompt-field-name prompt-output-list-element-inp" value="${v}" placeholder="" data-field-index="${fieldIdx}" data-ex-index="${exIdx}" data-el-index="${elIdx}" />`
        : `<textarea class="prompt-field-name prompt-output-list-element-inp prompt-output-list-element-textarea" rows="2" placeholder="" data-field-index="${fieldIdx}" data-ex-index="${exIdx}" data-el-index="${elIdx}">${v}</textarea>`;
      const quoteWrap = isListStr ? `<span class="prompt-output-list-quote">"</span>${inp}<span class="prompt-output-list-quote">"</span>` : inp;
      return `<span class="prompt-output-list-element-wrap">${quoteWrap}${commaSpan}<button type="button" class="prompt-output-del-list-element" aria-label="Remove item" data-field-index="${fieldIdx}" data-ex-index="${exIdx}" data-el-index="${elIdx}">×</button></span>`;
    };
    let parts = elList.map((el, elIdx) => makeEl(el, elIdx));
    if (parts.length === 0) {
      const inp0 = isListNum
        ? '<input type="number" step="any" class="prompt-field-name prompt-output-list-element-inp" placeholder="" data-field-index="' + fieldIdx + '" data-ex-index="' + exIdx + '" data-el-index="0" />'
        : '<textarea class="prompt-field-name prompt-output-list-element-inp prompt-output-list-element-textarea" rows="2" placeholder="" data-field-index="' + fieldIdx + '" data-ex-index="' + exIdx + '" data-el-index="0"></textarea>';
      const quoteWrap0 = isListStr ? '<span class="prompt-output-list-quote">"</span>' + inp0 + '<span class="prompt-output-list-quote">"</span>' : inp0;
      parts = [`<span class="prompt-output-list-element-wrap">${quoteWrap0}${commaSpan}<button type="button" class="prompt-output-del-list-element" aria-label="Remove item" data-field-index="${fieldIdx}" data-ex-index="${exIdx}" data-el-index="0">×</button></span>`];
    }
    const lineBlocks = parts.map((p) => `<div class="prompt-output-list-line">${p}</div>`).join('');
    const listInner = `<div class="prompt-output-list-elements prompt-output-list-elements--stacked"><span class="prompt-output-list-bracket">[</span>${lineBlocks}<span class="prompt-output-list-bracket">]</span></div>`;
    return `<div class="prompt-output-list-example-row" data-field-index="${fieldIdx}" data-ex-index="${exIdx}">
        ${listInner}
        <div class="prompt-output-list-example-actions">
          <button type="button" class="btn btn-secondary prompt-output-add-list-element" data-field-index="${fieldIdx}" data-ex-index="${exIdx}">+ Add item</button>
          <button type="button" class="prompt-field-remove prompt-output-del-example" aria-label="Remove example" data-field-index="${fieldIdx}" data-ex-index="${exIdx}">×</button>
        </div>
      </div>`;
  }

  function renderOutputFormat() {
    if (outputFields.length === 0) {
      outputFields = [{ key: '', type: 'str', description: '', examples: [] }];
    }
    let html = '';
    outputFields.forEach((item, fieldIdx) => {
      const keyEsc = escapeHtml(item.key || '');
      const descEsc = escapeHtml(item.description ?? '');
      const type = item.type || 'str';
      const examples = Array.isArray(item.examples) ? item.examples : [];
      const isList = type === 'list_str' || type === 'list_float';
      const typeOptions = OUTPUT_TYPES.map((t) => `<option value="${t.value}" ${t.value === type ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('');
      html += `<div class="prompt-output-key-block prompt-field" data-key-index="${fieldIdx}">
        <div class="prompt-field-header">
          <input type="text" class="prompt-field-name prompt-output-key-inp" value="${keyEsc}" placeholder="Field name" data-key-index="${fieldIdx}" aria-label="Field name" />
          <select class="prompt-output-type-select dataset-meta-input" data-key-index="${fieldIdx}" aria-label="Type">${typeOptions}</select>
          <button type="button" class="prompt-field-remove prompt-output-del-key" aria-label="Remove field" data-key-index="${fieldIdx}">Delete field</button>
        </div>
        <div class="prompt-output-description-wrap">
          <label class="prompt-output-description-label">Description</label>
          <textarea class="prompt-output-description-inp dataset-meta-input" rows="2" placeholder="Description for this field (optional)" data-key-index="${fieldIdx}" aria-label="Field description">${descEsc}</textarea>
        </div>
        <div class="prompt-output-examples-wrap">
          <p class="prompt-output-examples-label">Examples for this field:</p>
          <div class="prompt-output-examples-list">`;
      if (isList) {
        examples.forEach((ex, exIdx) => {
          const arr = Array.isArray(ex) ? ex : [];
          html += renderOneExampleList(type, arr, fieldIdx, exIdx);
        });
        if (examples.length === 0) {
          html += renderOneExampleList(type, [], fieldIdx, 0);
        }
      } else {
        examples.forEach((ex, exIdx) => {
          html += `<div class="prompt-output-example-row">${renderOneExampleScalar(type, ex, fieldIdx, exIdx)}<button type="button" class="prompt-field-remove prompt-output-del-example" aria-label="Remove example" data-field-index="${fieldIdx}" data-ex-index="${exIdx}">×</button></div>`;
        });
      }
      html += `</div>
          <button type="button" class="btn btn-secondary prompt-output-add-example" data-key-index="${fieldIdx}">+ Add example</button>
        </div>
      </div>`;
    });
    outputKeysListEl.innerHTML = html;

    outputKeysListEl.querySelectorAll('.prompt-output-del-key').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (outputFields.length <= 1) return;
        const i = parseInt(btn.getAttribute('data-key-index'), 10);
        outputFields.splice(i, 1);
        renderOutputFormat();
      });
    });

    outputKeysListEl.querySelectorAll('.prompt-output-del-example').forEach((btn) => {
      btn.addEventListener('click', () => {
        syncOutputFormatFromDOM();
        const fieldIdx = parseInt(btn.getAttribute('data-field-index'), 10);
        const exIdx = parseInt(btn.getAttribute('data-ex-index'), 10);
        if (outputFields[fieldIdx]?.examples) {
          outputFields[fieldIdx].examples.splice(exIdx, 1);
          renderOutputFormat();
        }
      });
    });

    outputKeysListEl.querySelectorAll('.prompt-output-add-example').forEach((btn) => {
      btn.addEventListener('click', () => {
        syncOutputFormatFromDOM();
        const fieldIdx = parseInt(btn.getAttribute('data-key-index'), 10);
        if (!outputFields[fieldIdx]) return;
        if (!Array.isArray(outputFields[fieldIdx].examples)) outputFields[fieldIdx].examples = [];
        const isList = outputFields[fieldIdx].type === 'list_str' || outputFields[fieldIdx].type === 'list_float';
        outputFields[fieldIdx].examples.push(isList ? [] : '');
        renderOutputFormat();
      });
    });

    outputKeysListEl.querySelectorAll('.prompt-output-add-list-element').forEach((btn) => {
      btn.addEventListener('click', () => {
        syncOutputFormatFromDOM();
        const fieldIdx = parseInt(btn.getAttribute('data-field-index'), 10);
        const exIdx = parseInt(btn.getAttribute('data-ex-index'), 10);
        const item = outputFields[fieldIdx];
        if (!item || !Array.isArray(item.examples) || !Array.isArray(item.examples[exIdx])) return;
        item.examples[exIdx].push('');
        renderOutputFormat();
      });
    });

    outputKeysListEl.querySelectorAll('.prompt-output-del-list-element').forEach((btn) => {
      btn.addEventListener('click', () => {
        syncOutputFormatFromDOM();
        const fieldIdx = parseInt(btn.getAttribute('data-field-index'), 10);
        const exIdx = parseInt(btn.getAttribute('data-ex-index'), 10);
        const elIdx = parseInt(btn.getAttribute('data-el-index'), 10);
        const item = outputFields[fieldIdx];
        if (!item?.examples?.[exIdx]?.length) return;
        if (item.examples[exIdx].length <= 1) return;
        item.examples[exIdx].splice(elIdx, 1);
        renderOutputFormat();
      });
    });

    outputKeysListEl.querySelectorAll('.prompt-output-type-select').forEach((sel) => {
      sel.addEventListener('change', () => {
        syncOutputFormatFromDOM();
        renderOutputFormat();
      });
    });
    updateSchemaPreview();
  }

  overlay.querySelector('.prompt-output-add-key').addEventListener('click', () => {
    outputFields.push({ key: '', type: 'str', description: '', examples: [] });
    renderOutputFormat();
  });

  let schemaPreviewDebounce = null;
  const formatWrap = overlay.querySelector('.prompt-output-format-wrap');
  if (formatWrap) {
    formatWrap.addEventListener('input', () => {
      clearTimeout(schemaPreviewDebounce);
      schemaPreviewDebounce = setTimeout(() => updateSchemaPreview(true), 120);
    });
    formatWrap.addEventListener('change', () => {
      clearTimeout(schemaPreviewDebounce);
      updateSchemaPreview(true);
    });
  }

  function syncSectionsFromDOM() {
    const rows = container.querySelectorAll('.prompt-section');
    if (rows.length === 0) return;
    sections = Array.from(rows).map((row) => ({
      name: row.querySelector('.prompt-section-name').value.trim(),
      content: row.querySelector('.prompt-section-content').value,
    }));
  }

  function createSectionRow(section, index) {
    const row = document.createElement('div');
    row.className = 'prompt-section';
    row.innerHTML = `
      <div class="prompt-section-header">
        <input type="text" class="prompt-section-name" placeholder="Section name" value="${escapeHtml(section.name)}" aria-label="Section name" />
        <button type="button" class="prompt-section-remove" aria-label="Remove section">Delete section</button>
      </div>
      <textarea class="prompt-section-content" placeholder="Enter content for this section..." rows="3" aria-label="Section content">${escapeHtml(section.content)}</textarea>
    `;
    row.querySelector('.prompt-section-remove').addEventListener('click', () => {
      syncSectionsFromDOM();
      sections.splice(index, 1);
      if (sections.length === 0) sections.push({ name: '', content: '' });
      renderSections(true);
    });
    return row;
  }

  function updatePreview() {
    syncSectionsFromDOM();
    const blocks = sections.filter((s) => s.name || s.content);
    if (blocks.length === 0) {
      previewEl.innerHTML = '';
      previewEl.textContent = 'Enter sections on the left to see the combined prompt here';
      return;
    }
    previewEl.innerHTML = blocks
      .map(
        (s) => `
      <div class="preview-field-block">
        <div class="preview-field-divider">
          <span class="preview-field-line" aria-hidden="true"></span>
          <span class="preview-field-name">${escapeHtml(s.name || 'Unnamed')}</span>
        </div>
        <div class="preview-field-content">${escapeHtml(s.content)}</div>
      </div>
    `
      )
      .join('');
  }

  function renderSections(skipSync = false) {
    if (!skipSync) syncSectionsFromDOM();
    container.innerHTML = '';
    sections.forEach((section, index) => container.appendChild(createSectionRow(section, index)));
    updatePreview();
  }

  container.addEventListener('input', updatePreview);
  container.addEventListener('change', updatePreview);

  addBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    syncSectionsFromDOM();
    sections.push({ name: '', content: '' });
    renderSections(true);
  });

  overlay.querySelector('.prompt-generate-node').addEventListener('click', () => {
    syncSectionsFromDOM();
    if (outputKeysListEl.querySelectorAll('.prompt-output-key-block').length) syncOutputFormatFromDOM();
    outputReturnShape = overlay.querySelector('input[name="prompt-output-return-shape"]:checked')?.value || 'table';
    const nameInput = overlay.querySelector('#prompt-name-input');
    const noteInput = overlay.querySelector('#prompt-note-input');
    const name = (nameInput?.value ?? '').trim() || '';
    const note = (noteInput?.value ?? '').trim();
    const sectionsPayload = sections.map((s) => ({ name: s.name, content: s.content }));
    const outputFormat = {
      returnShape: outputReturnShape,
      fields: outputFields.map((o) => ({
        key: o.key || '',
        type: o.type || 'str',
        description: (o.description ?? '').trim() || '',
        examples: (o.examples || []).map((ex) => (Array.isArray(ex) ? ex.slice() : ex)),
      })),
    };
    document.dispatchEvent(
      new CustomEvent('workflow:add-prompt-node', { detail: { name, note, sections: sectionsPayload, outputFormat } })
    );
    close();
  });

  renderSections();
  outputReturnShape = overlay.querySelector('input[name="prompt-output-return-shape"]:checked')?.value || 'table';
  renderOutputFormat();

  const close = () => {
    overlay.remove();
    document.body.style.overflow = '';
  };
  overlay.querySelector('.modal-close').addEventListener('click', close);

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
