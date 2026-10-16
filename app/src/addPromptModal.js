import { mountPromptSchemaSettings, validatePromptSchema } from './promptSchemaUi.js';
import { inputsToViewHtml, schemaToViewHtml } from './promptDetailModal.js';
import { extractInputFields } from './promptText.js';

/**
 * Three-step Prompt creator: name, the prompt text, the output schema. Fields are edited in a separate dialog shared with existing Prompts.
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
            <p class="prompt-step-label">Step 2 of 3 — Prompt</p>
            <p class="prompt-hint">Write the prompt. Use <code>{variable}</code> for each input a Run fills from a dataset column; <code>{{</code> for a literal brace.</p>
            <div class="prompt-step-scroll prompt-step-2-scroll">
              <textarea id="prompt-text-input" class="dataset-meta-input dataset-meta-textarea prompt-text-input" aria-label="Prompt text" spellcheck="false"></textarea>
            </div>
            <div class="prompt-form-error prompt-modal-error" role="alert" aria-live="polite" hidden></div>
            <div class="prompt-actions">
              <button type="button" class="btn btn-secondary prompt-btn-back-from-2">Back</button>
              <button type="button" class="btn btn-secondary prompt-btn-next-to-3">Next</button>
            </div>
          </div>
          <div class="prompt-step prompt-step-3">
            <p class="prompt-step-label">Step 3 of 3 — LLM output schema</p>
            <div class="prompt-schema-settings"></div>
            <div class="prompt-form-error prompt-modal-error" role="alert" aria-live="polite" hidden></div>
            <div class="prompt-actions">
              <button type="button" class="btn btn-secondary prompt-btn-back">Back</button>
              <button type="button" class="btn btn-primary prompt-generate-node">Create this prompt</button>
            </div>
          </div>
        </div>
        <div class="prompt-preview-wrap">
          <h3 class="prompt-preview-title">Prompt inputs</h3>
          <div class="prompt-preview" aria-readonly="true"></div>
        </div>
        <div class="prompt-schema-preview-wrap">
          <h3 class="prompt-schema-preview-title">
            <span class="prompt-schema-preview-heading-text">Output schema</span>
          </h3>
          <div class="prompt-create-schema-preview"></div>
        </div>
      </div>
    </div>
  `;

  const panel = overlay.querySelector('.modal-panel--prompt');
  const textInput = overlay.querySelector('#prompt-text-input');
  const previewEl = overlay.querySelector('.prompt-preview');
  const schemaPreviewEl = overlay.querySelector('.prompt-create-schema-preview');
  const nextToSchemaBtn = overlay.querySelector('.prompt-btn-next-to-3');

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
    updatePreview();
    textInput.focus();
  });

  overlay.querySelector('#prompt-name-input')?.addEventListener('input', clearPromptError);
  overlay.querySelector('#prompt-note-input')?.addEventListener('input', clearPromptError);

  overlay.querySelector('.prompt-btn-back-from-2').addEventListener('click', () => goToStep(1));

  function validateStep2() {
    if (!textInput.value.trim()) return { valid: false, message: 'Please write the prompt.' };
    if (!extractInputFields(textInput.value).length) return { valid: false, message: 'Add at least one input placeholder, such as {abstract}, to continue.' };
    return { valid: true };
  }

  nextToSchemaBtn.addEventListener('click', () => {
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

  let outputFields = [];
  let outputReturnShape = 'table';
  function updateSchemaPreview() {
    schemaPreviewEl.innerHTML = schemaToViewHtml(outputFields, outputReturnShape, { showEmptyTable: true });
  }
  const schemaSettings = mountPromptSchemaSettings(overlay.querySelector('.prompt-schema-settings'), {
    fields: outputFields,
    returnShape: outputReturnShape,
    onChange({ fields, returnShape }) {
      outputFields = fields;
      outputReturnShape = returnShape;
      clearPromptError();
      updateSchemaPreview();
    },
  });

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

  /** The inputs the text uses, as the Prompt window lists them. */
  function updatePreview() {
    const text = textInput.value;
    previewEl.classList.toggle('prompt-preview--empty', !text.trim());
    if (!text.trim()) {
      previewEl.textContent = 'Write the prompt on the left; each {input} it uses shows here.';
      return;
    }
    previewEl.innerHTML = inputsToViewHtml(text);
  }

  textInput.addEventListener('input', () => {
    clearPromptError();
    updatePreview();
  });

  overlay.querySelector('.prompt-generate-node').addEventListener('click', () => {
    clearPromptError();
    const text = textInput.value;
    const promptValidation = validateStep2();
    if (!promptValidation.valid) {
      goToStep(2);
      updatePreview();
      showPromptError(promptValidation.message);
      textInput.focus();
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
    const schemaError = validatePromptSchema(outputFormat.fields);
    if (schemaError) {
      showPromptError(schemaError);
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
      new CustomEvent('workflow:add-prompt-node', { detail: { name, note, text, outputFormat } })
    );
    close();
  });

  updatePreview();
  updateSchemaPreview();

  const close = () => {
    schemaSettings.dispose();
    overlay.remove();
    document.body.style.overflow = '';
  };
  overlay.querySelector('.modal-close').addEventListener('click', close);

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  initSchemaPreviewTooltip();
}
