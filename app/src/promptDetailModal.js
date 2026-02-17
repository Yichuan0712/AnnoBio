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

const PROMPT_INPUT_SENTENCE_MAX_LEN = 120;

/**
 * Get the line (sentence) containing the match at content[matchStart:matchEnd], trimmed and truncated.
 */
function getSentenceAround(content, matchStart, matchEnd) {
  const lineStart = content.lastIndexOf('\n', matchStart - 1) + 1;
  let lineEnd = content.indexOf('\n', matchEnd);
  if (lineEnd === -1) lineEnd = content.length;
  let sentence = content.slice(lineStart, lineEnd).trim();
  if (sentence.length > PROMPT_INPUT_SENTENCE_MAX_LEN) {
    sentence = sentence.slice(0, PROMPT_INPUT_SENTENCE_MAX_LEN) + '…';
  }
  return sentence;
}

/**
 * Get one row per input key, with all occurrences: { key, sections: string, sentences: string }
 * sections and sentences are newline-separated so multiple occurrences show in one table row.
 */
function getInputsWithSectionAndSentence(sectionsList) {
  if (!sectionsList || sectionsList.length === 0) return [];
  const re = /\{([^{}]+)\}/g;
  const byKey = {}; // key -> { firstOrder, items: [{ sectionName, sentence }] }
  let order = 0;
  for (let i = 0; i < sectionsList.length; i++) {
    const s = sectionsList[i];
    const content = s.content || '';
    const sectionName = (s.name || '').trim() || 'Unnamed';
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const charBefore = m.index > 0 ? content[m.index - 1] : '';
      const charAfter = m.index + m[0].length < content.length ? content[m.index + m[0].length] : '';
      if (charBefore === '{' || charAfter === '}') continue;
      const key = m[1].trim();
      if (!key) continue;
      if (!byKey[key]) byKey[key] = { firstOrder: order++, items: [] };
      const sentence = getSentenceAround(content, m.index, m.index + m[0].length);
      byKey[key].items.push({ sectionName, sentence });
    }
  }
  const keysOrdered = Object.keys(byKey).sort((a, b) => byKey[a].firstOrder - byKey[b].firstOrder);
  return keysOrdered.map((key) => {
    const items = byKey[key].items;
    const sections = items.map((it) => it.sectionName).join('\n');
    const sentences = items.map((it) => it.sentence).join('\n');
    return { key, sections, sentences };
  });
}

function inputsToViewHtml(sectionsList) {
  const rows = getInputsWithSectionAndSentence(sectionsList);
  if (rows.length === 0) return '<p class="prompt-detail-placeholder">No inputs.</p>';
  const tbody = rows
    .map(
      (r) =>
        `<tr><td class="prompt-detail-inputs-cell">${escapeHtml(r.key)}</td><td class="prompt-detail-inputs-cell prompt-detail-inputs-cell-multi">${escapeHtml(r.sections)}</td><td class="prompt-detail-inputs-cell prompt-detail-inputs-cell-multi">${escapeHtml(r.sentences)}</td></tr>`
    )
    .join('');
  return `<div class="prompt-detail-inputs-table-wrap">
  <table class="prompt-detail-inputs-table" aria-readonly="true">
    <thead><tr><th>Input</th><th>Section</th><th>Sentence</th></tr></thead>
    <tbody>${tbody}</tbody>
  </table>
</div>`;
}

function sectionsToViewHtml(sectionsList) {
  if (!sectionsList || sectionsList.length === 0) return '<p class="prompt-detail-placeholder">No sections.</p>';
  return sectionsList
    .map((s) => {
      const sectionName = s.name || 'Unnamed';
      const content = s.content || '';
      const lines = content.split('\n');
      const lineEls =
        lines.length > 0
          ? lines.map((line) => `<div class="preview-field-content-line">${escapeHtml(line)}</div>`).join('')
          : '<div class="preview-field-content-line"></div>';
      return `
          <div class="preview-field-block">
            <div class="preview-field-divider">
              <span class="preview-field-line" aria-hidden="true"></span>
              <span class="preview-field-name">${escapeHtml(sectionName)}</span>
              <span class="preview-field-line" aria-hidden="true"></span>
            </div>
            <div class="preview-field-content">${lineEls}</div>
          </div>
        `;
    })
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

export function openPromptDetailModal({ name = '', note = '', sections = [], node: sourceNode = null, isPromptNameAlreadyUsed, onRunPrompt }) {
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
          <h2 id="prompt-detail-title" class="modal-title">Prompt: ${escapeHtml(displayName)}</h2>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body prompt-detail-body">
          <div class="prompt-detail-side prompt-preview-wrap">
            <div class="prompt-detail-side-scroll">
              <h3 class="prompt-preview-title">Prompt inputs</h3>
              <div class="prompt-detail-inputs-content prompt-preview">${inputsViewHtml}</div>
              <h3 class="prompt-preview-title">Output schema</h3>
              <div class="prompt-detail-schema-wrap">
                <div class="prompt-detail-schema-view">${schemaViewHtml}</div>
                <div class="prompt-detail-schema-footer">
                  <div class="prompt-detail-inline-error" id="prompt-detail-schema-error" role="alert" aria-live="polite" hidden></div>
                  <button type="button" class="btn btn-secondary prompt-detail-schema-btn-edit">Edit</button>
                </div>
              </div>
            </div>
          </div>
          <div class="prompt-detail-main">
            <div class="prompt-detail-step">
              <p class="prompt-step-label">Prompt sections</p>
              <div class="prompt-detail-sections-scroll">
                <div class="prompt-detail-sections-wrap">
                  <div class="prompt-detail-sections-view">${sectionsViewHtml}</div>
                </div>
              </div>
              <div class="prompt-form-error prompt-modal-error" id="prompt-detail-sections-error" role="alert" aria-live="polite" hidden></div>
              <div class="prompt-actions">
                <button type="button" class="btn btn-secondary prompt-detail-sections-btn-edit">Edit</button>
                <button type="button" class="btn btn-primary prompt-detail-sections-btn-run" id="prompt-detail-sections-btn-run">Run</button>
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

  if (btnEdit) {
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
  }

  let currentSections = Array.isArray(sections) ? sections.map((s) => ({ name: s.name || '', content: s.content || '' })) : [];
  const sectionsView = overlay.querySelector('.prompt-detail-sections-view');
  const sectionsBtnEdit = overlay.querySelector('.prompt-detail-sections-btn-edit');

  function hasDuplicateSectionNames(sectionsList) {
    const names = sectionsList.map((s) => (s.name || '').trim().toLowerCase()).filter(Boolean);
    return names.length !== new Set(names).size;
  }

  function openSectionEditorForDetail(editSections, sectionIndex, onDone) {
    const isEdit = sectionIndex !== null && sectionIndex >= 0;
    const section = isEdit ? editSections[sectionIndex] : { name: '', content: '' };
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
      const otherNames = editSections
        .map((s, i) => (i === sectionIndex ? null : (s.name || '').trim().toLowerCase()))
        .filter(Boolean);
      if (otherNames.includes(name.toLowerCase())) {
        showError('This section name is already used. Please choose another.');
        return;
      }
      if (isEdit) {
        editSections[sectionIndex] = { name, content };
      } else {
        editSections.push({ name, content });
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

  function createSectionCardForDetail(section, index, editSections, containerEl, onRender) {
    const card = document.createElement('div');
    card.className = 'prompt-section-card';
    const displayName = (section.name || '').trim() || 'Unnamed section';
    const openEditor = () =>
      openSectionEditorForDetail(editSections, index, () => onRender());
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
      editSections.splice(index, 1);
      onRender();
    });
    return card;
  }

  function openEditSectionsOverlay() {
    const editSections = currentSections.map((s) => ({ name: s.name || '', content: s.content || '' }));
    const editOverlay = document.createElement('div');
    editOverlay.className = 'modal-overlay modal-overlay--edit-sections';
    editOverlay.setAttribute('aria-modal', 'true');
    editOverlay.innerHTML = `
      <div class="modal-panel modal-panel--edit-sections">
        <div class="modal-header">
          <h2 class="modal-title">Edit sections</h2>
          <button type="button" class="modal-close modal-close--edit-sections" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <div class="prompt-main prompt-main--edit-sections">
            <div class="prompt-step prompt-step-2" style="display: flex;">
              <p class="prompt-hint">Choose a section to edit, add a new section, or delete one.</p>
              <div class="prompt-step-scroll prompt-step-2-scroll">
                <div class="prompt-sections prompt-sections--edit"></div>
                <div class="prompt-add-section-wrap">
                  <button type="button" class="btn btn-secondary prompt-add-section">+ Add a section</button>
                </div>
              </div>
              <div class="prompt-form-error prompt-modal-error edit-sections-error" role="alert" aria-live="polite" hidden></div>
              <div class="prompt-actions">
                <button type="button" class="btn btn-secondary edit-sections-cancel">Cancel</button>
                <button type="button" class="btn btn-secondary edit-sections-save">Save</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    const container = editOverlay.querySelector('.prompt-sections--edit');
    const addBtn = editOverlay.querySelector('.prompt-add-section');
    const errorEl = editOverlay.querySelector('.edit-sections-error');

    function renderSectionsList() {
      container.innerHTML = '';
      editSections.forEach((section, index) => container.appendChild(createSectionCardForDetail(section, index, editSections, container, renderSectionsList)));
    }

    function close() {
      editOverlay.remove();
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
      const withContent = editSections.filter((s) => (s.name || '').trim() && (s.content ?? '').trim());
      const hasPartial = editSections.some((s) => {
        const n = (s.name || '').trim();
        const c = (s.content ?? '').trim();
        return (n || c) && (!n || !c);
      });
      if (hasPartial) {
        showError('Section name and content are required for each section.');
        return;
      }
      if (withContent.length === 0) {
        showError('At least one section with name and content is required.');
        return;
      }
      if (hasDuplicateSectionNames(withContent)) {
        showError('Section names must be unique within this prompt. Please fix duplicate section names.');
        return;
      }
      currentSections = withContent;
      if (sourceNode) sourceNode.dataset.promptSections = JSON.stringify(currentSections);
      sectionsView.innerHTML = sectionsToViewHtml(currentSections.length ? currentSections : []);
      const inputsContentEl = overlay.querySelector('.prompt-detail-inputs-content');
      if (inputsContentEl) inputsContentEl.innerHTML = inputsToViewHtml(currentSections);
      close();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }

    editOverlay.querySelector('.modal-close--edit-sections').addEventListener('click', close);
    editOverlay.querySelector('.edit-sections-cancel').addEventListener('click', close);
    editOverlay.querySelector('.edit-sections-save').addEventListener('click', save);
    addBtn.addEventListener('click', () => {
      openSectionEditorForDetail(editSections, null, renderSectionsList);
    });
    editOverlay.addEventListener('click', (e) => {
      if (e.target === editOverlay) close();
    });

    renderSectionsList();
    document.body.appendChild(editOverlay);
  }

  if (sectionsBtnEdit) {
    sectionsBtnEdit.addEventListener('click', () => openEditSectionsOverlay());
  }

  const sectionsBtnRun = overlay.querySelector('.prompt-detail-sections-btn-run');
  if (sectionsBtnRun && onRunPrompt) {
    sectionsBtnRun.addEventListener('click', () => {
      onRunPrompt();
      overlay.remove();
      document.body.style.overflow = '';
    });
  } else if (sectionsBtnRun) {
    sectionsBtnRun.style.display = 'none';
  }

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

  const inputsContent = overlay.querySelector('.prompt-detail-inputs-content');
  if (inputsContent && sectionsView) {
    function clearLineHighlight() {
      sectionsView.querySelectorAll('.preview-field-content-line.prompt-detail-line-highlight').forEach((el) => el.classList.remove('prompt-detail-line-highlight'));
    }
    function sentenceMatchesLine(sentence, lineText) {
      const s = (sentence || '').trim();
      const l = (lineText || '').trim();
      if (s === l) return true;
      if (s.endsWith('…') && l.startsWith(s.slice(0, -1))) return true;
      if (l.startsWith(s)) return true;
      return false;
    }
    function highlightSentencesForRow(row) {
      const sectionCell = row.querySelector('td:nth-child(2)');
      const sentenceCell = row.querySelector('td:nth-child(3)');
      if (!sectionCell || !sentenceCell) return;
      const sectionNames = (sectionCell.textContent || '').split('\n').map((s) => s.trim());
      const sentences = (sentenceCell.textContent || '').split('\n').map((s) => s.trim());
      clearLineHighlight();
      sectionsView.querySelectorAll('.preview-field-block').forEach((block) => {
        const nameEl = block.querySelector('.preview-field-name');
        const name = (nameEl ? (nameEl.textContent || '').trim() : '') || 'Unnamed';
        const lineEls = block.querySelectorAll('.preview-field-content-line');
        sectionNames.forEach((sec, i) => {
          if (sec !== name) return;
          const sentence = sentences[i];
          if (sentence == null) return;
          lineEls.forEach((lineEl) => {
            const lineText = (lineEl.textContent || '').trim();
            if (sentenceMatchesLine(sentence, lineText)) lineEl.classList.add('prompt-detail-line-highlight');
          });
        });
      });
    }
    inputsContent.addEventListener('mouseover', (e) => {
      const row = e.target.closest('.prompt-detail-inputs-table tbody tr');
      if (row) highlightSentencesForRow(row);
      else clearLineHighlight();
    });
    inputsContent.addEventListener('mouseout', (e) => {
      const row = e.target.closest('.prompt-detail-inputs-table tbody tr');
      const related = e.relatedTarget;
      if (row && related && row.contains(related)) return;
      if (related && inputsContent.contains(related) && related.closest('.prompt-detail-inputs-table tbody tr')) return;
      clearLineHighlight();
    });
  }

  const schemaBtnEdit = overlay.querySelector('.prompt-detail-schema-btn-edit');

  /* Field editor modal helpers (same as Add prompt step 3) */
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

  function openFieldEditorForDetail(editSchemaFields, fieldIndex, onDone) {
    const isEdit = fieldIndex !== null && fieldIndex >= 0;
    const field = isEdit ? editSchemaFields[fieldIndex] : { key: '', type: 'str', description: '', examples: [], allowNone: false };
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
      return Array.from(rows)
        .map((row) => {
          const inp = row.querySelector('.field-editor-scalar-inp');
          const raw = (inp?.value ?? '').trim();
          return isFloat ? (raw === '' ? null : Number(raw)) : raw;
        })
        .filter((v) => v !== null && v !== '');
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
      scalarRowsContainer.querySelectorAll('.field-editor-scalar-del').forEach((btn) => btn.replaceWith(btn.cloneNode(true)));
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
      scalarRowsContainer.querySelectorAll('.field-editor-scalar-row').forEach((row, i) => {
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
      listRowsContainer.querySelectorAll('.field-editor-add-element').forEach((btn) => btn.replaceWith(btn.cloneNode(true)));
      listRowsContainer.querySelectorAll('.field-editor-del-example').forEach((btn) => btn.replaceWith(btn.cloneNode(true)));
      listRowsContainer.querySelectorAll('.field-editor-del-element').forEach((btn) => btn.replaceWith(btn.cloneNode(true)));
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
        btn.addEventListener('click', () => {
          const block = listRowsContainer.querySelector(`.field-editor-list-example-block[data-ex-index="${btn.getAttribute('data-ex-index')}"]`);
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
      listRowsContainer.querySelectorAll('.field-editor-list-example-block').forEach((block, i) => {
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
        let examples = prevList ? readListExamplesFromDOM() : readScalarExamplesFromDOM().map((v) => (Array.isArray(v) ? v : [v]));
        examplesScalarWrap.style.display = 'none';
        examplesListWrap.style.display = '';
        buildListExamplesUI(typeVal, examples);
      } else {
        const prevList = examplesListWrap.style.display !== 'none';
        let scalarExamples = prevList
          ? readListExamplesFromDOM().map((arr) => (Array.isArray(arr) && arr.length ? (typeVal === 'float' ? arr[0] : arr.join(', ')) : ''))
          : readScalarExamplesFromDOM();
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
      const otherKeys = editSchemaFields
        .map((o, i) => (i === fieldIndex ? null : (o.key || '').trim().toLowerCase()))
        .filter(Boolean);
      if (otherKeys.includes(key.toLowerCase())) {
        showError('This field name is already used. Please choose another.');
        return;
      }
      const payload = { key, type: typeVal, description, examples, allowNone };
      if (isEdit) {
        editSchemaFields[fieldIndex] = payload;
      } else {
        editSchemaFields.push(payload);
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

  function hasDuplicateFieldNames(fieldsList) {
    const keys = fieldsList.map((o) => (o.key || '').trim().toLowerCase());
    return keys.length !== new Set(keys).size;
  }

  function createFieldCardForDetail(field, index, editSchemaFields, onRender) {
    const card = document.createElement('div');
    card.className = 'prompt-output-field-card';
    const displayName = (field.key || '').trim() || 'Unnamed field';
    const openEditor = () =>
      openFieldEditorForDetail(editSchemaFields, index, onRender);
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
      editSchemaFields.splice(index, 1);
      onRender();
    });
    return card;
  }

  function openEditSchemaOverlay() {
    const editSchemaFields = currentSchemaFields.map((o) => ({
      key: o.key || '',
      type: o.type || 'str',
      description: o.description ?? '',
      examples: (o.examples || []).map((ex) => (Array.isArray(ex) ? ex.slice() : ex)),
      allowNone: o.allowNone === true,
    }));
    let editSchemaReturnShape = currentSchemaReturnShape;
    const schemaOverlay = document.createElement('div');
    schemaOverlay.className = 'modal-overlay modal-overlay--edit-schema';
    schemaOverlay.setAttribute('aria-modal', 'true');
    schemaOverlay.innerHTML = `
      <div class="modal-panel modal-panel--edit-schema">
        <div class="modal-header">
          <h2 class="modal-title">Edit output schema</h2>
          <button type="button" class="modal-close modal-close--edit-schema" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <div class="prompt-main prompt-main--edit-schema">
            <div class="prompt-step prompt-step-3" style="display: flex;">
              <p class="prompt-hint">The LLM will return items with these fields. Add a field, then add example values for that field.</p>
              <div class="edit-schema-form">
                <div class="prompt-output-return-shape-wrap">
                  <span class="prompt-output-return-shape-label">Return shape:</span>
                  <label class="prompt-output-return-shape-option"><input type="radio" name="prompt-detail-schema-return-shape" value="single" /> Single row</label>
                  <label class="prompt-output-return-shape-option"><input type="radio" name="prompt-detail-schema-return-shape" value="table" /> Multiple rows</label>
                </div>
                <div class="prompt-output-format-wrap">
                  <div class="prompt-step-3-format-scroll">
                    <div class="prompt-output-keys-list"></div>
                  </div>
                  <div class="prompt-add-field-wrap">
                    <button type="button" class="btn btn-secondary prompt-output-add-key">+ Add a field</button>
                  </div>
                </div>
              </div>
              <div class="prompt-form-error prompt-modal-error edit-schema-error" role="alert" aria-live="polite" hidden></div>
              <div class="prompt-actions">
                <button type="button" class="btn btn-secondary edit-schema-cancel">Cancel</button>
                <button type="button" class="btn btn-secondary edit-schema-save">Save</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    const formContainer = schemaOverlay.querySelector('.edit-schema-form');
    const keysListEl = formContainer.querySelector('.prompt-output-keys-list');
    const returnShapeSingle = formContainer.querySelector('input[name="prompt-detail-schema-return-shape"][value="single"]');
    const returnShapeTable = formContainer.querySelector('input[name="prompt-detail-schema-return-shape"][value="table"]');
    if (editSchemaReturnShape === 'single') {
      if (returnShapeSingle) returnShapeSingle.checked = true;
    } else {
      if (returnShapeTable) returnShapeTable.checked = true;
    }
    const errorEl = schemaOverlay.querySelector('.edit-schema-error');

    function renderSchemaCards() {
      keysListEl.innerHTML = '';
      editSchemaFields.forEach((field, index) => {
        keysListEl.appendChild(createFieldCardForDetail(field, index, editSchemaFields, renderSchemaCards));
      });
    }

    const addFieldBtn = formContainer.querySelector('.prompt-output-add-key');
    if (addFieldBtn) {
      addFieldBtn.addEventListener('click', () => {
        openFieldEditorForDetail(editSchemaFields, null, renderSchemaCards);
      });
    }

    function close() {
      schemaOverlay.remove();
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

    schemaOverlay.querySelector('.modal-close--edit-schema').addEventListener('click', close);
    schemaOverlay.querySelector('.edit-schema-cancel').addEventListener('click', close);
    schemaOverlay.querySelector('.edit-schema-save').addEventListener('click', () => {
      const returnShapeEl = formContainer.querySelector('input[name="prompt-detail-schema-return-shape"]:checked');
      const returnShape = (returnShapeEl?.value || 'table') === 'single' ? 'single' : 'table';
      const fieldsToSave = editSchemaFields.length
        ? editSchemaFields.map((o) => ({
            key: o.key || '',
            type: o.type || 'str',
            description: (o.description ?? '').trim() || '',
            examples: (o.examples || []).map((ex) => (Array.isArray(ex) ? ex.slice() : ex)),
            allowNone: o.allowNone === true,
          }))
        : [];
      clearError();
      if (fieldsToSave.length === 0) {
        showError('Add at least one field.');
        return;
      }
      const missingFieldName = fieldsToSave.some((f) => !(f.key ?? '').trim());
      if (missingFieldName) {
        showError('Field name is required for all fields.');
        return;
      }
      const missingFieldDesc = fieldsToSave.some((f) => !(f.description ?? '').trim());
      if (missingFieldDesc) {
        showError('Field description is required for all fields.');
        return;
      }
      if (hasDuplicateFieldNames(fieldsToSave)) {
        showError('Field names must be unique within this prompt. Please fix duplicate field names.');
        return;
      }
      currentSchemaFields = fieldsToSave;
      currentSchemaReturnShape = returnShape;
      if (sourceNode) {
        sourceNode.dataset.promptOutputFormat = JSON.stringify(currentSchemaFields);
        sourceNode.dataset.promptOutputReturnShape = currentSchemaReturnShape;
      }
      schemaView.innerHTML = schemaToViewHtml(currentSchemaFields, currentSchemaReturnShape);
      close();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    });
    schemaOverlay.addEventListener('click', (e) => {
      if (e.target === schemaOverlay) close();
    });

    renderSchemaCards();
    document.body.appendChild(schemaOverlay);
  }

  if (schemaBtnEdit) {
    schemaBtnEdit.addEventListener('click', () => openEditSchemaOverlay());
  }

  overlay.querySelector('.modal-close').addEventListener('click', () => {
    overlay.remove();
    document.body.style.overflow = '';
  });
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
