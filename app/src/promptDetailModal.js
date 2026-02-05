/**
 * Prompt detail modal: view/edit name, description, sections, output schema.
 * @param {{ name?: string, note?: string, sections?: Array<{name:string,content:string}>, node?: HTMLElement | null, isPromptNameAlreadyUsed?: (name: string, excludeNodeId?: string | null) => boolean }} options
 */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Extract unique input field names from prompt sections: single-brace placeholders {text} only; {{text}} does not count. */
export function extractInputFieldsFromSections(sectionsList) {
  if (!sectionsList || sectionsList.length === 0) return [];
  const seen = new Set();
  const names = [];
  const re = /\{([^{}]+)\}/g;
  for (const s of sectionsList) {
    const content = s.content || '';
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const charBefore = m.index > 0 ? content[m.index - 1] : '';
      const charAfter = m.index + m[0].length < content.length ? content[m.index + m[0].length] : '';
      if (charBefore === '{' || charAfter === '}') continue;
      const key = m[1].trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        names.push(key);
      }
    }
  }
  return names;
}

function inputsToViewHtml(sectionsList) {
  const fields = extractInputFieldsFromSections(sectionsList);
  if (fields.length === 0) return '<p class="prompt-detail-placeholder">No inputs.</p>';
  return fields
    .map((key) => `<span class="prompt-detail-input-tag">${escapeHtml(key)}</span>`)
    .join('');
}

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

function escapeAttr(str) {
  const s = String(str ?? '');
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

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
    const allowNone = f.allowNone === true;
    const name = escapeHtml(truncateForSchema(nameRaw));
    const desc = escapeHtml(truncateForSchema(descRaw));
    const ex = escapeHtml(truncateForSchema(exRaw));
    const nameFull = escapeAttr(nameRaw);
    const descFull = escapeAttr(descRaw);
    const exFull = escapeAttr(exRaw);
    return `<tr><td class="prompt-detail-schema-cell" data-fulltext="${nameFull}">${name}</td><td class="prompt-detail-schema-cell" data-fulltext="${descFull}">${desc}</td><td class="prompt-detail-schema-cell" data-fulltext="${exFull}">${ex}</td><td>${allowNone ? 'Yes' : 'No'}</td></tr>`;
  }).join('');
  return `<div class="prompt-schema-preview-table-wrap">
  <table class="prompt-schema-preview-table" aria-readonly="true">
    <thead><tr><th>Field</th><th>Description</th><th>Examples</th><th>Allow None</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

export function openPromptDetailModal({ name = '', note = '', sections = [], node: sourceNode = null, isPromptNameAlreadyUsed }) {
  const displayName = (name && name.trim()) ? name.trim() : 'Prompt';
  const noteTrimmed = (note || '').trim();
  const sectionsViewHtml = sectionsToViewHtml(sections);

  let outputFormat = { returnShape: 'table', fields: [] };
  if (sourceNode) {
    try {
      const raw = JSON.parse(sourceNode.dataset.promptOutputFormat || '[]');
      const fields = (Array.isArray(raw) ? raw : []).map((o) => ({ key: o.key || '', type: o.type || 'str', description: o.description ?? '', examples: o.examples || [], allowNone: o.allowNone === true }));
      outputFormat = { returnShape: sourceNode.dataset.promptOutputReturnShape || 'table', fields };
    } catch (_) {}
  }
  const inputsViewHtml = inputsToViewHtml(sections);
  const schemaViewHtml = schemaToViewHtml(outputFormat.fields, outputFormat.returnShape);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'prompt-detail-title');
  overlay.innerHTML = `
      <div class="modal-panel modal-panel--prompt-detail" data-prompt-detail-mode="view">
        <div class="modal-header">
          <h2 id="prompt-detail-title" class="modal-title">Prompt details: ${escapeHtml(displayName)}</h2>
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
                <div class="prompt-detail-inputs-wrap">
                  <h3 class="prompt-detail-section-title">PROMPT INPUTS</h3>
                  <div class="prompt-detail-inputs-content">${inputsViewHtml}</div>
                </div>
              </div>
              <div class="prompt-detail-edit">
                <div class="prompt-detail-row">
                  <label class="prompt-detail-label" for="prompt-detail-name-inp">Prompt name</label>
                  <input type="text" id="prompt-detail-name-inp" class="prompt-detail-input" placeholder="Prompt name (required)" />
                </div>
                <div class="prompt-detail-row">
                  <label class="prompt-detail-label" for="prompt-detail-notes-inp">Prompt description</label>
                  <textarea id="prompt-detail-notes-inp" class="prompt-detail-textarea" rows="3" placeholder="Prompt description (required)"></textarea>
                </div>
              </div>
              <div class="prompt-detail-footer">
                <div class="prompt-detail-inline-error" id="prompt-detail-name-error" role="alert" aria-live="polite" hidden></div>
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
                <div class="prompt-detail-inline-error" id="prompt-detail-schema-error" role="alert" aria-live="polite" hidden></div>
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
                <div class="prompt-detail-inline-error" id="prompt-detail-sections-error" role="alert" aria-live="polite" hidden></div>
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
  const nameValueEl = overlay.querySelector('.prompt-detail-name-value');
  const notesValueEl = overlay.querySelector('.prompt-detail-notes-value');
  const nameInp = overlay.querySelector('#prompt-detail-name-inp');
  const notesInp = overlay.querySelector('#prompt-detail-notes-inp');
  const btnEdit = overlay.querySelector('.prompt-detail-btn-edit');
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

  const nameErrorEl = overlay.querySelector('#prompt-detail-name-error');

  btnEdit.addEventListener('click', showEdit);
  btnCancel.addEventListener('click', () => showView());
  btnSave.addEventListener('click', () => {
    const newNameRaw = (nameInp.value || '').trim();
    const newName = newNameRaw || 'Prompt';
    const newNote = (notesInp.value || '').trim();
    if (nameErrorEl) nameErrorEl.hidden = true;
    if (!newNameRaw) {
      if (nameErrorEl) {
        nameErrorEl.textContent = 'Prompt name is required.';
        nameErrorEl.hidden = false;
      }
      return;
    }
    if (!newNote) {
      if (nameErrorEl) {
        nameErrorEl.textContent = 'Prompt description is required.';
        nameErrorEl.hidden = false;
      }
      return;
    }
    if (typeof isPromptNameAlreadyUsed === 'function' && isPromptNameAlreadyUsed(newName, sourceNode?.dataset?.nodeId ?? null)) {
      if (nameErrorEl) {
        nameErrorEl.textContent = 'This prompt name is already used on the canvas. Please choose another.';
        nameErrorEl.hidden = false;
      }
      return;
    }
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
              <input type="text" class="prompt-detail-input prompt-detail-section-name-inp" value="${escapeHtml(s.name || '')}" placeholder="Section name (required)" />
              <button type="button" class="prompt-field-remove prompt-detail-section-delete" aria-label="Remove section">Delete section</button>
            </div>
            <div class="prompt-detail-row">
              <label class="prompt-detail-label">Content</label>
              <textarea class="prompt-detail-textarea prompt-detail-section-content-inp" rows="2" placeholder="Content (required)">${escapeHtml(s.content || '')}</textarea>
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
      `<button type="button" class="btn btn-secondary prompt-detail-sections-add-row">+ Create section</button>`;
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
              <textarea class="prompt-detail-textarea prompt-detail-section-content-inp" rows="2" placeholder="Content (required)"></textarea>
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
  function hasDuplicateSectionNames(sectionsList) {
    const names = sectionsList.map((s) => (s.name || '').trim().toLowerCase());
    return names.length !== new Set(names).size;
  }

  sectionsBtnSaveNode.addEventListener('click', () => {
    const sectionsErrorEl = overlay.querySelector('#prompt-detail-sections-error');
    if (sectionsErrorEl) sectionsErrorEl.hidden = true;
    const allSections = getSectionsFromEditContainer();
    const newSections = allSections.filter((s) => (s.name || '').trim() || (s.content ?? '').trim());
    const hasPartialSection = newSections.some((s) => !(s.name || '').trim() || !(s.content ?? '').trim());
    if (hasPartialSection) {
      if (sectionsErrorEl) {
        sectionsErrorEl.textContent = 'Section name and content are required for each section.';
        sectionsErrorEl.hidden = false;
      }
      return;
    }
    if (newSections.length === 0) {
      if (sectionsErrorEl) {
        sectionsErrorEl.textContent = 'At least one section with name and content is required.';
        sectionsErrorEl.hidden = false;
      }
      return;
    }
    if (hasDuplicateSectionNames(newSections)) {
      if (sectionsErrorEl) {
        sectionsErrorEl.textContent = 'Section names must be unique within this prompt. Please fix duplicate section names.';
        sectionsErrorEl.hidden = false;
      } else alert('Section names must be unique within this prompt. Please fix duplicate section names.');
      return;
    }
    currentSections = newSections;
    if (sourceNode) {
      sourceNode.dataset.promptSections = JSON.stringify(newSections);
    }
    sectionsView.innerHTML = sectionsToViewHtml(newSections.length ? newSections : []);
    const inputsContentEl = overlay.querySelector('.prompt-detail-inputs-content');
    if (inputsContentEl) inputsContentEl.innerHTML = inputsToViewHtml(newSections);
    showSectionsView();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  });

  let currentSchemaFields = (outputFormat.fields || []).map((o) => ({
    key: o.key || '',
    type: o.type || 'str',
    description: o.description ?? '',
    examples: (o.examples || []).map((ex) => (Array.isArray(ex) ? ex.slice() : ex)),
    allowNone: o.allowNone === true,
  }));
  let currentSchemaReturnShape = outputFormat.returnShape || 'table';
  const schemaWrap = overlay.querySelector('.prompt-detail-schema-wrap');
  const schemaView = overlay.querySelector('.prompt-detail-schema-view');
  const schemaEdit = overlay.querySelector('.prompt-detail-schema-edit');

  const schemaTooltip = document.createElement('div');
  schemaTooltip.className = 'prompt-detail-schema-tooltip';
  schemaTooltip.setAttribute('role', 'tooltip');
  schemaTooltip.hidden = true;
  overlay.appendChild(schemaTooltip);

  function decodeAttr(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }
  schemaWrap.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.prompt-detail-schema-cell');
    if (!cell) {
      schemaTooltip.hidden = true;
      return;
    }
    const raw = cell.getAttribute('data-fulltext');
    if (raw == null || raw === '') {
      schemaTooltip.hidden = true;
      return;
    }
    schemaTooltip.textContent = decodeAttr(raw);
    schemaTooltip.hidden = false;
  });
  schemaWrap.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget || !schemaWrap.contains(e.relatedTarget)) {
      schemaTooltip.hidden = true;
    }
  });
  schemaWrap.addEventListener('mousemove', (e) => {
    if (schemaTooltip.hidden) return;
    const gap = 10;
    let left = e.clientX + gap;
    let top = e.clientY + gap;
    schemaTooltip.style.left = `${left}px`;
    schemaTooltip.style.top = `${top}px`;
    const rect = schemaTooltip.getBoundingClientRect();
    if (rect.right > window.innerWidth) left = e.clientX - rect.width - gap;
    if (rect.bottom > window.innerHeight) top = e.clientY - rect.height - gap;
    if (left < gap) left = gap;
    if (top < gap) top = gap;
    schemaTooltip.style.left = `${left}px`;
    schemaTooltip.style.top = `${top}px`;
  });
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
    return `<div class="prompt-output-list-example-row" data-field-index="${fieldIdx}" data-ex-index="${exIdx}">${listInner}<div class="prompt-output-list-example-actions"><button type="button" class="btn btn-secondary prompt-output-add-list-element" data-field-index="${fieldIdx}" data-ex-index="${exIdx}">+ Create item</button><button type="button" class="prompt-field-remove prompt-output-del-example" aria-label="Remove example" data-field-index="${fieldIdx}" data-ex-index="${exIdx}">×</button></div></div>`;
  }

  function buildSchemaFieldBlockDetail(item, fieldIdx) {
    const keyEsc = escapeHtml(item.key || '');
    const descEsc = escapeHtml(item.description ?? '');
    const type = item.type || 'str';
    const examples = Array.isArray(item.examples) ? item.examples : [];
    const allowNone = item.allowNone === true;
    const allowNoneChecked = allowNone ? ' checked' : '';
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
          <input type="text" class="prompt-field-name prompt-output-key-inp" value="${keyEsc}" placeholder="Field name (required)" data-key-index="${fieldIdx}" />
          <select class="prompt-output-type-select dataset-meta-input" data-key-index="${fieldIdx}">${typeOptions}</select>
          <button type="button" class="prompt-field-remove prompt-output-del-key" aria-label="Remove field" data-key-index="${fieldIdx}">Delete field</button>
        </div>
        <div class="prompt-output-description-wrap">
          <label class="prompt-output-description-label">Description</label>
          <textarea class="prompt-output-description-inp dataset-meta-input" rows="2" placeholder="Description (required)" data-key-index="${fieldIdx}">${descEsc}</textarea>
        </div>
        <div class="prompt-output-allow-none-wrap">
          <label class="prompt-output-allow-none-label"><input type="checkbox" class="prompt-output-allow-none-inp" data-key-index="${fieldIdx}" aria-label="Allow None"${allowNoneChecked} /> Allow None</label>
        </div>
        <div class="prompt-output-examples-wrap">
          <p class="prompt-output-examples-label">Examples for this field:</p>
          <div class="prompt-output-examples-list">${examplesHtml}</div>
          <button type="button" class="btn btn-secondary prompt-output-add-example" data-key-index="${fieldIdx}">+ Create example</button>
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
      const allowNoneInp = block.querySelector('.prompt-output-allow-none-inp');
      const allowNone = !!(allowNoneInp && allowNoneInp.checked);
      const isList = type === 'list_str' || type === 'list_float';
      if (isList) {
        const exampleRows = block.querySelectorAll('.prompt-output-list-example-row');
        const examples = Array.from(exampleRows).map((row) =>
          Array.from(row.querySelectorAll('.prompt-output-list-element-inp')).map((inp) => (inp?.value ?? '').trim())
        );
        return { key, type, description, examples, allowNone };
      }
      const exampleInputs = block.querySelectorAll('.prompt-output-example-inp');
      const examples = Array.from(exampleInputs).map((inp) => (inp?.value ?? '').trim());
      return { key, type, description, examples, allowNone };
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
          allowNone: o.allowNone === true,
        }));
        currentSchemaReturnShape = sourceNode.dataset.promptOutputReturnShape || 'table';
      } catch (_) {}
    }
    if (currentSchemaFields.length === 0) currentSchemaFields = [{ key: '', type: 'str', description: '', examples: [], allowNone: false }];
    schemaEdit.innerHTML = `
        <div class="prompt-output-return-shape-wrap">
          <span class="prompt-output-return-shape-label">Return shape:</span>
          <label class="prompt-output-return-shape-option"><input type="radio" name="prompt-detail-schema-return-shape" value="single" ${currentSchemaReturnShape === 'single' ? 'checked' : ''} /> Single row of fields</label>
          <label class="prompt-output-return-shape-option"><input type="radio" name="prompt-detail-schema-return-shape" value="table" ${currentSchemaReturnShape === 'table' ? 'checked' : ''} /> Table of fields (multiple rows)</label>
        </div>
        <div class="prompt-output-format-wrap">
          <div class="prompt-detail-schema-keys-list">${currentSchemaFields.map((item, i) => buildSchemaFieldBlockDetail(item, i)).join('')}</div>
          <div class="prompt-output-format-actions">
            <button type="button" class="btn btn-secondary prompt-detail-schema-add-key">+ Create field</button>
          </div>
        </div>
      `;
    const keysListEl = schemaEdit.querySelector('.prompt-detail-schema-keys-list');

    function reRenderSchemaFields() {
      const { returnShape, fields } = getSchemaFromEditContainer();
      currentSchemaFields = fields.length ? fields : [{ key: '', type: 'str', description: '', examples: [], allowNone: false }];
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
      currentSchemaFields.push({ key: '', type: 'str', description: '', examples: [], allowNone: false });
      keysListEl.innerHTML = currentSchemaFields.map((item, idx) => buildSchemaFieldBlockDetail(item, idx)).join('');
      bindSchemaKeyEvents();
    });
    schemaWrap.setAttribute('data-prompt-schema-mode', 'edit');
  }

  schemaBtnEdit.addEventListener('click', showSchemaEdit);
  schemaBtnCancel.addEventListener('click', showSchemaView);
  function hasDuplicateFieldNames(fieldsList) {
    const keys = fieldsList.map((o) => (o.key || '').trim().toLowerCase());
    return keys.length !== new Set(keys).size;
  }

  schemaBtnSave.addEventListener('click', () => {
    const { returnShape, fields } = getSchemaFromEditContainer();
    const normalized = fields.map((o) => ({
      key: o.key || '',
      type: o.type || 'str',
      description: (o.description ?? '').trim() || '',
      examples: (o.examples || []).map((ex) => (Array.isArray(ex) ? ex.slice() : ex)),
      allowNone: o.allowNone === true,
    }));
    const fieldsToSave = normalized.length ? normalized : [{ key: '', type: 'str', description: '', examples: [], allowNone: false }];
    const schemaErrorEl = overlay.querySelector('#prompt-detail-schema-error');
    if (schemaErrorEl) schemaErrorEl.hidden = true;
    const missingFieldName = fieldsToSave.some((f) => !(f.key ?? '').trim());
    if (missingFieldName) {
      if (schemaErrorEl) {
        schemaErrorEl.textContent = 'Field name is required for all fields.';
        schemaErrorEl.hidden = false;
      }
      return;
    }
    const missingFieldDesc = fieldsToSave.some((f) => !(f.description ?? '').trim());
    if (missingFieldDesc) {
      if (schemaErrorEl) {
        schemaErrorEl.textContent = 'Field description is required for all fields.';
        schemaErrorEl.hidden = false;
      }
      return;
    }
    if (hasDuplicateFieldNames(fieldsToSave)) {
      if (schemaErrorEl) {
        schemaErrorEl.textContent = 'Field names must be unique within this prompt. Please fix duplicate field names.';
        schemaErrorEl.hidden = false;
      } else alert('Field names must be unique within this prompt. Please fix duplicate field names.');
      return;
    }
    currentSchemaFields = fieldsToSave;
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
