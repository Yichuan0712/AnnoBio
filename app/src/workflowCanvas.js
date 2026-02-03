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

  function openPromptDetailModal({ name = '', note = '', sections = [], node: sourceNode = null }) {
    const displayName = (name && name.trim()) ? name.trim() : 'Prompt';
    const noteTrimmed = (note || '').trim();
    const sectionsViewHtml = sectionsToViewHtml(sections);

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
          <div class="prompt-detail-sections-wrap" data-prompt-sections-mode="view">
            <h3 class="prompt-detail-section-title">Sections</h3>
            <div class="prompt-detail-sections-view">${sectionsViewHtml}</div>
            <div class="prompt-detail-sections-edit"></div>
            <div class="prompt-detail-sections-footer">
              <button type="button" class="btn btn-secondary prompt-detail-sections-btn-edit">Edit</button>
              <div class="prompt-detail-sections-edit-btns">
                <button type="button" class="btn btn-secondary prompt-detail-sections-btn-save-node">Save to this node</button>
                <button type="button" class="btn btn-secondary prompt-detail-sections-btn-save-new">Save as new node</button>
                <button type="button" class="btn btn-secondary prompt-detail-sections-btn-cancel">Cancel</button>
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
    const sectionsBtnSaveNew = overlay.querySelector('.prompt-detail-sections-btn-save-new');

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
    sectionsBtnSaveNew.addEventListener('click', () => {
      // TODO: save as new node
      showSectionsView();
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
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
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
    const { name = '', note = '', sections = [], outputFormat } = e.detail || {};
    createPromptNode({ name, note, sections, outputFormat });
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
  }

  function setOnCanvasChange(fn) {
    document.addEventListener('workflow:canvas-changed', fn);
  }

  root.appendChild(canvas);
  return { getCanvasState, loadCanvasState, setOnCanvasChange };
}
