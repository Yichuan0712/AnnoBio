import { attachModalPaneCycle } from './paneToggleButton.js';
import { openPromptSectionEditor, renderPromptSectionCards } from './promptSectionUi.js';
import { openPromptFieldEditor, renderPromptFieldCards } from './promptSchemaUi.js';

/**
 * Prompt detail modal: view/edit name, description, sections, output schema.
 * @param {{ name?: string, note?: string, sections?: Array<{name:string,content:string}>, node?: HTMLElement | null, isPromptNameAlreadyUsed?: (name: string, excludeNodeId?: string | null) => boolean }} options
 */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Sanitize node name for use as default filename (remove/replace invalid path chars). */
function sanitizeFilename(name) {
  const s = String(name ?? '').replace(/[\r\n/:*?"<>|\\]/g, '_').trim();
  return s || 'prompt';
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
 * Get one row per input key, with all occurrences: { key, sentences: string }.
 * Sentences are newline-separated so multiple occurrences show in one table row.
 */
function getInputsWithSentence(sectionsList) {
  if (!sectionsList || sectionsList.length === 0) return [];
  const re = /\{([^{}]+)\}/g;
  const byKey = {}; // key -> { firstOrder, items: [{ sectionName, sentence }] }
  let order = 0;
  for (let i = 0; i < sectionsList.length; i++) {
    const s = sectionsList[i];
    const sectionName = (s.name || 'Unnamed').trim() || 'Unnamed';
    const content = s.content || '';
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
    const sectionNames = items.map((it) => it.sectionName);
    const sentences = items.map((it) => it.sentence);
    return { key, sectionNames, sentences };
  });
}

function inputsToViewHtml(sectionsList, inputTypes = {}) {
  const rows = getInputsWithSentence(sectionsList);
  if (rows.length === 0) return '<p class="prompt-detail-placeholder">No inputs.</p>';
  const tbody = rows
    .map(
      (r) =>
        `<tr data-input-name="${escapeAttr(r.key)}" data-section-names="${escapeAttr(JSON.stringify(r.sectionNames))}" data-sentences="${escapeAttr(JSON.stringify(r.sentences))}"><td class="prompt-detail-inputs-cell">${escapeHtml(r.key)}</td><td class="prompt-detail-inputs-cell"><select class="prompt-input-type" aria-label="Type for ${escapeAttr(r.key)}"><option value="auto">Auto</option><option value="text" ${inputTypes[r.key] === 'text' ? 'selected' : ''}>Text</option><option value="image" ${inputTypes[r.key] === 'image' ? 'selected' : ''}>Image</option></select></td><td class="prompt-detail-inputs-cell prompt-detail-inputs-cell-multi">${escapeHtml(r.sentences.join('\n'))}</td></tr>`
    )
    .join('');
  return `<div class="prompt-detail-inputs-table-wrap">
  <table class="prompt-detail-inputs-table">
    <thead><tr><th>Input</th><th>Type</th><th>Sentence</th></tr></thead>
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

function readSavedPromptSnapshotFromNode(node) {
  if (!node) return null;
  let name = (node.dataset.promptName || '').trim();
  if (!name) {
    name = (node.querySelector('.workflow-node__title')?.textContent || '').trim();
  }
  if (!name) name = 'Prompt';
  const note = (node.dataset.promptNote || '').trim();
  let sections = [];
  try {
    const raw = JSON.parse(node.dataset.promptSections || node.dataset.promptFields || '[]');
    sections = Array.isArray(raw) ? raw.map((s) => ({ name: s?.name || '', content: s?.content || '' })) : [];
  } catch (_) {
    sections = [];
  }
  let fields = [];
  let returnShape = 'single';
  try {
    const raw = JSON.parse(node.dataset.promptOutputFormat || '[]');
    fields = Array.isArray(raw)
      ? raw.map((o) => ({
          key: o.key || '',
          type: o.type || 'str',
          description: o.description ?? '',
          examples: o.examples || [],
          allowNone: o.allowNone === true,
        }))
      : [];
    returnShape = node.dataset.promptOutputReturnShape || 'single';
  } catch (_) {
    fields = [];
    returnShape = node.dataset.promptOutputReturnShape || 'single';
  }
  return { name, note, sections, returnShape, fields };
}

/** Run row template: non-empty trimmed section contents, \\n\\n joined (same as runDetailModal). */
function buildRunTemplateTextForExport(sections) {
  return (Array.isArray(sections) ? sections : [])
    .map((s) => String(s?.content ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Save to local: run template + suffix matching backend/llm.py::_run_structured_fallback (approx. JSON Schema).
 */
function buildPromptExportText(snapshot) {
  const runTemplate = buildRunTemplateTextForExport(snapshot.sections);
  const shape = String(snapshot.returnShape || 'single').trim().toLowerCase() === 'table' ? 'table' : 'single';
  const typeMap = {
    str: { type: 'string' },
    float: { type: 'number' },
    list_str: { type: 'array', items: { type: 'string' } },
    list_float: { type: 'array', items: { type: 'number' } },
  };
  const seen = new Set();
  const prepared = [];
  for (const f of snapshot.fields || []) {
    const dk = (f.key || '').trim() || 'field';
    let name = dk.replace(/[^\w]/g, '_') || 'field';
    if (seen.has(name)) {
      let n = 1;
      while (seen.has(`${name}_${n}`)) n += 1;
      name = `${name}_${n}`;
    }
    seen.add(name);
    let t = String(f.type || 'str').trim().toLowerCase();
    if (!typeMap[t]) t = 'str';
    const desc = String(f.description ?? '').trim() || dk;
    const opt = f.allowNone === true || f.allow_none === true;
    prepared.push({ name, t, desc, opt });
  }

  let instruction;
  if (prepared.length === 0) {
    instruction = '\n\n(No output_schema.fields — Run API would reject before LLM.)';
  } else {
    const properties = {};
    const required = [];
    for (const p of prepared) {
      const base = { ...typeMap[p.t] };
      if (p.opt) {
        properties[p.name] = { anyOf: [base, { type: 'null' }], default: null, description: p.desc };
      } else {
        properties[p.name] = { ...base, description: p.desc };
        required.push(p.name);
      }
    }
    const rowSchema = {
      title: 'StructuredOutput',
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
    };
    if (shape === 'table') {
      instruction =
        '\n\nRespond with a single valid JSON array of objects. Each object must conform to the following schema. ' +
        'Return only the JSON array, no other text or markdown.\nSchema for each item:\n' +
        JSON.stringify(rowSchema, null, 2);
    } else {
      instruction =
        '\n\nRespond with a single valid JSON object that conforms to the following schema. ' +
        'Return only the JSON, no other text or markdown.\nSchema:\n' +
        JSON.stringify(rowSchema, null, 2);
    }
  }

  const fullUser = runTemplate + instruction;
  return fullUser.replace(/\n/g, '\r\n');
}

function hasPromptExportBlockingOverlayOpen() {
  if (document.querySelector('.modal-overlay--edit-sections, .modal-overlay--edit-schema')) return true;
  if (document.querySelector('.modal-overlay--field-editor')) return true;
  for (const el of document.querySelectorAll('.modal-overlay--section-editor')) {
    if (el.classList.contains('modal-overlay--rule-editor')) continue;
    return true;
  }
  return false;
}

export function openPromptDetailModal({ name = '', note = '', sections = [], node: sourceNode = null, isPromptNameAlreadyUsed, onRunPrompt }) {
  const displayName = (name && name.trim()) ? name.trim() : 'Prompt';
  const noteTrimmed = (note || '').trim();
  const sectionsViewHtml = sectionsToViewHtml(sections);

  let outputFormat = { returnShape: 'table', fields: [] };
  let inputTypes = {};
  if (sourceNode) {
    try {
      const raw = JSON.parse(sourceNode.dataset.promptOutputFormat || '[]');
      const fields = (Array.isArray(raw) ? raw : []).map((o) => ({ key: o.key || '', type: o.type || 'str', description: o.description ?? '', examples: o.examples || [], allowNone: o.allowNone === true }));
      outputFormat = { returnShape: sourceNode.dataset.promptOutputReturnShape || 'table', fields };
    } catch (_) {}
    try { inputTypes = JSON.parse(sourceNode.dataset.promptInputTypes || '{}'); } catch (_) {}
  }
  const inputsViewHtml = inputsToViewHtml(sections, inputTypes);
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
                <button type="button" class="btn btn-secondary prompt-detail-export-local">Save to local</button>
                <div class="prompt-actions__trailing">
                  <button type="button" class="btn btn-secondary prompt-detail-sections-btn-edit">Edit</button>
                  <button type="button" class="btn btn-primary prompt-detail-sections-btn-run" id="prompt-detail-sections-btn-run">Run</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

  const panel = overlay.querySelector('.modal-panel--prompt-detail');
  function bindInputTypeControls() {
    overlay.querySelectorAll('.prompt-input-type').forEach((select) => {
      select.addEventListener('change', () => {
        const key = select.closest('tr')?.dataset?.inputName;
        if (!key) return;
        if (select.value === 'auto') delete inputTypes[key];
        else inputTypes[key] = select.value;
        if (sourceNode) sourceNode.dataset.promptInputTypes = JSON.stringify(inputTypes);
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      });
    });
  }
  bindInputTypeControls();
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

  const exportLocalBtn = overlay.querySelector('.prompt-detail-export-local');

  function syncPromptExportLocalEnabled() {
    if (!exportLocalBtn) return;
    const noNode = !sourceNode;
    const nameNoteEditing = panel.getAttribute('data-prompt-detail-mode') === 'edit';
    const childBlocking = hasPromptExportBlockingOverlayOpen();
    exportLocalBtn.disabled = noNode || nameNoteEditing || childBlocking;
  }

  const exportOverlayObserver = new MutationObserver(() => syncPromptExportLocalEnabled());
  exportOverlayObserver.observe(document.body, { childList: true });

  function teardownPromptDetailModal() {
    exportOverlayObserver.disconnect();
    overlay.remove();
    document.body.style.overflow = '';
  }

  function showView() {
    panel.setAttribute('data-prompt-detail-mode', 'view');
    syncPromptExportLocalEnabled();
  }

  function showEdit() {
    nameInp.value = nameValueEl.textContent.trim() || '';
    notesInp.value = notesValueEl.querySelector('.prompt-detail-placeholder') ? '' : (notesValueEl.textContent || '').trim();
    panel.setAttribute('data-prompt-detail-mode', 'edit');
    syncPromptExportLocalEnabled();
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

  if (exportLocalBtn) {
    exportLocalBtn.addEventListener('click', async () => {
      const snapshot = readSavedPromptSnapshotFromNode(sourceNode);
      if (!snapshot) return;
      const defaultBase = sanitizeFilename(snapshot.name);
      const payload = buildPromptExportText(snapshot);
      const api = window.electronAPI;
      let path;
      if (api?.showSaveFileDialog && api?.writeFile) {
        path = await api.showSaveFileDialog({
          title: 'Save prompt',
          defaultPath: `${defaultBase}.txt`,
          filters: [{ name: 'Text file', extensions: ['txt'] }],
        });
      }
      if (!path && !api?.showSaveFileDialog) {
        path = `${defaultBase}.txt`;
      }
      if (path) {
        if (api?.writeFile) {
          await api.writeFile(path, payload, 'utf8');
        } else {
          const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = path.split(/[/\\]/).pop() || `${defaultBase}.txt`;
          a.click();
          URL.revokeObjectURL(a.href);
        }
      }
    });
  }

  let currentSections = Array.isArray(sections) ? sections.map((s) => ({ name: s.name || '', content: s.content || '' })) : [];
  const sectionsView = overlay.querySelector('.prompt-detail-sections-view');
  const sectionsBtnEdit = overlay.querySelector('.prompt-detail-sections-btn-edit');

  function hasDuplicateSectionNames(sectionsList) {
    const names = sectionsList.map((s) => (s.name || '').trim().toLowerCase()).filter(Boolean);
    return names.length !== new Set(names).size;
  }

  function openEditSectionsOverlay() {
    const editSections = currentSections.map((s) => ({ name: s.name || '', content: s.content || '' }));
    const editOverlay = document.createElement('div');
    editOverlay.className = 'modal-overlay modal-overlay--edit-sections';
    editOverlay.setAttribute('aria-modal', 'true');
    editOverlay.innerHTML = `
      <div class="modal-panel modal-panel--edit-sections">
        <div class="modal-header">
          <h2 class="modal-title">Edit prompt sections</h2>
          <button type="button" class="modal-close modal-close--edit-sections" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <div class="prompt-main prompt-main--edit-sections">
            <div class="prompt-step prompt-step-2" style="display: flex;">
              <p class="prompt-hint">Click a section to edit it, or use × to remove it.</p>
              <div class="prompt-step-scroll prompt-step-2-scroll">
                <div class="prompt-sections prompt-sections--edit"></div>
                <div class="prompt-add-section-wrap">
                  <button type="button" class="btn btn-secondary prompt-add-section">+ Add a section</button>
                </div>
              </div>
              <div class="prompt-form-error prompt-modal-error edit-sections-error" role="alert" aria-live="polite" hidden></div>
            </div>
          </div>
        </div>
      </div>
    `;
    const container = editOverlay.querySelector('.prompt-sections--edit');
    const addBtn = editOverlay.querySelector('.prompt-add-section');
    const errorEl = editOverlay.querySelector('.edit-sections-error');

    function onSectionChange() {
      renderSectionsList();
      persistSections();
    }

    function renderSectionsList() {
      renderPromptSectionCards({
        sections: editSections,
        container,
        onChange: onSectionChange,
      });
    }

    function close() {
      editOverlay.remove();
      syncPromptExportLocalEnabled();
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

    function persistSections() {
      const withContent = editSections.filter((s) => (s.name || '').trim() && (s.content ?? '').trim());
      const hasPartial = editSections.some((s) => {
        const n = (s.name || '').trim();
        const c = (s.content ?? '').trim();
        return (n || c) && (!n || !c);
      });
      if (hasPartial) {
        showError('Section name and content are required for each section.');
        return false;
      }
      if (withContent.length === 0) {
        showError('At least one section with name and content is required.');
        return false;
      }
      if (hasDuplicateSectionNames(withContent)) {
        showError('Section names must be unique within this prompt. Please fix duplicate section names.');
        return false;
      }
      currentSections = withContent;
      if (sourceNode) sourceNode.dataset.promptSections = JSON.stringify(currentSections);
      sectionsView.innerHTML = sectionsToViewHtml(currentSections.length ? currentSections : []);
      const inputsContentEl = overlay.querySelector('.prompt-detail-inputs-content');
      if (inputsContentEl) {
        const currentNames = new Set(extractInputFieldsFromSections(currentSections));
        Object.keys(inputTypes).forEach((key) => { if (!currentNames.has(key)) delete inputTypes[key]; });
        if (sourceNode) sourceNode.dataset.promptInputTypes = JSON.stringify(inputTypes);
        inputsContentEl.innerHTML = inputsToViewHtml(currentSections, inputTypes);
        bindInputTypeControls();
      }
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      return true;
    }

    editOverlay.querySelector('.modal-close--edit-sections').addEventListener('click', close);

    addBtn.addEventListener('click', () => {
      openPromptSectionEditor({
        sections: editSections,
        onDone: onSectionChange,
      });
    });

    renderSectionsList();
    document.body.appendChild(editOverlay);
    syncPromptExportLocalEnabled();
  }

  if (sectionsBtnEdit) {
    sectionsBtnEdit.addEventListener('click', () => openEditSectionsOverlay());
  }

  const sectionsBtnRun = overlay.querySelector('.prompt-detail-sections-btn-run');
  if (sectionsBtnRun && onRunPrompt) {
    sectionsBtnRun.addEventListener('click', () => {
      onRunPrompt();
      teardownPromptDetailModal();
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
      let sectionNames = [];
      let sentences = [];
      try {
        sectionNames = JSON.parse(row.dataset.sectionNames || '[]');
        sentences = JSON.parse(row.dataset.sentences || '[]');
      } catch (_) {
        return;
      }
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

  function hasDuplicateFieldNames(fieldsList) {
    const keys = fieldsList.map((o) => (o.key || '').trim().toLowerCase());
    return keys.length !== new Set(keys).size;
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
              <p class="prompt-hint">Click a field to edit it, use × to remove it, and close the field editor to save.</p>
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
      renderPromptFieldCards({
        fields: editSchemaFields,
        container: keysListEl,
        outputTypes: OUTPUT_TYPES,
        onChange: () => {
          renderSchemaCards();
          persistToNode();
        },
      });
    }

    const addFieldBtn = formContainer.querySelector('.prompt-output-add-key');
    if (addFieldBtn) {
      addFieldBtn.addEventListener('click', () => {
        openPromptFieldEditor({
          fields: editSchemaFields,
          outputTypes: OUTPUT_TYPES,
          onDone: () => {
            renderSchemaCards();
            persistToNode();
          },
        });
      });
    }

    if (returnShapeSingle) returnShapeSingle.addEventListener('change', () => persistToNode());
    if (returnShapeTable) returnShapeTable.addEventListener('change', () => persistToNode());

    function close() {
      schemaOverlay.remove();
      syncPromptExportLocalEnabled();
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

    function persistToNode() {
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
        return false;
      }
      const missingFieldName = fieldsToSave.some((f) => !(f.key ?? '').trim());
      if (missingFieldName) {
        showError('Field name is required for all fields.');
        return false;
      }
      const missingFieldDesc = fieldsToSave.some((f) => !(f.description ?? '').trim());
      if (missingFieldDesc) {
        showError('Field description is required for all fields.');
        return false;
      }
      if (hasDuplicateFieldNames(fieldsToSave)) {
        showError('Field names must be unique within this prompt. Please fix duplicate field names.');
        return false;
      }
      currentSchemaFields = fieldsToSave;
      currentSchemaReturnShape = returnShape;
      if (sourceNode) {
        sourceNode.dataset.promptOutputFormat = JSON.stringify(currentSchemaFields);
        sourceNode.dataset.promptOutputReturnShape = currentSchemaReturnShape;
      }
      schemaView.innerHTML = schemaToViewHtml(currentSchemaFields, currentSchemaReturnShape);
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      return true;
    }

    schemaOverlay.querySelector('.modal-close--edit-schema').addEventListener('click', close);

    renderSchemaCards();
    document.body.appendChild(schemaOverlay);
    syncPromptExportLocalEnabled();
  }

  if (schemaBtnEdit) {
    schemaBtnEdit.addEventListener('click', () => openEditSchemaOverlay());
  }

  attachModalPaneCycle({
    overlay,
    bothLabel: 'Show both panels',
    leftOnlyLabel: 'Show prompt inputs panel only',
    rightOnlyLabel: 'Show prompt sections panel only',
  });

  overlay.querySelector('.modal-close').addEventListener('click', () => {
    teardownPromptDetailModal();
  });
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  syncPromptExportLocalEnabled();
}
