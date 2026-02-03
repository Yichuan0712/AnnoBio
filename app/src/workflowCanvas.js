/**
 * Workflow canvas (node-based editor surface).
 * Listens for workflow:add-prompt-node to add prompt nodes.
 */

const MIN_CONTENT_PADDING = 200;

export function buildWorkflowCanvas(root) {
  const canvas = document.createElement('div');
  canvas.className = 'workflow-canvas';

  const scrollWrapper = document.createElement('div');
  scrollWrapper.className = 'workflow-canvas__scroll';

  const contentInner = document.createElement('div');
  contentInner.className = 'workflow-canvas__inner';

  const nodesLayer = document.createElement('div');
  nodesLayer.className = 'workflow-canvas__nodes';

  contentInner.appendChild(nodesLayer);
  scrollWrapper.appendChild(contentInner);
  canvas.appendChild(scrollWrapper);

  let nodeCount = 0;
  const STAGGER = 36;

  function updateContentSize() {
    const nodes = nodesLayer.querySelectorAll('.workflow-node--prompt');
    const minW = scrollWrapper.clientWidth || 800;
    const minH = scrollWrapper.clientHeight || 600;
    let maxRight = 0;
    let maxBottom = 0;
    nodes.forEach((n) => {
      const left = parseFloat(n.style.left) || 0;
      const top = parseFloat(n.style.top) || 0;
      maxRight = Math.max(maxRight, left + (n.offsetWidth || 0));
      maxBottom = Math.max(maxBottom, top + (n.offsetHeight || 0));
    });
    const width = Math.max(minW, maxRight + MIN_CONTENT_PADDING);
    const height = Math.max(minH, maxBottom + MIN_CONTENT_PADDING);
    contentInner.style.width = `${width}px`;
    contentInner.style.height = `${height}px`;
    nodesLayer.style.width = `${width}px`;
    nodesLayer.style.minHeight = `${height}px`;
  }

  requestAnimationFrame(() => updateContentSize());

  function sectionsToViewHtml(sectionsList) {
    if (!sectionsList || sectionsList.length === 0) return '<p class="prompt-detail-placeholder">No sections.</p>';
    return sectionsList
      .map(
        (s) => `
          <div class="preview-field-block">
            <div class="preview-field-divider">
              <span class="preview-field-line" aria-hidden="true"></span>
              <span class="preview-field-name">${escapeHtml(s.name || 'Unnamed')}</span>
            </div>
            <div class="preview-field-content">${escapeHtml(s.content || '')}</div>
          </div>
        `
      )
      .join('');
  }

  const OUTPUT_TYPES = [
    { value: 'str', label: 'String' },
    { value: 'float', label: 'Number' },
    { value: 'list_str', label: 'List of string' },
    { value: 'list_float', label: 'List of number' },
  ];

  const SCHEMA_PREVIEW_MAX_CHARS = 30;

  function truncateForSchema(str) {
    const s = String(str ?? '').trim();
    return s.length > SCHEMA_PREVIEW_MAX_CHARS ? s.slice(0, SCHEMA_PREVIEW_MAX_CHARS) + '…' : s;
  }

  function formatSchemaExamplesForView(examples, type) {
    if (!Array.isArray(examples) || examples.length === 0) return '';
    const isList = type === 'list_str' || type === 'list_float';
    if (isList) {
      return examples
        .map((arr) => {
          if (!Array.isArray(arr)) return '[]';
          return type === 'list_str' ? '[' + arr.map((el) => '"' + String(el ?? '').replace(/"/g, '\\"') + '"').join(', ') + ']' : '[' + arr.join(', ') + ']';
        })
        .join('; ');
    }
    return type === 'str' ? examples.map((ex) => '"' + String(ex ?? '').replace(/"/g, '\\"') + '"').join(', ') : examples.join(', ');
  }

  function schemaToViewHtml(fields, returnShape) {
    if (!fields || fields.length === 0) return '<p class="prompt-detail-placeholder">No output schema.</p>';
    const rows = fields.map((f) => {
      const nameRaw = (f.key || '').trim() || 'Unnamed field';
      const descRaw = (f.description ?? '').trim();
      const exRaw = formatSchemaExamplesForView(f.examples || [], f.type || 'str');
      const name = escapeHtml(truncateForSchema(nameRaw));
      const desc = escapeHtml(truncateForSchema(descRaw));
      const ex = escapeHtml(truncateForSchema(exRaw));
      const nameTitle = escapeHtml(nameRaw);
      const descTitle = escapeHtml(descRaw);
      const exTitle = escapeHtml(exRaw);
      return `<tr><td title="${nameTitle}">${name}</td><td title="${descTitle}">${desc}</td><td title="${exTitle}">${ex}</td></tr>`;
    }).join('');
    return `<div class="prompt-schema-preview-table-wrap">
  <table class="prompt-schema-preview-table" aria-readonly="true">
    <thead><tr><th>Field</th><th>Description</th><th>Examples</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
  }

  function openPromptDetailModal({ name = '', note = '', sections = [], node: sourceNode = null }) {
    const displayName = (name && name.trim()) ? name.trim() : 'Prompt';
    const noteTrimmed = (note || '').trim();
    const sectionsViewHtml = sectionsToViewHtml(sections);

    let outputFormat = { returnShape: 'table', fields: [] };
    if (sourceNode) {
      try {
        const raw = JSON.parse(sourceNode.dataset.promptOutputFormat || '[]');
        const fields = (Array.isArray(raw) ? raw : []).map((o) => ({ key: o.key || '', type: o.type || 'str', description: o.description ?? '', examples: o.examples || [] }));
        outputFormat = { returnShape: sourceNode.dataset.promptOutputReturnShape || 'table', fields };
      } catch (_) {}
    }
    const schemaViewHtml = schemaToViewHtml(outputFormat.fields, outputFormat.returnShape);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'prompt-detail-title');
    overlay.innerHTML = `
      <div class="modal-panel modal-panel--prompt-detail" data-prompt-detail-mode="view">
        <div class="modal-header">
          <h2 id="prompt-detail-title" class="modal-title">Prompt details</h2>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body prompt-detail-body">
          <div class="prompt-detail-col prompt-detail-col--left">
            <div class="prompt-detail-card">
              <div class="prompt-detail-view">
                <div class="prompt-detail-row">
                  <span class="prompt-detail-label">Prompt name</span>
                  <span class="prompt-detail-name-value">${escapeHtml(displayName)}</span>
                </div>
                <div class="prompt-detail-row">
                  <span class="prompt-detail-label">Prompt description</span>
                  <div class="prompt-detail-notes-value">${noteTrimmed ? escapeHtml(noteTrimmed) : '<span class="prompt-detail-placeholder">No description.</span>'}</div>
                </div>
              </div>
              <div class="prompt-detail-edit">
                <div class="prompt-detail-row">
                  <label class="prompt-detail-label" for="prompt-detail-name-inp">Prompt name</label>
                  <input type="text" id="prompt-detail-name-inp" class="prompt-detail-input" />
                </div>
                <div class="prompt-detail-row">
                  <label class="prompt-detail-label" for="prompt-detail-notes-inp">Prompt description</label>
                  <textarea id="prompt-detail-notes-inp" class="prompt-detail-textarea" rows="3"></textarea>
                </div>
              </div>
              <div class="prompt-detail-footer">
                <button type="button" class="btn btn-secondary prompt-detail-btn-edit">Edit</button>
                <div class="prompt-detail-footer-edit">
                  <button type="button" class="btn btn-secondary prompt-detail-btn-save">Save</button>
                  <button type="button" class="btn btn-secondary prompt-detail-btn-cancel">Cancel</button>
                </div>
              </div>
            </div>
            <div class="prompt-detail-schema-wrap" data-prompt-schema-mode="view">
              <h3 class="prompt-detail-section-title">Output schema</h3>
              <div class="prompt-detail-schema-view">${schemaViewHtml}</div>
              <div class="prompt-detail-schema-edit"></div>
              <div class="prompt-detail-schema-footer">
                <button type="button" class="btn btn-secondary prompt-detail-schema-btn-edit">Edit</button>
                <div class="prompt-detail-schema-edit-btns">
                  <button type="button" class="btn btn-secondary prompt-detail-schema-btn-save">Save</button>
                  <button type="button" class="btn btn-secondary prompt-detail-schema-btn-cancel">Cancel</button>
                </div>
              </div>
            </div>
          </div>
          <div class="prompt-detail-col prompt-detail-col--right">
            <div class="prompt-detail-sections-wrap" data-prompt-sections-mode="view">
              <h3 class="prompt-detail-section-title">Prompt sections</h3>
              <div class="prompt-detail-sections-view">${sectionsViewHtml}</div>
              <div class="prompt-detail-sections-edit"></div>
              <div class="prompt-detail-sections-footer">
                <button type="button" class="btn btn-secondary prompt-detail-sections-btn-edit">Edit</button>
                <div class="prompt-detail-sections-edit-btns">
                  <button type="button" class="btn btn-secondary prompt-detail-sections-btn-save-node">Save</button>
                  <button type="button" class="btn btn-secondary prompt-detail-sections-btn-cancel">Cancel</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const panel = overlay.querySelector('.modal-panel--prompt-detail');
    const viewBlock = overlay.querySelector('.prompt-detail-view');
    const editBlock = overlay.querySelector('.prompt-detail-edit');
    const nameValueEl = overlay.querySelector('.prompt-detail-name-value');
    const notesValueEl = overlay.querySelector('.prompt-detail-notes-value');
    const nameInp = overlay.querySelector('#prompt-detail-name-inp');
    const notesInp = overlay.querySelector('#prompt-detail-notes-inp');
    const btnEdit = overlay.querySelector('.prompt-detail-btn-edit');
    const footerEdit = overlay.querySelector('.prompt-detail-footer-edit');
    const btnCancel = overlay.querySelector('.prompt-detail-btn-cancel');
    const btnSave = overlay.querySelector('.prompt-detail-btn-save');

    function applyToNode(newName, newNote) {
      if (!sourceNode) return;
      sourceNode.dataset.promptName = newName;
      sourceNode.dataset.promptNote = newNote;
      const titleEl = sourceNode.querySelector('.workflow-node__title');
      if (titleEl) titleEl.textContent = newName || 'Prompt';
      const bodyEl = sourceNode.querySelector('.workflow-node__body');
      if (newNote) {
        sourceNode.classList.remove('workflow-node--no-body');
        if (bodyEl) {
          const noteEl = bodyEl.querySelector('.workflow-node__note');
          if (noteEl) noteEl.textContent = newNote;
          else bodyEl.innerHTML = `<span class="workflow-node__note">${escapeHtml(newNote)}</span>`;
        } else {
          const div = document.createElement('div');
          div.className = 'workflow-node__body';
          div.innerHTML = `<span class="workflow-node__note">${escapeHtml(newNote)}</span>`;
          sourceNode.appendChild(div);
        }
      } else {
        if (bodyEl) bodyEl.remove();
        sourceNode.classList.add('workflow-node--no-body');
      }
    }

    function showView() {
      panel.setAttribute('data-prompt-detail-mode', 'view');
    }

    function showEdit() {
      nameInp.value = nameValueEl.textContent.trim() || '';
      notesInp.value = notesValueEl.querySelector('.prompt-detail-placeholder') ? '' : (notesValueEl.textContent || '').trim();
      panel.setAttribute('data-prompt-detail-mode', 'edit');
    }

    btnEdit.addEventListener('click', showEdit);
    btnCancel.addEventListener('click', () => showView());
    btnSave.addEventListener('click', () => {
      const newName = (nameInp.value || '').trim() || 'Prompt';
      const newNote = (notesInp.value || '').trim();
      applyToNode(newName, newNote);
      nameValueEl.textContent = newName;
      notesValueEl.innerHTML = newNote ? escapeHtml(newNote) : '<span class="prompt-detail-placeholder">No description.</span>';
      showView();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    });

    let currentSections = Array.isArray(sections) ? sections.map((s) => ({ name: s.name || '', content: s.content || '' })) : [];
    const sectionsWrap = overlay.querySelector('.prompt-detail-sections-wrap');
    const sectionsView = overlay.querySelector('.prompt-detail-sections-view');
    const sectionsEdit = overlay.querySelector('.prompt-detail-sections-edit');
    const sectionsBtnEdit = overlay.querySelector('.prompt-detail-sections-btn-edit');
    const sectionsEditBtns = overlay.querySelector('.prompt-detail-sections-edit-btns');
    const sectionsBtnCancel = overlay.querySelector('.prompt-detail-sections-btn-cancel');
    const sectionsBtnSaveNode = overlay.querySelector('.prompt-detail-sections-btn-save-node');

    function getSectionsFromEditContainer() {
      const rows = sectionsEdit.querySelectorAll('.prompt-detail-section-edit-row');
      return Array.from(rows).map((row) => ({
        name: (row.querySelector('.prompt-detail-section-name-inp')?.value ?? '').trim(),
        content: row.querySelector('.prompt-detail-section-content-inp')?.value ?? '',
      }));
    }

    function buildSectionsEditContent(sectionsList) {
      const list = Array.isArray(sectionsList) && sectionsList.length ? sectionsList : [{ name: '', content: '' }];
      return list
        .map(
          (s) => `
          <div class="prompt-detail-section-edit-row">
            <div class="prompt-detail-section-edit-header">
              <input type="text" class="prompt-detail-input prompt-detail-section-name-inp" value="${escapeHtml(s.name || '')}" placeholder="Section name" />
              <button type="button" class="prompt-field-remove prompt-detail-section-delete" aria-label="Remove section">Delete section</button>
            </div>
            <div class="prompt-detail-row">
              <label class="prompt-detail-label">Content</label>
              <textarea class="prompt-detail-textarea prompt-detail-section-content-inp" rows="2" placeholder="Content">${escapeHtml(s.content || '')}</textarea>
            </div>
          </div>
        `
        )
        .join('');
    }

    function showSectionsView() {
      sectionsWrap.setAttribute('data-prompt-sections-mode', 'view');
    }

    function showSectionsEdit() {
      let list = currentSections;
      if (sourceNode) {
        try {
          list = JSON.parse(sourceNode.dataset.promptSections || sourceNode.dataset.promptFields || '[]');
        } catch (_) {}
      }
      if (!list.length) list = [{ name: '', content: '' }];
      sectionsEdit.innerHTML =
        buildSectionsEditContent(list) +
        `<button type="button" class="btn btn-secondary prompt-detail-sections-add-row">+ Add section</button>`;
      sectionsEdit.querySelector('.prompt-detail-sections-add-row').addEventListener('click', () => {
        const addBtn = sectionsEdit.querySelector('.prompt-detail-sections-add-row');
        const newHtml = `
          <div class="prompt-detail-section-edit-row">
            <div class="prompt-detail-section-edit-header">
              <input type="text" class="prompt-detail-input prompt-detail-section-name-inp" value="" placeholder="Section name" />
              <button type="button" class="prompt-field-remove prompt-detail-section-delete" aria-label="Remove section">Delete section</button>
            </div>
            <div class="prompt-detail-row">
              <label class="prompt-detail-label">Content</label>
              <textarea class="prompt-detail-textarea prompt-detail-section-content-inp" rows="2" placeholder="Content"></textarea>
            </div>
          </div>`;
        if (addBtn) addBtn.insertAdjacentHTML('beforebegin', newHtml);
      });
      sectionsEdit.addEventListener('click', (e) => {
        const delBtn = e.target.closest('.prompt-detail-section-delete');
        if (!delBtn) return;
        const row = delBtn.closest('.prompt-detail-section-edit-row');
        if (!row) return;
        const rows = sectionsEdit.querySelectorAll('.prompt-detail-section-edit-row');
        if (rows.length <= 1) return;
        row.remove();
      });
      sectionsWrap.setAttribute('data-prompt-sections-mode', 'edit');
    }

    sectionsBtnEdit.addEventListener('click', () => {
      showSectionsEdit();
    });
    sectionsBtnCancel.addEventListener('click', () => {
      showSectionsView();
    });
    sectionsBtnSaveNode.addEventListener('click', () => {
      const newSections = getSectionsFromEditContainer().filter((s) => s.name || s.content);
      currentSections = newSections;
      if (sourceNode) {
        sourceNode.dataset.promptSections = JSON.stringify(newSections);
      }
      sectionsView.innerHTML = sectionsToViewHtml(newSections.length ? newSections : []);
      showSectionsView();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    });

    let currentSchemaFields = (outputFormat.fields || []).map((o) => ({
      key: o.key || '',
      type: o.type || 'str',
      description: o.description ?? '',
      examples: (o.examples || []).map((ex) => (Array.isArray(ex) ? ex.slice() : ex)),
    }));
    let currentSchemaReturnShape = outputFormat.returnShape || 'table';
    const schemaWrap = overlay.querySelector('.prompt-detail-schema-wrap');
    const schemaView = overlay.querySelector('.prompt-detail-schema-view');
    const schemaEdit = overlay.querySelector('.prompt-detail-schema-edit');
    const schemaBtnEdit = overlay.querySelector('.prompt-detail-schema-btn-edit');
    const schemaEditBtns = overlay.querySelector('.prompt-detail-schema-edit-btns');
    const schemaBtnCancel = overlay.querySelector('.prompt-detail-schema-btn-cancel');
    const schemaBtnSave = overlay.querySelector('.prompt-detail-schema-btn-save');

    function renderOneExampleScalarDetail(type, ex, fieldIdx, exIdx) {
      const valEsc = escapeHtml(typeof ex === 'string' ? ex : String(ex ?? ''));
      if (type === 'float') {
        return `<input type="number" step="any" class="prompt-field-name prompt-output-example-inp" value="${valEsc}" placeholder="" data-field-index="${fieldIdx}" data-ex-index="${exIdx}" />`;
      }
      return `<textarea class="prompt-field-name prompt-output-example-inp prompt-output-example-textarea" rows="2" placeholder="" data-field-index="${fieldIdx}" data-ex-index="${exIdx}">${valEsc}</textarea>`;
    }

    function renderOneExampleListDetail(type, elements, fieldIdx, exIdx) {
      const elList = Array.isArray(elements) ? elements : [];
      const isListStr = type === 'list_str';
      const commaSpan = '<span class="prompt-output-list-comma">,</span>';
      const makeEl = (el, elIdx) => {
        const raw = isListStr ? (typeof el === 'string' ? el : '') : (typeof el === 'number' ? el : (el != null && el !== '' ? Number(el) : ''));
        const v = escapeHtml(String(raw ?? ''));
        const inp = isListStr
          ? `<textarea class="prompt-field-name prompt-output-list-element-inp prompt-output-list-element-textarea" rows="2" placeholder="" data-field-index="${fieldIdx}" data-ex-index="${exIdx}" data-el-index="${elIdx}">${v}</textarea>`
          : `<input type="number" step="any" class="prompt-field-name prompt-output-list-element-inp" value="${v}" placeholder="" data-field-index="${fieldIdx}" data-ex-index="${exIdx}" data-el-index="${elIdx}" />`;
        const quoteWrap = isListStr ? `<span class="prompt-output-list-quote">"</span>${inp}<span class="prompt-output-list-quote">"</span>` : inp;
        return `<span class="prompt-output-list-element-wrap">${quoteWrap}${commaSpan}<button type="button" class="prompt-output-del-list-element" aria-label="Remove item" data-field-index="${fieldIdx}" data-ex-index="${exIdx}" data-el-index="${elIdx}">×</button></span>`;
      };
      let parts = elList.map((el, elIdx) => makeEl(el, elIdx));
      if (parts.length === 0) {
        const inp0 = isListStr
          ? '<textarea class="prompt-field-name prompt-output-list-element-inp prompt-output-list-element-textarea" rows="2" placeholder="" data-field-index="' + fieldIdx + '" data-ex-index="' + exIdx + '" data-el-index="0"></textarea>'
          : '<input type="number" step="any" class="prompt-field-name prompt-output-list-element-inp" placeholder="" data-field-index="' + fieldIdx + '" data-ex-index="' + exIdx + '" data-el-index="0" />';
        const quoteWrap0 = isListStr ? '<span class="prompt-output-list-quote">"</span>' + inp0 + '<span class="prompt-output-list-quote">"</span>' : inp0;
        parts = [`<span class="prompt-output-list-element-wrap">${quoteWrap0}${commaSpan}<button type="button" class="prompt-output-del-list-element" aria-label="Remove item" data-field-index="${fieldIdx}" data-ex-index="${exIdx}" data-el-index="0">×</button></span>`];
      }
      const lineBlocks = parts.map((p) => `<div class="prompt-output-list-line">${p}</div>`).join('');
      const listInner = `<div class="prompt-output-list-elements prompt-output-list-elements--stacked"><span class="prompt-output-list-bracket">[</span>${lineBlocks}<span class="prompt-output-list-bracket">]</span></div>`;
      return `<div class="prompt-output-list-example-row" data-field-index="${fieldIdx}" data-ex-index="${exIdx}">${listInner}<div class="prompt-output-list-example-actions"><button type="button" class="btn btn-secondary prompt-output-add-list-element" data-field-index="${fieldIdx}" data-ex-index="${exIdx}">+ Add item</button><button type="button" class="prompt-field-remove prompt-output-del-example" aria-label="Remove example" data-field-index="${fieldIdx}" data-ex-index="${exIdx}">×</button></div></div>`;
    }

    function buildSchemaFieldBlockDetail(item, fieldIdx) {
      const keyEsc = escapeHtml(item.key || '');
      const descEsc = escapeHtml(item.description ?? '');
      const type = item.type || 'str';
      const examples = Array.isArray(item.examples) ? item.examples : [];
      const isList = type === 'list_str' || type === 'list_float';
      const typeOptions = OUTPUT_TYPES.map((t) => `<option value="${t.value}" ${t.value === type ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('');
      let examplesHtml = '';
      if (isList) {
        examples.forEach((ex, exIdx) => {
          const arr = Array.isArray(ex) ? ex : [];
          examplesHtml += renderOneExampleListDetail(type, arr, fieldIdx, exIdx);
        });
        if (examples.length === 0) examplesHtml += renderOneExampleListDetail(type, [], fieldIdx, 0);
      } else {
        examples.forEach((ex, exIdx) => {
          examplesHtml += `<div class="prompt-output-example-row">${renderOneExampleScalarDetail(type, ex, fieldIdx, exIdx)}<button type="button" class="prompt-field-remove prompt-output-del-example" aria-label="Remove example" data-field-index="${fieldIdx}" data-ex-index="${exIdx}">×</button></div>`;
        });
      }
      return `<div class="prompt-output-key-block prompt-field" data-key-index="${fieldIdx}">
        <div class="prompt-field-header">
          <input type="text" class="prompt-field-name prompt-output-key-inp" value="${keyEsc}" placeholder="Field name" data-key-index="${fieldIdx}" />
          <select class="prompt-output-type-select dataset-meta-input" data-key-index="${fieldIdx}">${typeOptions}</select>
          <button type="button" class="prompt-field-remove prompt-output-del-key" aria-label="Remove field" data-key-index="${fieldIdx}">Delete field</button>
        </div>
        <div class="prompt-output-description-wrap">
          <label class="prompt-output-description-label">Description</label>
          <textarea class="prompt-output-description-inp dataset-meta-input" rows="2" placeholder="Description for this field (optional)" data-key-index="${fieldIdx}">${descEsc}</textarea>
        </div>
        <div class="prompt-output-examples-wrap">
          <p class="prompt-output-examples-label">Examples for this field:</p>
          <div class="prompt-output-examples-list">${examplesHtml}</div>
          <button type="button" class="btn btn-secondary prompt-output-add-example" data-key-index="${fieldIdx}">+ Add example</button>
        </div>
      </div>`;
    }

    function getSchemaFromEditContainer() {
      const returnShapeEl = schemaEdit.querySelector('input[name="prompt-detail-schema-return-shape"]:checked');
      const returnShape = (returnShapeEl?.value || 'table') === 'single' ? 'single' : 'table';
      const blocks = schemaEdit.querySelectorAll('.prompt-output-key-block');
      const fields = Array.from(blocks).map((block) => {
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
      return { returnShape, fields };
    }

    function showSchemaView() {
      schemaWrap.setAttribute('data-prompt-schema-mode', 'view');
    }

    function showSchemaEdit() {
      if (sourceNode) {
        try {
          const raw = JSON.parse(sourceNode.dataset.promptOutputFormat || '[]');
          currentSchemaFields = (Array.isArray(raw) ? raw : []).map((o) => ({
            key: o.key || '',
            type: o.type || 'str',
            description: o.description ?? '',
            examples: (o.examples || []).map((ex) => (Array.isArray(ex) ? ex.slice() : ex)),
          }));
          currentSchemaReturnShape = sourceNode.dataset.promptOutputReturnShape || 'table';
        } catch (_) {}
      }
      if (currentSchemaFields.length === 0) currentSchemaFields = [{ key: '', type: 'str', description: '', examples: [] }];
      schemaEdit.innerHTML = `
        <div class="prompt-output-return-shape-wrap">
          <span class="prompt-output-return-shape-label">Return shape:</span>
          <label class="prompt-output-return-shape-option"><input type="radio" name="prompt-detail-schema-return-shape" value="single" ${currentSchemaReturnShape === 'single' ? 'checked' : ''} /> Single row of fields</label>
          <label class="prompt-output-return-shape-option"><input type="radio" name="prompt-detail-schema-return-shape" value="table" ${currentSchemaReturnShape === 'table' ? 'checked' : ''} /> Table of fields (multiple rows)</label>
        </div>
        <div class="prompt-output-format-wrap">
          <div class="prompt-detail-schema-keys-list">${currentSchemaFields.map((item, i) => buildSchemaFieldBlockDetail(item, i)).join('')}</div>
          <div class="prompt-output-format-actions">
            <button type="button" class="btn btn-secondary prompt-detail-schema-add-key">+ Add field</button>
          </div>
        </div>
      `;
      const keysListEl = schemaEdit.querySelector('.prompt-detail-schema-keys-list');

      function reRenderSchemaFields() {
        const { returnShape, fields } = getSchemaFromEditContainer();
        currentSchemaFields = fields.length ? fields : [{ key: '', type: 'str', description: '', examples: [] }];
        currentSchemaReturnShape = returnShape;
        keysListEl.innerHTML = currentSchemaFields.map((item, i) => buildSchemaFieldBlockDetail(item, i)).join('');
        bindSchemaKeyEvents();
      }

      function bindSchemaKeyEvents() {
        schemaEdit.querySelectorAll('.prompt-output-del-key').forEach((btn) => {
          btn.replaceWith(btn.cloneNode(true));
        });
        schemaEdit.querySelectorAll('.prompt-output-del-key').forEach((btn) => {
          btn.addEventListener('click', () => {
            const { fields } = getSchemaFromEditContainer();
            if (fields.length <= 1) return;
            const i = parseInt(btn.getAttribute('data-key-index'), 10);
            currentSchemaFields = fields.filter((_, idx) => idx !== i);
            keysListEl.innerHTML = currentSchemaFields.map((item, idx) => buildSchemaFieldBlockDetail(item, idx)).join('');
            bindSchemaKeyEvents();
          });
        });
        schemaEdit.querySelectorAll('.prompt-output-add-example').forEach((btn) => {
          btn.replaceWith(btn.cloneNode(true));
        });
        schemaEdit.querySelectorAll('.prompt-output-add-example').forEach((btn) => {
          btn.addEventListener('click', () => {
            const { fields } = getSchemaFromEditContainer();
            const fieldIdx = parseInt(btn.getAttribute('data-key-index'), 10);
            if (!fields[fieldIdx]) return;
            if (!Array.isArray(fields[fieldIdx].examples)) fields[fieldIdx].examples = [];
            const isList = fields[fieldIdx].type === 'list_str' || fields[fieldIdx].type === 'list_float';
            fields[fieldIdx].examples.push(isList ? [] : '');
            currentSchemaFields = fields;
            keysListEl.innerHTML = currentSchemaFields.map((item, idx) => buildSchemaFieldBlockDetail(item, idx)).join('');
            bindSchemaKeyEvents();
          });
        });
        schemaEdit.querySelectorAll('.prompt-output-del-example').forEach((btn) => {
          btn.replaceWith(btn.cloneNode(true));
        });
        schemaEdit.querySelectorAll('.prompt-output-del-example').forEach((btn) => {
          btn.addEventListener('click', () => {
            const { fields } = getSchemaFromEditContainer();
            const fieldIdx = parseInt(btn.getAttribute('data-field-index'), 10);
            const exIdx = parseInt(btn.getAttribute('data-ex-index'), 10);
            if (fields[fieldIdx]?.examples?.length) {
              fields[fieldIdx].examples.splice(exIdx, 1);
              currentSchemaFields = fields;
              keysListEl.innerHTML = currentSchemaFields.map((item, idx) => buildSchemaFieldBlockDetail(item, idx)).join('');
              bindSchemaKeyEvents();
            }
          });
        });
        schemaEdit.querySelectorAll('.prompt-output-type-select').forEach((sel) => {
          sel.replaceWith(sel.cloneNode(true));
        });
        schemaEdit.querySelectorAll('.prompt-output-type-select').forEach((sel) => {
          sel.addEventListener('change', () => {
            const { fields } = getSchemaFromEditContainer();
            currentSchemaFields = fields;
            keysListEl.innerHTML = currentSchemaFields.map((item, idx) => buildSchemaFieldBlockDetail(item, idx)).join('');
            bindSchemaKeyEvents();
          });
        });
        schemaEdit.querySelectorAll('.prompt-output-add-list-element').forEach((btn) => {
          btn.replaceWith(btn.cloneNode(true));
        });
        schemaEdit.querySelectorAll('.prompt-output-add-list-element').forEach((btn) => {
          btn.addEventListener('click', () => {
            const { fields } = getSchemaFromEditContainer();
            const fieldIdx = parseInt(btn.getAttribute('data-field-index'), 10);
            const exIdx = parseInt(btn.getAttribute('data-ex-index'), 10);
            const item = fields[fieldIdx];
            if (item?.examples && Array.isArray(item.examples[exIdx])) {
              item.examples[exIdx].push('');
              currentSchemaFields = fields;
              keysListEl.innerHTML = currentSchemaFields.map((it, idx) => buildSchemaFieldBlockDetail(it, idx)).join('');
              bindSchemaKeyEvents();
            }
          });
        });
        schemaEdit.querySelectorAll('.prompt-output-del-list-element').forEach((btn) => {
          btn.replaceWith(btn.cloneNode(true));
        });
        schemaEdit.querySelectorAll('.prompt-output-del-list-element').forEach((btn) => {
          btn.addEventListener('click', () => {
            const { fields } = getSchemaFromEditContainer();
            const fieldIdx = parseInt(btn.getAttribute('data-field-index'), 10);
            const exIdx = parseInt(btn.getAttribute('data-ex-index'), 10);
            const elIdx = parseInt(btn.getAttribute('data-el-index'), 10);
            const item = fields[fieldIdx];
            if (item?.examples?.[exIdx]?.length > 1) {
              item.examples[exIdx].splice(elIdx, 1);
              currentSchemaFields = fields;
              keysListEl.innerHTML = currentSchemaFields.map((it, idx) => buildSchemaFieldBlockDetail(it, idx)).join('');
              bindSchemaKeyEvents();
            }
          });
        });
      }

      bindSchemaKeyEvents();
      schemaEdit.querySelector('.prompt-detail-schema-add-key').addEventListener('click', () => {
        currentSchemaFields.push({ key: '', type: 'str', description: '', examples: [] });
        keysListEl.innerHTML = currentSchemaFields.map((item, idx) => buildSchemaFieldBlockDetail(item, idx)).join('');
        bindSchemaKeyEvents();
      });
      schemaWrap.setAttribute('data-prompt-schema-mode', 'edit');
    }

    schemaBtnEdit.addEventListener('click', showSchemaEdit);
    schemaBtnCancel.addEventListener('click', showSchemaView);
    schemaBtnSave.addEventListener('click', () => {
      const { returnShape, fields } = getSchemaFromEditContainer();
      const normalized = fields.map((o) => ({
        key: o.key || '',
        type: o.type || 'str',
        description: (o.description ?? '').trim() || '',
        examples: (o.examples || []).map((ex) => (Array.isArray(ex) ? ex.slice() : ex)),
      }));
      currentSchemaFields = normalized.length ? normalized : [{ key: '', type: 'str', description: '', examples: [] }];
      currentSchemaReturnShape = returnShape;
      if (sourceNode) {
        sourceNode.dataset.promptOutputFormat = JSON.stringify(currentSchemaFields);
        sourceNode.dataset.promptOutputReturnShape = currentSchemaReturnShape;
      }
      schemaView.innerHTML = schemaToViewHtml(currentSchemaFields, currentSchemaReturnShape);
      showSchemaView();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    });

    overlay.querySelector('.modal-close').addEventListener('click', () => {
      overlay.remove();
      document.body.style.overflow = '';
    });
    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
  }

  function createPromptNode({ name = '', note = '', sections = [], outputFormat, left, top }) {
    const title = (name && name.trim()) ? name.trim() : 'Prompt';
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--prompt';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', `Prompt node: ${title}`);
    node.dataset.promptSections = JSON.stringify(sections);
    node.dataset.promptName = name;
    node.dataset.promptNote = note;
    let ofList = outputFormat?.fields ?? (Array.isArray(outputFormat) ? outputFormat : []);
    if (!ofList.length && outputFormat?.columns?.length) {
      ofList = outputFormat.columns.map((key) => ({
        key: key || '',
        type: 'str',
        examples: (outputFormat.examples || []).map((r) => r[key]).filter((v) => v != null && v !== ''),
      }));
    }
    ofList = ofList.map((o) => ({ key: o.key || '', type: o.type || 'str', description: o.description ?? '', examples: o.examples || [] }));
    node.dataset.promptOutputFormat = JSON.stringify(ofList);
    node.dataset.promptOutputReturnShape = outputFormat?.returnShape ?? 'single';
    const x = typeof left === 'number' ? left : 80 + (nodeCount % 5) * (280 + STAGGER);
    const y = typeof top === 'number' ? top : 80 + Math.floor(nodeCount / 5) * (120 + STAGGER);
    nodeCount += 1;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    const noteTrimmed = (note || '').trim();
    const hasNote = noteTrimmed.length > 0;
    if (!hasNote) node.classList.add('workflow-node--no-body');
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__title">${escapeHtml(title)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
      </div>
      ${hasNote ? `<div class="workflow-node__body"><span class="workflow-node__note">${escapeHtml(noteTrimmed)}</span></div>` : ''}
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      node.remove();
      updateContentSize();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    });

    node.addEventListener('dblclick', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      let sectionsData = [];
      try {
        sectionsData = JSON.parse(node.dataset.promptSections || node.dataset.promptFields || '[]');
      } catch (_) {}
      openPromptDetailModal({
        name: node.dataset.promptName || '',
        note: node.dataset.promptNote || '',
        sections: sectionsData,
        node,
      });
    });

    let dragStartX = 0;
    let dragStartY = 0;
    let nodeStartLeft = 0;
    let nodeStartTop = 0;

    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      const scrollContainer = nodesLayer.parentElement?.parentElement;
      const parentRect = scrollContainer ? scrollContainer.getBoundingClientRect() : nodesLayer.getBoundingClientRect();
      const scrollLeft = scrollContainer ? scrollContainer.scrollLeft : 0;
      const scrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartLeft = rect.left - parentRect.left + scrollLeft;
      nodeStartTop = rect.top - parentRect.top + scrollTop;
      node.classList.add('workflow-node--dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, { once: true });
    }

    function onPointerMove(e) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      node.style.left = `${nodeStartLeft + dx}px`;
      node.style.top = `${nodeStartTop + dy}px`;
    }

    function onPointerUp() {
      node.classList.remove('workflow-node--dragging');
      document.removeEventListener('pointermove', onPointerMove);
      updateContentSize();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }

    node.addEventListener('pointerdown', onPointerDown);

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    return node;
  }

  function showNodeContextMenu(clientX, clientY, node) {
    const existing = document.querySelector('.workflow-node-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'workflow-node-context-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <button type="button" class="workflow-node-context-item" data-action="placeholder-1" role="menuitem">Action 1 (placeholder)</button>
      <button type="button" class="workflow-node-context-item" data-action="placeholder-2" role="menuitem">Action 2 (placeholder)</button>
      <button type="button" class="workflow-node-context-item" data-action="placeholder-3" role="menuitem">Action 3 (placeholder)</button>
    `;

    const placeholders = {
      'placeholder-1': () => { /* TODO */ },
      'placeholder-2': () => { /* TODO */ },
      'placeholder-3': () => { /* TODO */ },
    };

    menu.querySelectorAll('.workflow-node-context-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.getAttribute('data-action');
        if (placeholders[action]) placeholders[action]();
        menu.remove();
      });
    });

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const padding = 8;
    let left = clientX;
    let top = clientY;
    if (left + rect.width + padding > window.innerWidth) left = window.innerWidth - rect.width - padding;
    if (top + rect.height + padding > window.innerHeight) top = window.innerHeight - rect.height - padding;
    if (left < padding) left = padding;
    if (top < padding) top = padding;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const close = () => {
      menu.remove();
      document.removeEventListener('click', close);
      document.removeEventListener('contextmenu', close);
    };
    requestAnimationFrame(() => document.addEventListener('click', close, { once: true }));
    document.addEventListener('contextmenu', close, { once: true });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  document.addEventListener('workflow:add-prompt-node', (e) => {
    const { name = '', note = '', sections = [], outputFormat } = e.detail || {};
    createPromptNode({ name, note, sections, outputFormat });
    updateContentSize();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  });

  function getCanvasState() {
    const nodes = Array.from(nodesLayer.querySelectorAll('.workflow-node--prompt')).map((node) => {
      let sections = [];
      let outputFormat = [];
      try {
        sections = JSON.parse(node.dataset.promptSections || node.dataset.promptFields || '[]');
      } catch (_) {}
      try {
        const raw = JSON.parse(node.dataset.promptOutputFormat || '[]');
        const fields = (Array.isArray(raw) ? raw : []).map((o) => ({ key: o.key || '', type: o.type || 'str', description: o.description ?? '', examples: o.examples || [] }));
        const returnShape = node.dataset.promptOutputReturnShape || 'single';
        outputFormat = { returnShape, fields };
      } catch (_) {
        outputFormat = { returnShape: 'single', fields: [] };
      }
      return {
        left: parseFloat(node.style.left) || 0,
        top: parseFloat(node.style.top) || 0,
        name: node.dataset.promptName || '',
        note: node.dataset.promptNote || '',
        sections: Array.isArray(sections) ? sections : [],
        outputFormat,
      };
    });
    return { version: 1, nodes };
  }

  function loadCanvasState(state) {
    const list = state?.nodes;
    if (!Array.isArray(list)) return;
    nodesLayer.innerHTML = '';
    nodeCount = list.length;
    list.forEach((n) => {
      createPromptNode({
        name: n.name || '',
        note: n.note || '',
        sections: n.sections || n.fields || [],
        outputFormat: n.outputFormat,
        left: n.left,
        top: n.top,
      });
    });
    updateContentSize();
  }

  function setOnCanvasChange(fn) {
    document.addEventListener('workflow:canvas-changed', fn);
  }

  root.appendChild(canvas);
  return { getCanvasState, loadCanvasState, setOnCanvasChange };
}
