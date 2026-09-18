/**
 * Web-only project picker. The browser has no native "Open File" dialog for this, so New and
 * Open both surface the same list-or-create modal, backed by backend/project_store.py's
 * /api/projects endpoints. Desktop keeps using native save/open dialogs (see renderer.js) and
 * never imports this module's UI path.
 */
import { BACKEND_API_BASE } from './backendConfig.js';
import { showAlert, showConfirm } from './alertModal.js';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(seconds) {
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleString();
}

async function fetchProjects() {
  const res = await fetch(`${BACKEND_API_BASE}/api/projects`);
  if (!res.ok) throw new Error('Could not load projects.');
  return res.json();
}

/**
 * @returns {Promise<{id: string, name: string} | null>} the project to open, or null if closed
 *   without picking one.
 */
export function showProjectPickerModal() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'project-picker-title');
    overlay.innerHTML = `
      <div class="modal-panel modal-panel--project-picker">
        <div class="modal-header">
          <h2 id="project-picker-title" class="modal-title">Projects</h2>
          <button type="button" class="modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="project-picker-new">
            <input type="text" class="project-picker-name-input" placeholder="New project name" maxlength="200" />
            <button type="button" class="btn btn-primary project-picker-create">Create</button>
          </div>
          <div class="project-picker-list">Loading…</div>
        </div>
      </div>
    `;

    let settled = false;
    function done(value) {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKeyDown);
      resolve(value);
    }
    function close() { done(null); }
    function onKeyDown(e) { if (e.key === 'Escape') close(); }

    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKeyDown);

    const listEl = overlay.querySelector('.project-picker-list');
    const nameInput = overlay.querySelector('.project-picker-name-input');
    const createBtn = overlay.querySelector('.project-picker-create');

    async function refresh() {
      listEl.textContent = 'Loading…';
      try {
        const projects = await fetchProjects();
        if (!projects.length) {
          listEl.innerHTML = '<p class="project-picker-empty">No projects yet. Create one above.</p>';
          return;
        }
        listEl.innerHTML = '';
        for (const project of projects) {
          const row = document.createElement('div');
          row.className = 'project-picker-row';
          row.innerHTML = `
            <button type="button" class="project-picker-open">
              <span class="project-picker-row-name">${escapeHtml(project.name)}</span>
              <span class="project-picker-row-date">${escapeHtml(formatDate(project.updatedAt))}</span>
            </button>
            <button type="button" class="project-picker-delete" aria-label="Delete ${escapeHtml(project.name)}">&times;</button>
          `;
          row.querySelector('.project-picker-open').addEventListener('click', () => {
            done({ id: project.id, name: project.name });
          });
          row.querySelector('.project-picker-delete').addEventListener('click', async (e) => {
            e.stopPropagation();
            const ok = await showConfirm(`Delete "${project.name}"? This cannot be undone.`, {
              title: 'Delete project', confirmText: 'Delete',
            });
            if (!ok) return;
            try {
              const res = await fetch(`${BACKEND_API_BASE}/api/projects/${project.id}`, { method: 'DELETE' });
              if (!res.ok) throw new Error('Could not delete project.');
              refresh();
            } catch (err) {
              showAlert(err.message || 'Could not delete project.', { title: 'Error' });
            }
          });
          listEl.appendChild(row);
        }
      } catch (err) {
        listEl.innerHTML = `<p class="project-picker-empty">${escapeHtml(err.message || 'Could not load projects.')}</p>`;
      }
    }

    async function createProject() {
      const name = nameInput.value.trim() || 'Untitled Project';
      createBtn.disabled = true;
      try {
        const res = await fetch(`${BACKEND_API_BASE}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error('Could not create project.');
        const { id } = await res.json();
        done({ id, name });
      } catch (err) {
        createBtn.disabled = false;
        showAlert(err.message || 'Could not create project.', { title: 'Error' });
      }
    }

    createBtn.addEventListener('click', createProject);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createProject(); });

    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
    refresh();
  });
}

/** Fetch a project's canvas state by id. Throws on failure. */
export async function loadWebProject(id) {
  const res = await fetch(`${BACKEND_API_BASE}/api/projects/${id}`);
  if (!res.ok) throw new Error('Could not load project.');
  return res.json();
}

/** Persist a project's canvas state by id. Throws on failure. */
export async function saveWebProject(id, state) {
  const res = await fetch(`${BACKEND_API_BASE}/api/projects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) throw new Error('Could not save project.');
}
