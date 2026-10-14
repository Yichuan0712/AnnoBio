import { openPromptSectionEditor, renderPromptSectionCards } from './promptSectionUi.js';
import { openPromptFieldEditor, renderPromptFieldCards } from './promptSchemaUi.js';

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
              <span class="prompt-output-return-shape-label">Output rows</span>
              <div class="review-detail-view-switch prompt-output-row-switch" role="group" aria-label="Output rows">
                <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab prompt-output-row-btn" data-return-shape="single" aria-pressed="false">One row</button>
                <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab review-detail-tab--active prompt-output-row-btn" data-return-shape="table" aria-pressed="true">Multiple rows</button>
              </div>
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
          <p class="prompt-schema-preview-return-shape"><span class="prompt-schema-meta-label">Output rows:</span> <span class="prompt-schema-preview-return-shape-value">Multiple rows</span></p>
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
  const returnShapeButtons = overlay.querySelectorAll('.prompt-output-row-btn');
  returnShapeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      outputReturnShape = button.dataset.returnShape;
      returnShapeButtons.forEach((item) => {
        const active = item === button;
        item.classList.toggle('review-detail-tab--active', active);
        item.setAttribute('aria-pressed', String(active));
      });
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
      returnShapeEl.textContent = outputReturnShape === 'single' ? 'One row' : 'Multiple rows';
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

  function renderOutputFieldCards() {
    renderPromptFieldCards({
      fields: outputFields,
      container: outputKeysListEl,
      outputTypes: OUTPUT_TYPES,
      onChange: () => {
        renderOutputFieldCards();
        updateSchemaPreview();
      },
    });
    const addWrap = document.createElement('div');
    addWrap.className = 'prompt-add-field-wrap';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-secondary prompt-output-add-key';
    addBtn.textContent = '+ Add a field';
    addBtn.addEventListener('click', () => {
      openPromptFieldEditor({
        fields: outputFields,
        outputTypes: OUTPUT_TYPES,
        onDone: () => {
        renderOutputFieldCards();
        updateSchemaPreview();
        },
      });
    });
    addWrap.appendChild(addBtn);
    outputKeysListEl.appendChild(addWrap);
    updateSchemaPreview();
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
    renderPromptSectionCards({
      sections,
      container,
      onChange: renderSections,
    });
    updatePreview();
  }

  addBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPromptSectionEditor({
      sections,
      onDone: () => {
        renderSections();
      },
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
      returnShape: outputReturnShape,
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
