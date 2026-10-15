function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function openPromptSectionEditor({ sections, sectionIndex = null, onDone, host = null, onClose }) {
  const isEdit = sectionIndex !== null && sectionIndex >= 0;
  const section = isEdit ? sections[sectionIndex] : { name: '', content: '' };
  const editorOverlay = document.createElement('div');
  editorOverlay.className = host ? 'prompt-detail-side-child-editor' : 'modal-overlay modal-overlay--section-editor';
  if (!host) editorOverlay.setAttribute('aria-modal', 'true');
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
            <p class="section-editor-hint">Use <code>{variable}</code> for input placeholders; <code>{{</code> for a literal brace.</p>
          </div>
        </div>
        <div class="prompt-form-error section-editor-error" role="alert" aria-live="polite" hidden></div>
        <div class="modal-footer-actions">
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
    onClose?.();
  }

  function getDraft() {
    return {
      name: (nameInput?.value ?? '').trim(),
      content: (contentInput?.value ?? '').trim(),
    };
  }

  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  function clearError() {
    if (!errorEl) return;
    errorEl.textContent = '';
    errorEl.hidden = true;
  }

  function save() {
    const { name, content } = getDraft();
    if (!name) {
      showError('Please enter a section name.');
      return false;
    }
    if (!content) {
      showError('Please enter section content.');
      return false;
    }
    const otherNames = sections
      .map((s, i) => (i === sectionIndex ? null : (s.name || '').trim().toLowerCase()))
      .filter(Boolean);
    if (otherNames.includes(name.toLowerCase())) {
      showError('This section name is already used. Please choose another.');
      return false;
    }
    if (isEdit) {
      sections[sectionIndex] = { name, content };
    } else {
      sections.push({ name, content });
    }
    close();
    if (typeof onDone === 'function') onDone();
    return true;
  }

  editorOverlay.querySelector('.modal-close')?.addEventListener('click', close);
  editorOverlay.querySelector('.section-editor-save')?.addEventListener('click', save);
  nameInput?.addEventListener('input', clearError);
  contentInput?.addEventListener('input', clearError);

  (host || document.body).appendChild(editorOverlay);
  nameInput?.focus();
}

export function renderPromptSectionCards({ sections, container, onChange, onEdit }) {
  if (!container) return;
  container.innerHTML = '';
  sections.forEach((section, index) => {
    const card = document.createElement('div');
    card.className = 'prompt-section-card';
    const displayName = (section.name || '').trim() || 'Unnamed section';
    const openEditor = () => onEdit
      ? onEdit(index)
      : openPromptSectionEditor({ sections, sectionIndex: index, onDone: onChange });
    card.innerHTML = `
      <div class="prompt-section-card-inner" tabindex="0" role="button">
        <span class="prompt-section-card-name">${escapeHtml(displayName)}</span>
      </div>
      <button type="button" class="prompt-section-card-remove" aria-label="Remove section">×</button>
    `;
    const inner = card.querySelector('.prompt-section-card-inner');
    const removeBtn = card.querySelector('.prompt-section-card-remove');
    inner?.addEventListener('click', openEditor);
    inner?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEditor();
      }
    });
    removeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      sections.splice(index, 1);
      if (typeof onChange === 'function') onChange();
    });
    container.appendChild(card);
  });
}
