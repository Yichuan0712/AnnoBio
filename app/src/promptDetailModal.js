import { fillModelPicker, pickedModel } from './modelPicker.js';
import { attachModalPaneCycle } from './paneToggleButton.js';
import { isTaskLocked } from './runTaskLocks.js';
import { openPromptSchemaEditor } from './promptSchemaUi.js';
import { extractInputFields, promptPlaceholders } from './promptText.js';

/**
 * Prompt detail modal: view/edit the prompt text (in place) and the output schema.
 * @param {{ name?: string, note?: string, text?: string, node?: HTMLElement | null }} options
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
 * One row per input, with the line around each place it is used: { key, sentences }. The sentences
 * show newline-separated in one table row.
 */
function getInputsWithSentence(text) {
  const content = String(text || '');
  const byKey = new Map();
  for (const { key, start, end } of promptPlaceholders(content)) {
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(getSentenceAround(content, start, end));
  }
  return [...byKey].map(([key, sentences]) => ({ key, sentences }));
}

/** The "Prompt inputs" table: each `{input}` the text uses and where. Shared with the Add prompt window. */
export function inputsToViewHtml(text) {
  const rows = getInputsWithSentence(text);
  if (rows.length === 0) return '<p class="prompt-detail-placeholder">No inputs.</p>';
  const tbody = rows
    .map(
      (r) =>
        `<tr data-input-name="${escapeAttr(r.key)}" data-sentences="${escapeAttr(JSON.stringify(r.sentences))}"><td class="prompt-detail-inputs-cell">${escapeHtml(r.key)}</td><td class="prompt-detail-inputs-cell prompt-detail-inputs-cell-multi">${escapeHtml(r.sentences.join('\n'))}</td></tr>`
    )
    .join('');
  return `<div class="prompt-detail-inputs-table-wrap">
  <table class="prompt-detail-inputs-table">
    <thead><tr><th>Input</th><th>Sentence</th></tr></thead>
    <tbody>${tbody}</tbody>
  </table>
</div>`;
}

/** The prompt text as one line element per line, so an input row can highlight the lines it is used on. */
function promptTextToViewHtml(text, placeholder) {
  const content = String(text || '');
  if (!content.trim()) return `<p class="prompt-detail-placeholder">${escapeHtml(placeholder)}</p>`;
  const lines = content.split('\n').map((line) => `<div class="preview-field-content-line">${escapeHtml(line)}</div>`).join('');
  return `<div class="preview-field-content">${lines}</div>`;
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

export function schemaToViewHtml(fields, returnShape, { showEmptyTable = false, showAllowNone = true } = {}) {
  if (!showEmptyTable && (!fields || fields.length === 0)) return '<p class="prompt-detail-placeholder">No output schema.</p>';
  const isSingle = returnShape === 'single';
  const rowLabel = isSingle ? 'One output row per input' : 'Multiple output rows per input';
  const rowHint = isSingle
    ? 'Each input row produces one output row.'
    : 'Each input row can produce multiple output rows.';
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
    return `<tr><td class="prompt-detail-schema-cell" data-fulltext="${nameFull}">${name}</td><td class="prompt-detail-schema-cell" data-fulltext="${descFull}">${desc}</td><td class="prompt-detail-schema-cell" data-fulltext="${exFull}">${ex}</td>${showAllowNone ? `<td>${allowNone ? 'Yes' : 'No'}</td>` : ''}</tr>`;
  }).join('');
  return `<div class="prompt-schema-preview-table-wrap">
  <span class="prompt-schema-preview-return-shape" title="${rowHint}">${rowLabel}</span>
  <table class="prompt-schema-preview-table" aria-readonly="true">
    <thead><tr><th>Field</th><th>Description</th><th>Examples</th>${showAllowNone ? '<th>Allow None</th>' : ''}</tr></thead>
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
  const text = node.dataset.promptText || '';
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
  return { name, note, text, returnShape, fields };
}

/**
 * Export format: the prompt text a Run sends + suffix matching backend/llm.py::_run_structured_fallback (approx. JSON Schema).
 */
function buildPromptExportText(snapshot) {
  const runTemplate = String(snapshot.text || '').trim();
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
  return !!document.querySelector('.modal-overlay--field-editor, .modal-overlay--section-editor, .modal-overlay--prompt-schema');
}

const PROMPT_TEXT_SAVE_DELAY_MS = 300;

/**
 * @param {{ locked?: boolean }} options locked: content produced a result (contentLocks.js); the
 * text can't be clicked to edit and Edit schema is hidden.
 */
export function openPromptDetailModal({ name = '', text = '', node: sourceNode = null, onRunPrompt, locked = false }) {
  const displayName = (name && name.trim()) ? name.trim() : 'Prompt';
  const emptyTextPlaceholder = locked ? 'No prompt text.' : 'Click to write the prompt.';

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
  const inputsViewHtml = inputsToViewHtml(text);
  const schemaViewHtml = schemaToViewHtml(outputFormat.fields, outputFormat.returnShape, { showAllowNone: false });

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
              <div class="prompt-detail-schema-heading">
                <h3 class="prompt-preview-title">Output schema</h3>
              </div>
              <div class="prompt-detail-schema-wrap">
                <div class="prompt-detail-schema-view">${schemaViewHtml}</div>
                <div class="prompt-detail-inline-error" id="prompt-detail-schema-error" role="alert" aria-live="polite" hidden></div>
                ${locked ? '' : '<div class="prompt-actions prompt-detail-schema-actions"><button type="button" class="btn btn-secondary prompt-detail-schema-btn-edit">Edit schema</button></div>'}
              </div>
            </div>
          </div>
          <div class="prompt-detail-main">
            <div class="prompt-detail-step">
              <div class="prompt-detail-sections-heading">
                <p class="prompt-step-label">Prompt</p>
              </div>
              <div class="prompt-detail-sections-scroll">
                <div class="prompt-detail-sections-view prompt-detail-text-view${locked ? '' : ' prompt-detail-text-view--editable'}"${locked ? '' : ' role="button" tabindex="0" title="Click to edit"'}>${promptTextToViewHtml(text, emptyTextPlaceholder)}</div>
                <div class="prompt-detail-text-editor-wrap" hidden>
                  <textarea class="dataset-meta-input dataset-meta-textarea prompt-detail-text-editor" aria-label="Prompt text" spellcheck="false"></textarea>
                  <p class="section-editor-hint">Use <code>{variable}</code> for input placeholders; <code>{{</code> for a literal brace. Changes save as you type.</p>
                </div>
              </div>
              <div class="prompt-actions">
                <div class="prompt-actions__trailing">
                  <button type="button" class="btn btn-secondary prompt-detail-export-local" title="Save prompt as a text file">Save as file</button>
                  <select class="dataset-meta-input model-picker prompt-detail-run-model" aria-label="Model for the new Run"></select>
                  <button type="button" class="btn btn-primary prompt-detail-sections-btn-run" id="prompt-detail-sections-btn-run">Create Run</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

  let activeSchemaEditor = null;
  const exportLocalBtn = overlay.querySelector('.prompt-detail-export-local');

  function syncPromptExportLocalEnabled() {
    if (!exportLocalBtn) return;
    const noNode = !sourceNode;
    const childBlocking = !!activeSchemaEditor || hasPromptExportBlockingOverlayOpen();
    exportLocalBtn.disabled = noNode || childBlocking;
  }

  const exportOverlayObserver = new MutationObserver(() => syncPromptExportLocalEnabled());
  exportOverlayObserver.observe(document.body, { childList: true });

  function teardownPromptDetailModal() {
    activeSchemaEditor?.close();
    exportOverlayObserver.disconnect();
    document.removeEventListener('workflow:run-task-locks-changed', onTaskLocksChanged);
    overlay.remove();
    document.body.style.overflow = '';
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

  let currentText = String(text || '');
  const textView = overlay.querySelector('.prompt-detail-text-view');
  const textEditorWrap = overlay.querySelector('.prompt-detail-text-editor-wrap');
  const textEditor = overlay.querySelector('.prompt-detail-text-editor');
  const inputsContentEl = overlay.querySelector('.prompt-detail-inputs-content');
  let textSaveTimer = null;

  /** Saves the text onto the node; inputs it no longer uses lose their type. */
  function persistText() {
    if (textSaveTimer) clearTimeout(textSaveTimer);
    textSaveTimer = null;
    if (heldByRun()) return;
    const next = textEditor.value;
    if (next === currentText) return;
    currentText = next;
    if (!sourceNode) return;
    sourceNode.dataset.promptText = currentText;
    const used = new Set(extractInputFields(currentText));
    Object.keys(inputTypes).forEach((key) => { if (!used.has(key)) delete inputTypes[key]; });
    sourceNode.dataset.promptInputTypes = JSON.stringify(inputTypes);
    inputsContentEl.innerHTML = inputsToViewHtml(currentText);
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  }

  /**
   * The text turns into an editor in place, with the caret at the start of the clicked line. Both lay the
   * text out the same way (modals.css), so keeping the scroll position keeps every line where it was.
   */
  function startTextEdit(clickedLine = null) {
    if (locked || heldByRun() || !textEditorWrap.hidden) return;
    const lines = [...textView.querySelectorAll('.preview-field-content-line')];
    const lineIndex = clickedLine ? lines.indexOf(clickedLine) : -1;
    const { scrollTop } = textView;
    textEditor.value = currentText;
    textView.hidden = true;
    textEditorWrap.hidden = false;
    if (lineIndex < 0) {
      textEditor.focus();
      return;
    }
    const caret = currentText.split('\n').slice(0, lineIndex).reduce((sum, line) => sum + line.length + 1, 0);
    textEditor.setSelectionRange(caret, caret);
    textEditor.focus({ preventScroll: true });
    textEditor.scrollTop = scrollTop;
  }

  function endTextEdit() {
    if (textEditorWrap.hidden) return;
    persistText();
    const { scrollTop } = textEditor;
    textView.innerHTML = promptTextToViewHtml(currentText, emptyTextPlaceholder);
    textEditorWrap.hidden = true;
    textView.hidden = false;
    textView.scrollTop = scrollTop;
  }

  if (!locked) {
    textView.addEventListener('click', (e) => startTextEdit(e.target.closest('.preview-field-content-line')));
    textView.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        startTextEdit();
      }
    });
    textEditor.addEventListener('input', () => {
      if (textSaveTimer) clearTimeout(textSaveTimer);
      textSaveTimer = setTimeout(persistText, PROMPT_TEXT_SAVE_DELAY_MS);
    });
    textEditor.addEventListener('blur', endTextEdit);
    textEditor.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // Leaves the editor, not the window.
        e.preventDefault();
        e.stopPropagation();
        textEditor.blur();
      }
    });
  }

  const sectionsBtnRun = overlay.querySelector('.prompt-detail-sections-btn-run');
  const runModelPicker = overlay.querySelector('.prompt-detail-run-model');
  if (sectionsBtnRun && onRunPrompt) {
    void fillModelPicker(runModelPicker, { defaultSetting: 'default_run_credential_id' });
    sectionsBtnRun.addEventListener('click', () => {
      onRunPrompt(pickedModel(runModelPicker));
      teardownPromptDetailModal();
    });
  } else if (sectionsBtnRun) {
    sectionsBtnRun.style.display = 'none';
    runModelPicker.hidden = true;
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
  if (inputsContent && textView) {
    function clearLineHighlight() {
      textView.querySelectorAll('.preview-field-content-line.prompt-detail-line-highlight').forEach((el) => el.classList.remove('prompt-detail-line-highlight'));
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
      let sentences = [];
      try {
        sentences = JSON.parse(row.dataset.sentences || '[]');
      } catch (_) {
        return;
      }
      clearLineHighlight();
      textView.querySelectorAll('.preview-field-content-line').forEach((lineEl) => {
        const lineText = (lineEl.textContent || '').trim();
        if (sentences.some((sentence) => sentenceMatchesLine(sentence, lineText))) lineEl.classList.add('prompt-detail-line-highlight');
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

  function openEditSchemaWindow() {
    if (activeSchemaEditor || heldByRun()) return;
    activeSchemaEditor = openPromptSchemaEditor({
      fields: currentSchemaFields,
      returnShape: currentSchemaReturnShape,
      renderPreview: (fields, shape) => schemaToViewHtml(fields, shape, { showEmptyTable: true }),
      onChange({ fields, returnShape }) {
        currentSchemaFields = fields;
        currentSchemaReturnShape = returnShape;
        if (sourceNode) {
          sourceNode.dataset.promptOutputFormat = JSON.stringify(fields);
          sourceNode.dataset.promptOutputReturnShape = returnShape;
        }
        schemaView.innerHTML = schemaToViewHtml(fields, returnShape, { showAllowNone: false });
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      },
      onClose() { activeSchemaEditor = null; syncPromptExportLocalEnabled(); },
    });
    syncPromptExportLocalEnabled();
  }

  schemaBtnEdit?.addEventListener('click', openEditSchemaWindow);

  /*
   * A run in progress reads this Prompt (runTaskLocks.js): editing waits until it ends, also when
   * this window opened before the run started. Text typed meanwhile is not saved.
   */
  function heldByRun() {
    return !!sourceNode?.dataset?.nodeId && isTaskLocked(sourceNode.dataset.nodeId);
  }
  function onTaskLocksChanged() {
    const held = heldByRun();
    if (held && !textEditorWrap.hidden) {
      textEditorWrap.hidden = true;
      textView.innerHTML = promptTextToViewHtml(currentText, emptyTextPlaceholder);
      textView.hidden = false;
    }
    if (held) activeSchemaEditor?.close();
    if (schemaBtnEdit) {
      schemaBtnEdit.disabled = held;
      schemaBtnEdit.title = held ? 'A run in progress reads this Prompt.' : '';
    }
    textView.title = held ? 'A run in progress reads this Prompt.' : (locked ? '' : 'Click to edit');
  }
  document.addEventListener('workflow:run-task-locks-changed', onTaskLocksChanged);
  onTaskLocksChanged();

  attachModalPaneCycle({
    overlay,
    bothLabel: 'Show both panels',
    leftOnlyLabel: 'Show prompt inputs panel only',
    rightOnlyLabel: 'Show prompt panel only',
  });

  overlay.querySelector('.modal-close').addEventListener('click', () => {
    teardownPromptDetailModal();
  });
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  syncPromptExportLocalEnabled();
}
