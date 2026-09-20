/**
 * Web-only project picker. The browser has no native "Open File" dialog for this, so New and
 * Open both surface the same list-or-create modal, backed by backend/project_store.py's
 * /api/projects endpoints. Merge, duplicate, download and delete all live here too, as
 * per-project actions in the same list, rather than each getting a separate top-bar button or
 * near-duplicate modal. Desktop keeps using native save/open dialogs (see renderer.js) and
 * never imports this module's UI path.
 */
import { BACKEND_API_BASE } from './backendConfig.js';
import { showAlert, showConfirm } from './alertModal.js';
import { iconMerge, iconCopy, iconDownload, iconTrash } from './icons.js';

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

/** Downloads a project as a `.yc` bundle — the same format desktop's File > Open reads, so a
 * project can move from the web build to the desktop app. */
async function downloadProjectYc(id, name) {
  const res = await fetch(`${BACKEND_API_BASE}/api/projects/${id}/export/yc`);
  if (!res.ok) throw new Error('Could not export project.');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name || 'project'}.yc`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Appends " (2)", " (3)", etc. if `base` is already used by an existing project — so creating
 * several projects without picking a name doesn't leave a pile of identically-named "Untitled
 * Project" entries. Used by the picker's blank-name Create and by the top bar's auto-create. */
export async function findUniqueProjectName(base) {
  const projects = await fetchProjects().catch(() => []);
  const existing = new Set(
    (Array.isArray(projects) ? projects : []).map((p) => String(p?.name || '').trim().toLowerCase()),
  );
  if (!existing.has(base.trim().toLowerCase())) return base;
  let n = 2;
  let candidate;
  do {
    candidate = `${base} (${n})`;
    n += 1;
  } while (existing.has(candidate.toLowerCase()));
  return candidate;
}

/** Creates a new project with the given name. Shared by the picker's "Create" button and by the
 * top bar's Create-prompt/dataset buttons, which auto-create a project the same way when none is
 * open yet (see renderer.js's ensureWebProjectOpen). @returns {Promise<{id: string}>} */
export async function createWebProject(name) {
  const res = await fetch(`${BACKEND_API_BASE}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error('Could not create project.');
  return res.json();
}

/** Uploads a desktop `.yc` file as a new project. @returns {Promise<{id: string}>} */
async function importProjectYc(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${BACKEND_API_BASE}/api/projects/import/yc`, { method: 'POST', body: formData });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || 'Could not import project.');
  }
  return res.json();
}

/**
 * Project picker: create/import/open/duplicate/download/delete, plus — only when
 * currentProjectId is given — a "Merge into current" action per row, so merging doesn't need
 * its own top-bar button or its own near-duplicate modal.
 * @param {string | null} [currentProjectId] the currently open project, if any. Its own row
 *   gets no merge button (a project can't merge into itself).
 * @returns {Promise<{ type: 'open', id: string, name: string } | { type: 'merged', state: object } | null>}
 *   null if closed without picking anything.
 */
export function showProjectPickerModal(currentProjectId = null) {
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
            <button type="button" class="btn btn-secondary project-picker-import-yc">Import .yc file…</button>
            <input type="file" class="project-picker-yc-input" accept=".yc" hidden />
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
          const canMergeHere = currentProjectId && project.id !== currentProjectId;
          const row = document.createElement('div');
          row.className = 'project-picker-row';

          const openBtn = document.createElement('button');
          openBtn.type = 'button';
          openBtn.className = 'project-picker-open';
          openBtn.innerHTML = `
            <span class="project-picker-row-name">${escapeHtml(project.name)}</span>
            <span class="project-picker-row-date">${escapeHtml(formatDate(project.updatedAt))}</span>
          `;
          openBtn.addEventListener('click', () => {
            done({ type: 'open', id: project.id, name: project.name });
          });
          row.appendChild(openBtn);

          if (canMergeHere) {
            const mergeBtn = document.createElement('button');
            mergeBtn.type = 'button';
            mergeBtn.className = 'project-picker-merge';
            mergeBtn.setAttribute('aria-label', `Merge ${project.name} into the current project`);
            mergeBtn.title = 'Merge into current project';
            mergeBtn.appendChild(iconMerge(15));
            mergeBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const ok = await showConfirm(
                `Merge "${project.name}" into your current project? Its nodes and images will be added alongside what's already there.`,
                { title: 'Merge project', confirmText: 'Merge' },
              );
              if (!ok) return;
              try {
                const res = await fetch(`${BACKEND_API_BASE}/api/projects/${currentProjectId}/merge/${project.id}`, { method: 'POST' });
                if (!res.ok) throw new Error('Could not merge project.');
                const merged = await res.json();
                done({ type: 'merged', state: merged.state });
              } catch (err) {
                showAlert(err.message || 'Could not merge project.', { title: 'Error' });
              }
            });
            row.appendChild(mergeBtn);
          }

          const duplicateBtn = document.createElement('button');
          duplicateBtn.type = 'button';
          duplicateBtn.className = 'project-picker-duplicate';
          duplicateBtn.setAttribute('aria-label', `Duplicate ${project.name}`);
          duplicateBtn.title = 'Duplicate';
          duplicateBtn.appendChild(iconCopy(15));
          duplicateBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
              const res = await fetch(`${BACKEND_API_BASE}/api/projects/${project.id}/duplicate`, { method: 'POST' });
              if (!res.ok) throw new Error('Could not duplicate project.');
              refresh();
            } catch (err) {
              showAlert(err.message || 'Could not duplicate project.', { title: 'Error' });
            }
          });
          row.appendChild(duplicateBtn);

          const downloadBtn = document.createElement('button');
          downloadBtn.type = 'button';
          downloadBtn.className = 'project-picker-download';
          downloadBtn.setAttribute('aria-label', `Download ${project.name} as .yc`);
          downloadBtn.title = 'Download as .yc (open in the desktop app)';
          downloadBtn.appendChild(iconDownload(15));
          downloadBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
              await downloadProjectYc(project.id, project.name);
            } catch (err) {
              showAlert(err.message || 'Could not export project.', { title: 'Error' });
            }
          });
          row.appendChild(downloadBtn);

          const deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'project-picker-delete';
          deleteBtn.setAttribute('aria-label', `Delete ${project.name}`);
          deleteBtn.title = 'Delete';
          deleteBtn.appendChild(iconTrash(15));
          deleteBtn.addEventListener('click', async (e) => {
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
          row.appendChild(deleteBtn);

          listEl.appendChild(row);
        }
      } catch (err) {
        listEl.innerHTML = `<p class="project-picker-empty">${escapeHtml(err.message || 'Could not load projects.')}</p>`;
      }
    }

    async function createProject() {
      const typed = nameInput.value.trim();
      createBtn.disabled = true;
      try {
        const name = typed || await findUniqueProjectName('Untitled Project');
        const { id } = await createWebProject(name);
        done({ type: 'open', id, name });
      } catch (err) {
        createBtn.disabled = false;
        showAlert(err.message || 'Could not create project.', { title: 'Error' });
      }
    }

    createBtn.addEventListener('click', createProject);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createProject(); });

    const importYcBtn = overlay.querySelector('.project-picker-import-yc');
    const ycInput = overlay.querySelector('.project-picker-yc-input');
    importYcBtn.addEventListener('click', () => ycInput.click());
    ycInput.addEventListener('change', async () => {
      const file = ycInput.files?.[0];
      ycInput.value = '';
      if (!file) return;
      importYcBtn.disabled = true;
      try {
        const { id } = await importProjectYc(file);
        done({ type: 'open', id, name: '' });
      } catch (err) {
        importYcBtn.disabled = false;
        showAlert(err.message || 'Could not import project.', { title: 'Error' });
      }
    });

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
