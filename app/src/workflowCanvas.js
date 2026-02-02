/**
 * Workflow canvas (node-based editor surface).
 * Listens for workflow:add-prompt-node to add prompt nodes.
 */

export function buildWorkflowCanvas(root) {
  const canvas = document.createElement('div');
  canvas.className = 'workflow-canvas';

  const nodesLayer = document.createElement('div');
  nodesLayer.className = 'workflow-canvas__nodes';
  canvas.appendChild(nodesLayer);

  let nodeCount = 0;
  const STAGGER = 36;

  function fieldsToViewHtml(fieldsList) {
    if (!fieldsList || fieldsList.length === 0) return '<p class="prompt-detail-placeholder">No fields.</p>';
    return fieldsList
      .map(
        (f) => `
          <div class="preview-field-block">
            <div class="preview-field-divider">
              <span class="preview-field-line" aria-hidden="true"></span>
              <span class="preview-field-name">${escapeHtml(f.name || 'Unnamed')}</span>
            </div>
            <div class="preview-field-content">${escapeHtml(f.content || '')}</div>
          </div>
        `
      )
      .join('');
  }

  function openPromptDetailModal({ name = '', note = '', fields = [], node: sourceNode = null }) {
    const displayName = (name && name.trim()) ? name.trim() : 'Prompt';
    const noteTrimmed = (note || '').trim();
    const fieldsViewHtml = fieldsToViewHtml(fields);

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
          <div class="prompt-detail-card">
            <div class="prompt-detail-view">
              <div class="prompt-detail-row">
                <span class="prompt-detail-label">Prompt name</span>
                <span class="prompt-detail-name-value">${escapeHtml(displayName)}</span>
              </div>
              <div class="prompt-detail-row">
                <span class="prompt-detail-label">Prompt notes</span>
                <div class="prompt-detail-notes-value">${noteTrimmed ? escapeHtml(noteTrimmed) : '<span class="prompt-detail-placeholder">No notes.</span>'}</div>
              </div>
            </div>
            <div class="prompt-detail-edit">
              <div class="prompt-detail-row">
                <label class="prompt-detail-label" for="prompt-detail-name-inp">Prompt name</label>
                <input type="text" id="prompt-detail-name-inp" class="prompt-detail-input" />
              </div>
              <div class="prompt-detail-row">
                <label class="prompt-detail-label" for="prompt-detail-notes-inp">Prompt notes</label>
                <textarea id="prompt-detail-notes-inp" class="prompt-detail-textarea" rows="3"></textarea>
              </div>
            </div>
            <div class="prompt-detail-footer">
              <button type="button" class="btn btn-secondary prompt-detail-btn-edit">Edit</button>
              <div class="prompt-detail-footer-edit">
                <button type="button" class="btn btn-secondary prompt-detail-btn-cancel">Cancel</button>
                <button type="button" class="btn btn-secondary prompt-detail-btn-save">Save</button>
              </div>
            </div>
          </div>
          <div class="prompt-detail-fields-wrap" data-prompt-fields-mode="view">
            <h3 class="prompt-detail-section-title">Fields</h3>
            <div class="prompt-detail-fields-view">${fieldsViewHtml}</div>
            <div class="prompt-detail-fields-edit"></div>
            <div class="prompt-detail-fields-footer">
              <button type="button" class="btn btn-secondary prompt-detail-fields-btn-edit">Edit</button>
              <div class="prompt-detail-fields-edit-btns">
                <button type="button" class="btn btn-secondary prompt-detail-fields-btn-cancel">Cancel</button>
                <button type="button" class="btn btn-secondary prompt-detail-fields-btn-save-node">Save to this node</button>
                <button type="button" class="btn btn-secondary prompt-detail-fields-btn-save-new">Save as new node</button>
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
      notesValueEl.innerHTML = newNote ? escapeHtml(newNote) : '<span class="prompt-detail-placeholder">No notes.</span>';
      showView();
    });

    let currentFields = Array.isArray(fields) ? fields.map((f) => ({ name: f.name || '', content: f.content || '' })) : [];
    const fieldsWrap = overlay.querySelector('.prompt-detail-fields-wrap');
    const fieldsView = overlay.querySelector('.prompt-detail-fields-view');
    const fieldsEdit = overlay.querySelector('.prompt-detail-fields-edit');
    const fieldsBtnEdit = overlay.querySelector('.prompt-detail-fields-btn-edit');
    const fieldsEditBtns = overlay.querySelector('.prompt-detail-fields-edit-btns');
    const fieldsBtnCancel = overlay.querySelector('.prompt-detail-fields-btn-cancel');
    const fieldsBtnSaveNode = overlay.querySelector('.prompt-detail-fields-btn-save-node');
    const fieldsBtnSaveNew = overlay.querySelector('.prompt-detail-fields-btn-save-new');

    function getFieldsFromEditContainer() {
      const rows = fieldsEdit.querySelectorAll('.prompt-detail-field-edit-row');
      return Array.from(rows).map((row) => ({
        name: (row.querySelector('.prompt-detail-field-name-inp')?.value ?? '').trim(),
        content: row.querySelector('.prompt-detail-field-content-inp')?.value ?? '',
      }));
    }

    function buildFieldsEditContent(fieldsList) {
      const list = Array.isArray(fieldsList) && fieldsList.length ? fieldsList : [{ name: '', content: '' }];
      return list
        .map(
          (f) => `
          <div class="prompt-detail-field-edit-row">
            <div class="prompt-detail-field-edit-header">
              <input type="text" class="prompt-detail-input prompt-detail-field-name-inp" value="${escapeHtml(f.name || '')}" placeholder="Field name" />
              <button type="button" class="prompt-field-remove prompt-detail-field-delete" aria-label="Remove field">×</button>
            </div>
            <div class="prompt-detail-row">
              <label class="prompt-detail-label">Content</label>
              <textarea class="prompt-detail-textarea prompt-detail-field-content-inp" rows="2" placeholder="Content">${escapeHtml(f.content || '')}</textarea>
            </div>
          </div>
        `
        )
        .join('');
    }

    function showFieldsView() {
      fieldsWrap.setAttribute('data-prompt-fields-mode', 'view');
    }

    function showFieldsEdit() {
      let list = currentFields;
      if (sourceNode) {
        try {
          list = JSON.parse(sourceNode.dataset.promptFields || '[]');
        } catch (_) {}
      }
      if (!list.length) list = [{ name: '', content: '' }];
      fieldsEdit.innerHTML =
        buildFieldsEditContent(list) +
        `<button type="button" class="btn btn-secondary prompt-detail-fields-add-row">+ Add field</button>`;
      fieldsEdit.querySelector('.prompt-detail-fields-add-row').addEventListener('click', () => {
        const addBtn = fieldsEdit.querySelector('.prompt-detail-fields-add-row');
        const newHtml = `
          <div class="prompt-detail-field-edit-row">
            <div class="prompt-detail-field-edit-header">
              <input type="text" class="prompt-detail-input prompt-detail-field-name-inp" value="" placeholder="Field name" />
              <button type="button" class="prompt-field-remove prompt-detail-field-delete" aria-label="Remove field">×</button>
            </div>
            <div class="prompt-detail-row">
              <label class="prompt-detail-label">Content</label>
              <textarea class="prompt-detail-textarea prompt-detail-field-content-inp" rows="2" placeholder="Content"></textarea>
            </div>
          </div>`;
        if (addBtn) addBtn.insertAdjacentHTML('beforebegin', newHtml);
      });
      fieldsEdit.addEventListener('click', (e) => {
        const delBtn = e.target.closest('.prompt-detail-field-delete');
        if (!delBtn) return;
        const row = delBtn.closest('.prompt-detail-field-edit-row');
        if (!row) return;
        const rows = fieldsEdit.querySelectorAll('.prompt-detail-field-edit-row');
        if (rows.length <= 1) return;
        row.remove();
      });
      fieldsWrap.setAttribute('data-prompt-fields-mode', 'edit');
    }

    fieldsBtnEdit.addEventListener('click', () => {
      showFieldsEdit();
    });
    fieldsBtnCancel.addEventListener('click', () => {
      showFieldsView();
    });
    fieldsBtnSaveNode.addEventListener('click', () => {
      const newFields = getFieldsFromEditContainer().filter((f) => f.name || f.content);
      currentFields = newFields;
      if (sourceNode) {
        sourceNode.dataset.promptFields = JSON.stringify(newFields);
      }
      fieldsView.innerHTML = fieldsToViewHtml(newFields.length ? newFields : []);
      showFieldsView();
    });
    fieldsBtnSaveNew.addEventListener('click', () => {
      // TODO: save as new node
      showFieldsView();
    });

    overlay.querySelector('.modal-close').addEventListener('click', () => {
      overlay.remove();
      document.body.style.overflow = '';
    });
    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
  }

  function createPromptNode({ name = '', note = '', fields = [] }) {
    const title = (name && name.trim()) ? name.trim() : 'Prompt';
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--prompt';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', `Prompt node: ${title}`);
    node.dataset.promptFields = JSON.stringify(fields);
    node.dataset.promptName = name;
    node.dataset.promptNote = note;
    const x = 80 + (nodeCount % 5) * (280 + STAGGER);
    const y = 80 + Math.floor(nodeCount / 5) * (120 + STAGGER);
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
    });

    node.addEventListener('dblclick', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      let fieldsData = [];
      try {
        fieldsData = JSON.parse(node.dataset.promptFields || '[]');
      } catch (_) {}
      openPromptDetailModal({
        name: node.dataset.promptName || '',
        note: node.dataset.promptNote || '',
        fields: fieldsData,
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
      const parentRect = nodesLayer.getBoundingClientRect();
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartLeft = rect.left - parentRect.left + nodesLayer.scrollLeft;
      nodeStartTop = rect.top - parentRect.top + nodesLayer.scrollTop;
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
    }

    node.addEventListener('pointerdown', onPointerDown);
    return node;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  document.addEventListener('workflow:add-prompt-node', (e) => {
    const { name = '', note = '', fields = [] } = e.detail || {};
    createPromptNode({ name, note, fields });
  });

  root.appendChild(canvas);
}
