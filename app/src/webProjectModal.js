/**
 * Web-only project picker. The browser has no native "Open File" dialog for this, so New and
 * Open both surface the same list-or-create modal, backed by backend/project_store.py's
 * /api/projects endpoints. Merge, duplicate, download and delete all live here too, as
 * per-project actions in the same list, rather than each getting a separate top-bar button or
 * near-duplicate modal. Desktop keeps using native save/open dialogs (see renderer.js) and
 * never imports this module's UI path.
 */
import { toBlob } from 'html-to-image';
import { BACKEND_API_BASE } from './backendConfig.js';
import { showAlert, showConfirm, showPrompt } from './alertModal.js';
import { iconMerge, iconPencil, iconCopy, iconDownload, iconTrash } from './icons.js';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(seconds) {
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleString();
}

/** Throws a friendly Error for a failed API response. If the Hub reports that this user's
 * per-user backend container couldn't be cold-started because the host is already at
 * PROMPT_STUDIO_MAX_ACTIVE_CONTAINERS (see hub/containers.py's CapacityExceeded and
 * hub/proxy.py), the thrown Error carries `.capacityExceeded = true` so callers that open a
 * workspace (see renderer.js) can point the user at the desktop app instead of just showing a
 * generic failure. */
async function throwApiError(res, fallbackMessage) {
  if (res.status === 503) {
    try {
      const body = await res.json();
      if (body?.error === 'capacity_exceeded') {
        const err = new Error(body.detail || 'The server is at capacity right now.');
        err.capacityExceeded = true;
        throw err;
      }
    } catch (err) {
      if (err?.capacityExceeded) throw err;
      // Not JSON (or no capacity marker) — fall through to the generic message below.
    }
  }
  throw new Error(fallbackMessage);
}

async function fetchProjects() {
  const res = await fetch(`${BACKEND_API_BASE}/api/projects`);
  if (!res.ok) await throwApiError(res, 'Could not load projects.');
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
  if (!res.ok) await throwApiError(res, 'Could not create project.');
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

/** Small title/description prompt for publishing — its own modal rather than reusing showConfirm
 * since it needs two text inputs, not just a yes/no. @returns {Promise<{title: string, description: string} | null>} */
function showPublishDetailsModal(defaultTitle) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="modal-panel modal-panel--alert">
        <div class="modal-header">
          <h2 class="modal-title">Publish to Gallery</h2>
          <button type="button" class="modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
          <p class="page-sub" style="margin:0 0 16px;color:var(--text-muted);font-size:13px;">
            Anyone can see and copy this into their own account — image/PDF files included.
          </p>
          <div class="agent-form">
            <div class="agent-form-field">
              <label class="dataset-meta-label" for="archive-publish-title">Title</label>
              <input type="text" id="archive-publish-title" class="dataset-meta-input" maxlength="200" />
            </div>
            <div class="agent-form-field">
              <label class="dataset-meta-label" for="archive-publish-desc">Description (optional)</label>
              <textarea id="archive-publish-desc" class="dataset-meta-input dataset-meta-textarea" rows="3" maxlength="2000"></textarea>
            </div>
          </div>
        </div>
        <div class="modal-alert-footer">
          <button type="button" class="btn btn-secondary archive-publish-cancel">Cancel</button>
          <button type="button" class="btn btn-primary archive-publish-confirm">Publish</button>
        </div>
      </div>
    `;
    const titleInp = overlay.querySelector('#archive-publish-title');
    const descInp = overlay.querySelector('#archive-publish-desc');
    titleInp.value = defaultTitle || '';

    function done(value) {
      overlay.remove();
      document.body.style.overflow = '';
      resolve(value);
    }
    overlay.querySelector('.modal-close').addEventListener('click', () => done(null));
    overlay.querySelector('.archive-publish-cancel').addEventListener('click', () => done(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    overlay.querySelector('.archive-publish-confirm').addEventListener('click', () => {
      const title = titleInp.value.trim();
      if (!title) { titleInp.focus(); return; }
      done({ title, description: descInp.value.trim() });
    });

    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
    titleInp.focus();
  });
}

/** Screenshots the live canvas viewport (whatever's currently visible/scrolled to) as a PNG blob —
 * used both for the Gallery listing's thumbnail and for the per-project preview on the Hub's
 * Profile page (see saveWebProjectThumbnail). Best-effort: a capture failure shouldn't block
 * publishing or autosave, it just means the listing falls back to an empty thumbnail. */
async function captureCanvasThumbnail() {
  const el = document.querySelector('.workflow-canvas');
  if (!el) return null;
  try {
    return await toBlob(el, { pixelRatio: 0.5, backgroundColor: '#ffffff' });
  } catch (_) {
    return null;
  }
}

/** Publishes `projectId` (must be the currently open project — see captureCanvasThumbnail) to the
 * Hub's public Gallery. Hub-level endpoint, not proxied per-user backend, so it's a plain relative
 * fetch rather than going through BACKEND_API_BASE (which points at this user's own container). */
async function publishProjectToArchive(projectId, title, description) {
  const thumbnail = await captureCanvasThumbnail();
  const formData = new FormData();
  formData.append('project_id', projectId);
  formData.append('title', title);
  formData.append('description', description);
  if (thumbnail) formData.append('thumbnail', thumbnail, 'thumbnail.png');
  const res = await fetch('/gallery/publish', { method: 'POST', body: formData });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || 'Could not publish to the Gallery.');
  }
  return res.json();
}

/** Screenshots the canvas and pushes it as `projectId`'s preview image, proxied through to this
 * user's own container (backend/project_store.py's PUT /{id}/thumbnail) — best-effort, same as
 * captureCanvasThumbnail itself: a failed capture or upload just leaves the previous (or no)
 * thumbnail in place rather than surfacing an error. Called after every successful autosave (see
 * renderer.js) so the Hub's Profile page can show a live-ish preview per workspace. */
export async function saveWebProjectThumbnail(projectId) {
  const thumbnail = await captureCanvasThumbnail();
  if (!thumbnail) return;
  const formData = new FormData();
  formData.append('file', thumbnail, 'thumbnail.png');
  try {
    await fetch(`${BACKEND_API_BASE}/api/projects/${projectId}/thumbnail`, { method: 'PUT', body: formData });
  } catch (_) { /* best-effort */ }
}

/** Full "Publish to Gallery" flow for `projectId` (the currently open project) — prompts for a
 * title/description, then publishes via publishProjectToArchive, showing a success/error alert.
 * Lives on the top bar itself (see topBar.js), not the project picker: publishing is a
 * broadcast-to-the-public action on the one project you have open, not a per-row list-management
 * action like Duplicate/Delete, so it doesn't belong mixed in among those. */
export async function publishCurrentProjectToGallery(projectId, projectName) {
  // Name lives on the account (Profile page), not asked here — checked up front so a missing
  // one is caught before typing a title/description, not after. The Hub enforces this too
  // (archive_publish in main.py); this is just so the failure shows up sooner.
  const who = await fetch('/whoami').then((res) => (res.ok ? res.json() : null)).catch(() => null);
  if (!who?.name?.trim()) {
    showAlert('Add your name on your Profile page before publishing.', { title: 'Profile incomplete' });
    return;
  }
  const details = await showPublishDetailsModal(projectName);
  if (!details) return;
  try {
    await publishProjectToArchive(projectId, details.title, details.description);
    showAlert('Submitted — an admin will review it before it appears in the Gallery.', { title: 'Submitted' });
  } catch (err) {
    showAlert(err.message || 'Could not publish to the Gallery.', { title: 'Error' });
  }
}

/**
 * Project picker: create/import/open/rename/duplicate/download/delete, plus — only when
 * currentProjectId is given — a "Merge into current" action per row, so merging doesn't need
 * its own top-bar button or its own near-duplicate modal.
 * @param {string | null} [currentProjectId] the currently open project, if any. Its own row
 *   gets no merge button (a project can't merge into itself).
 * @param {{ onRenamed?: (name: string) => void }} [options] onRenamed fires only when the row
 *   renamed is currentProjectId's, since renaming happens in-place here rather than through the
 *   resolved value — the picker stays open afterwards and may never resolve with a pick at all.
 * @returns {Promise<{ type: 'open', id: string, name: string } | { type: 'merged', state: object } | null>}
 *   null if closed without picking anything.
 */
export function showProjectPickerModal(currentProjectId = null, options = {}) {
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

          const renameBtn = document.createElement('button');
          renameBtn.type = 'button';
          renameBtn.className = 'project-picker-rename';
          renameBtn.setAttribute('aria-label', `Rename ${project.name}`);
          renameBtn.title = 'Rename';
          renameBtn.appendChild(iconPencil(15));
          renameBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const name = await showPrompt('Project name', {
              title: 'Rename project', confirmText: 'Rename', initialValue: project.name,
            });
            if (name === null || name === project.name) return;
            try {
              const res = await fetch(`${BACKEND_API_BASE}/api/projects/${project.id}/name`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
              });
              if (!res.ok) throw new Error('Could not rename project.');
              const saved = await res.json();
              if (project.id === currentProjectId) options.onRenamed?.(saved.name || name);
              refresh();
            } catch (err) {
              showAlert(err.message || 'Could not rename project.', { title: 'Error' });
            }
          });
          row.appendChild(renameBtn);

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
  if (!res.ok) await throwApiError(res, 'Could not load project.');
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
