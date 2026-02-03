/**
 * "Add a new prompt" modal: fields, preview, Add field / Add this prompt.
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
            <p class="prompt-step-label">Step 1 of 2 — Fields</p>
            <p class="prompt-hint">Add named fields and enter your prompt content. You can add or remove fields.</p>
            <div class="prompt-fields"></div>
            <div class="prompt-add-field-wrap">
              <button type="button" class="btn btn-secondary prompt-add-field">+ Add field</button>
            </div>
            <div class="prompt-actions">
              <button type="button" class="btn btn-secondary prompt-btn-next">Next</button>
            </div>
          </div>
          <div class="prompt-step prompt-step-2">
            <p class="prompt-step-label">Step 2 of 2 — Name & notes</p>
            <div class="dataset-meta-wrap prompt-meta-wrap">
              <div class="dataset-meta-field">
                <label class="dataset-meta-label" for="prompt-name-input">Prompt name</label>
                <input type="text" id="prompt-name-input" class="dataset-meta-input" placeholder="Prompt name" />
              </div>
              <div class="dataset-meta-field">
                <label class="dataset-meta-label" for="prompt-note-input">Prompt notes</label>
                <textarea id="prompt-note-input" class="dataset-meta-input dataset-meta-textarea" rows="3" placeholder="This prompt has no notes"></textarea>
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
      </div>
    </div>
  `;

  const panel = overlay.querySelector('.modal-panel--prompt');
  const container = overlay.querySelector('.prompt-fields');
  const addBtn = overlay.querySelector('.prompt-add-field');
  const previewEl = overlay.querySelector('.prompt-preview');
  let fields = [{ name: '', content: '' }];

  function goToStep(step) {
    panel.setAttribute('data-add-prompt-step', String(step));
  }

  overlay.querySelector('.prompt-btn-next').addEventListener('click', () => goToStep(2));
  overlay.querySelector('.prompt-btn-back').addEventListener('click', () => goToStep(1));

  function syncFieldsFromDOM() {
    const rows = container.querySelectorAll('.prompt-field');
    if (rows.length === 0) return;
    fields = Array.from(rows).map((row) => ({
      name: row.querySelector('.prompt-field-name').value.trim(),
      content: row.querySelector('.prompt-field-content').value,
    }));
  }

  function createFieldRow(field, index) {
    const row = document.createElement('div');
    row.className = 'prompt-field';
    row.innerHTML = `
      <div class="prompt-field-header">
        <input type="text" class="prompt-field-name" placeholder="Field name" value="${escapeHtml(field.name)}" aria-label="Field name" />
        <button type="button" class="prompt-field-remove" aria-label="Remove field">Delete field</button>
      </div>
      <textarea class="prompt-field-content" placeholder="Enter content for this field..." rows="3" aria-label="Field content">${escapeHtml(field.content)}</textarea>
    `;
    row.querySelector('.prompt-field-remove').addEventListener('click', () => {
      syncFieldsFromDOM();
      fields.splice(index, 1);
      if (fields.length === 0) fields.push({ name: '', content: '' });
      renderFields(true);
    });
    return row;
  }

  function updatePreview() {
    syncFieldsFromDOM();
    const blocks = fields.filter((f) => f.name || f.content);
    if (blocks.length === 0) {
      previewEl.innerHTML = '';
      previewEl.textContent = 'Enter fields on the left to see the combined prompt here';
      return;
    }
    previewEl.innerHTML = blocks
      .map(
        (f) => `
      <div class="preview-field-block">
        <div class="preview-field-divider">
          <span class="preview-field-line" aria-hidden="true"></span>
          <span class="preview-field-name">${escapeHtml(f.name || 'Unnamed')}</span>
        </div>
        <div class="preview-field-content">${escapeHtml(f.content)}</div>
      </div>
    `
      )
      .join('');
  }

  function renderFields(skipSync = false) {
    if (!skipSync) syncFieldsFromDOM();
    container.innerHTML = '';
    fields.forEach((field, index) => container.appendChild(createFieldRow(field, index)));
    updatePreview();
  }

  container.addEventListener('input', updatePreview);
  container.addEventListener('change', updatePreview);

  addBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    syncFieldsFromDOM();
    fields.push({ name: '', content: '' });
    renderFields(true);
  });

  overlay.querySelector('.prompt-generate-node').addEventListener('click', () => {
    syncFieldsFromDOM();
    const nameInput = overlay.querySelector('#prompt-name-input');
    const noteInput = overlay.querySelector('#prompt-note-input');
    const name = (nameInput?.value ?? '').trim() || '';
    const note = (noteInput?.value ?? '').trim();
    const fieldsPayload = fields.map((f) => ({ name: f.name, content: f.content }));
    document.dispatchEvent(
      new CustomEvent('workflow:add-prompt-node', { detail: { name, note, fields: fieldsPayload } })
    );
    close();
  });

  renderFields();

  const close = () => {
    overlay.remove();
    document.body.style.overflow = '';
  };
  overlay.querySelector('.modal-close').addEventListener('click', close);

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
