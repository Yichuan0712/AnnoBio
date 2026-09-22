/**
 * Top bar. Desktop and web are two genuinely separate renders, not one shared render with
 * conditionals — desktop keeps the exact original File/Edit/Settings text menu (plus the
 * Merge item added since), unchanged; only the web build gets the icon-rail redesign. Keeping
 * them as separate functions is deliberate: a shared function with scattered `if (electronAPI)`
 * branches is exactly what let the desktop UI drift last time this was redesigned.
 */

import { setTheme, THEME_LIGHT, THEME_DARK } from './theme.js';
import { openSettingsModal } from './settingsModal.js';
import { openPythonSettingsModal } from './pythonSettingsModal.js';
import { iconClose, iconMaximize, iconMinimize, iconRestore } from './modalMaximize.js';

/**
 * @param {HTMLElement} root - App root (#app or body)
 * @param {{ openAddPromptModal: () => void, openAddDatasetModal: () => void, onNewProject: () => void, onOpenProject: () => void, onSaveAsProject: () => void, onMergeProject?: () => void, onUndo?: () => void, onRedo?: () => void }} options
 * @returns {{ setAddMenuEnabled: (enabled: boolean) => void, setSaveAsEnabled: (enabled: boolean) => void, setMergeEnabled: (enabled: boolean) => void, setProjectTitle: (title: string) => void, setUndoRedoEnabled: (canUndo: boolean, canRedo: boolean) => void }}
 */
export function buildTopBar(root, options) {
  return window.electronAPI ? buildDesktopTopBar(root, options) : buildWebTopBar(root, options);
}

// ============================================================================================
// Desktop — unchanged from the original File/Edit/Settings menu bar (Merge item added, nothing
// else). Do not fold this into buildWebTopBar or add electronAPI branches to it.
// ============================================================================================
function buildDesktopTopBar(root, { openAddPromptModal, openAddDatasetModal, onNewProject, onOpenProject, onSaveAsProject, onMergeProject, onUndo, onRedo }) {
  const bar = document.createElement('nav');
  bar.className = 'top-bar';

  const projectTitleEl = document.createElement('div');
  projectTitleEl.className = 'top-bar-project-title';
  projectTitleEl.textContent = 'AnnoBio';
  bar.appendChild(projectTitleEl);

  const fileBtn = document.createElement('button');
  fileBtn.className = 'menu-item has-submenu';
  fileBtn.type = 'button';
  fileBtn.textContent = 'File';
  const fileDrop = document.createElement('div');
  fileDrop.className = 'menu-dropdown';
  fileDrop.innerHTML = `
    <button type="button" class="menu-option" data-action="new-project">New project...</button>
    <button type="button" class="menu-option" data-action="open-project">Open project...</button>
    <button type="button" class="menu-option" data-action="save-as-project" disabled>Save as...</button>
    <button type="button" class="menu-option" data-action="merge-project" disabled>Merge project into this one...</button>
  `;
  fileDrop.querySelector('[data-action="new-project"]').addEventListener('click', () => onNewProject?.());
  fileDrop.querySelector('[data-action="open-project"]').addEventListener('click', () => onOpenProject?.());
  const saveAsOpt = fileDrop.querySelector('[data-action="save-as-project"]');
  saveAsOpt.addEventListener('click', () => { if (!saveAsOpt.disabled) onSaveAsProject?.(); });
  const mergeOpt = fileDrop.querySelector('[data-action="merge-project"]');
  mergeOpt.addEventListener('click', () => { if (!mergeOpt.disabled) onMergeProject?.(); });
  fileBtn.appendChild(fileDrop);
  bar.appendChild(fileBtn);

  const editBtn = document.createElement('button');
  editBtn.className = 'menu-item has-submenu';
  editBtn.type = 'button';
  editBtn.textContent = 'Edit';
  const editDrop = document.createElement('div');
  editDrop.className = 'menu-dropdown';
  editDrop.innerHTML = `
    <button type="button" class="menu-option" data-action="undo" disabled>Undo</button>
    <button type="button" class="menu-option" data-action="redo" disabled>Redo</button>
    <div class="menu-separator"></div>
    <button type="button" class="menu-option menu-option--create" data-action="new-prompt" disabled>Create new prompt...</button>
    <button type="button" class="menu-option menu-option--create" data-action="new-dataset" disabled>Create new dataset...</button>
  `;
  const undoOpt = editDrop.querySelector('[data-action="undo"]');
  const redoOpt = editDrop.querySelector('[data-action="redo"]');
  undoOpt.addEventListener('click', () => { if (!undoOpt.disabled) onUndo?.(); });
  redoOpt.addEventListener('click', () => { if (!redoOpt.disabled) onRedo?.(); });
  const createPromptOpt = editDrop.querySelector('[data-action="new-prompt"]');
  const createDatasetOpt = editDrop.querySelector('[data-action="new-dataset"]');
  createPromptOpt.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!createPromptOpt.disabled) openAddPromptModal();
  });
  createDatasetOpt.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!createDatasetOpt.disabled) openAddDatasetModal();
  });
  editBtn.appendChild(editDrop);
  bar.appendChild(editBtn);

  function setAddMenuEnabled(enabled) {
    createPromptOpt.disabled = !enabled;
    createDatasetOpt.disabled = !enabled;
  }

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'menu-item has-submenu';
  settingsBtn.type = 'button';
  settingsBtn.textContent = 'Settings';
  const settingsDrop = document.createElement('div');
  settingsDrop.className = 'menu-dropdown';
  const runReviewDefaultsOpt = document.createElement('button');
  runReviewDefaultsOpt.type = 'button';
  runReviewDefaultsOpt.className = 'menu-option';
  runReviewDefaultsOpt.setAttribute('data-action', 'model-settings');
  runReviewDefaultsOpt.textContent = 'LLM settings...';
  runReviewDefaultsOpt.addEventListener('click', openSettingsModal);
  settingsDrop.appendChild(runReviewDefaultsOpt);
  const pythonSettingsOpt = document.createElement('button');
  pythonSettingsOpt.type = 'button';
  pythonSettingsOpt.className = 'menu-option';
  pythonSettingsOpt.setAttribute('data-action', 'python-settings');
  pythonSettingsOpt.textContent = 'Python settings...';
  pythonSettingsOpt.addEventListener('click', openPythonSettingsModal);
  settingsDrop.appendChild(pythonSettingsOpt);
  const displayModeOpt = document.createElement('button');
  displayModeOpt.type = 'button';
  displayModeOpt.className = 'menu-option has-submenu';
  displayModeOpt.textContent = 'Display mode';
  const submenu = document.createElement('div');
  submenu.className = 'submenu';
  submenu.innerHTML = `
    <button type="button" class="menu-option" data-mode="light">Light</button>
    <button type="button" class="menu-option" data-mode="dark">Dark</button>
  `;
  submenu.querySelector('[data-mode="light"]').addEventListener('click', () => setTheme(THEME_LIGHT));
  submenu.querySelector('[data-mode="dark"]').addEventListener('click', () => setTheme(THEME_DARK));
  displayModeOpt.appendChild(submenu);
  settingsDrop.appendChild(displayModeOpt);
  settingsBtn.appendChild(settingsDrop);
  bar.appendChild(settingsBtn);

  const spacer = document.createElement('div');
  spacer.className = 'top-bar-spacer';
  bar.appendChild(spacer);

  const windowControls = document.createElement('div');
  windowControls.className = 'top-bar-window-controls';

  const minimizeBtn = document.createElement('button');
  minimizeBtn.className = 'top-bar-window-btn';
  minimizeBtn.type = 'button';
  minimizeBtn.setAttribute('aria-label', 'Minimize window');
  minimizeBtn.title = 'Minimize';
  minimizeBtn.appendChild(iconMinimize());
  minimizeBtn.addEventListener('click', () => {
    window.electronAPI?.minimizeWindow?.();
  });

  const maximizeBtn = document.createElement('button');
  maximizeBtn.className = 'top-bar-window-btn';
  maximizeBtn.type = 'button';

  function applyMaximizedState(isMaximized) {
    maximizeBtn.dataset.maximized = isMaximized ? 'true' : 'false';
    maximizeBtn.setAttribute('aria-label', isMaximized ? 'Restore window' : 'Maximize window');
    maximizeBtn.title = isMaximized ? 'Restore' : 'Maximize';
    maximizeBtn.innerHTML = '';
    maximizeBtn.appendChild(isMaximized ? iconRestore() : iconMaximize());
  }

  applyMaximizedState(false);
  maximizeBtn.addEventListener('click', async () => {
    const next = await window.electronAPI?.toggleMaximizeWindow?.();
    applyMaximizedState(!!next);
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'top-bar-window-btn top-bar-window-btn--close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close window');
  closeBtn.title = 'Close';
  closeBtn.appendChild(iconClose());
  closeBtn.addEventListener('click', () => {
    window.electronAPI?.closeWindow?.();
  });

  windowControls.appendChild(minimizeBtn);
  windowControls.appendChild(maximizeBtn);
  windowControls.appendChild(closeBtn);
  bar.appendChild(windowControls);
  window.electronAPI.isWindowMaximized?.().then(applyMaximizedState).catch(() => {});
  window.electronAPI.onWindowMaximizedChanged?.(applyMaximizedState);

  root.insertBefore(bar, root.firstChild);

  function setSaveAsEnabled(enabled) {
    saveAsOpt.disabled = !enabled;
  }

  function setMergeEnabled(enabled) {
    mergeOpt.disabled = !enabled;
  }

  function setProjectTitle(title) {
    const normalized = String(title || '').trim();
    projectTitleEl.textContent = normalized || 'AnnoBio';
    projectTitleEl.title = normalized || 'AnnoBio';
  }

  function setUndoRedoEnabled(canUndo, canRedo) {
    undoOpt.disabled = !canUndo;
    redoOpt.disabled = !canRedo;
  }

  return { setAddMenuEnabled, setSaveAsEnabled, setMergeEnabled, setProjectTitle, setUndoRedoEnabled };
}

// ============================================================================================
// Web — brand mark, current project (click to switch), icon-rail of actions in place of the
// text menu (see the "Icon rail" concept this was picked from). Never rendered in Electron.
// ============================================================================================

function svgIcon({ paths = [], circles = [], ellipses = [], rects = [], lines = [], viewBox = '0 0 24 24', size = 16 } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  paths.forEach((d) => {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  });
  circles.forEach(([cx, cy, r]) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', String(cy));
    c.setAttribute('r', String(r));
    svg.appendChild(c);
  });
  ellipses.forEach(([cx, cy, rx, ry]) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    e.setAttribute('cx', String(cx));
    e.setAttribute('cy', String(cy));
    e.setAttribute('rx', String(rx));
    e.setAttribute('ry', String(ry));
    svg.appendChild(e);
  });
  rects.forEach(([x, y, w, h, r]) => {
    const rc = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rc.setAttribute('x', String(x));
    rc.setAttribute('y', String(y));
    rc.setAttribute('width', String(w));
    rc.setAttribute('height', String(h));
    if (r != null) { rc.setAttribute('rx', String(r)); rc.setAttribute('ry', String(r)); }
    svg.appendChild(rc);
  });
  lines.forEach(([x1, y1, x2, y2]) => {
    const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', String(x1));
    l.setAttribute('y1', String(y1));
    l.setAttribute('x2', String(x2));
    l.setAttribute('y2', String(y2));
    svg.appendChild(l);
  });
  return svg;
}

const iconAdd = () => svgIcon({ paths: ['M12 5v14', 'M5 12h14'] });
const iconChevronDown = () => svgIcon({ paths: ['m6 9 6 6 6-6'], size: 12 });

// Undo/redo — Lucide's "undo-2"/"redo-2" (a curved arrow looping into a horizontal bar), not the
// plain rotate-ccw arrow, so it reads as "step back" rather than "reload/refresh".
const iconUndo = () => svgIcon({
  paths: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11'],
});
const iconRedo = () => svgIcon({
  paths: ['m15 14 5-5-5-5', 'M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13'],
});

// Prompt = a text document, not a chat bubble (a chat implies back-and-forth; a prompt here is a
// reusable template). Lucide's "file-text", used at full size to match the other two icons.
const iconNewPrompt = () => svgIcon({
  paths: [
    'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
    'M14 2v5a1 1 0 0 0 1 1h5',
    'M10 9H8',
    'M16 13H8',
    'M16 17H8',
  ],
});

// Dataset = Lucide's "database", full size.
const iconNewDataset = () => svgIcon({
  ellipses: [[12, 5, 9, 3]],
  paths: ['M3 5V19A9 3 0 0 0 21 19V5', 'M3 12A9 3 0 0 0 21 12'],
});

// LLM settings = Lucide's "cpu", not a generic gear — reads as "the model" specifically rather
// than "app settings" in general.
const iconLlmChip = () => svgIcon({
  rects: [[4, 4, 16, 16, 2], [8, 8, 8, 8, 1]],
  lines: [
    [12, 20, 12, 22], [12, 2, 12, 4], [17, 20, 17, 22], [17, 2, 17, 4],
    [2, 12, 4, 12], [2, 17, 4, 17], [2, 7, 4, 7], [20, 12, 22, 12], [20, 17, 22, 17], [20, 7, 22, 7],
    [7, 20, 7, 22], [7, 2, 7, 4],
  ],
});

// Brand mark — two nodes flowing into one, drawn in Lucide's own style (24x24, 2px stroke, round
// caps/joins) to match every other icon here, but an original composition. Same markup as
// hub/main.py's BRAND_MARK_SVG — one icon, everywhere "AnnoBio" appears.
const iconBrandMark = () => svgIcon({
  rects: [[2, 8.5, 7, 7, 1.5], [14, 2, 7, 7, 1.5], [14, 15, 7, 7, 1.5]],
  paths: ['M9 12v-3a2 2 0 0 1 2-2h3', 'M9 12v3a2 2 0 0 0 2 2h3'],
});

function buildWebTopBar(root, { openAddPromptModal, openAddDatasetModal, onNewProject, onOpenProject, onUndo, onRedo }) {
  document.documentElement.classList.add('top-bar-web');

  const bar = document.createElement('nav');
  bar.className = 'top-bar top-bar--web';

  // ---- Brand mark + wordmark ----
  // Links back to the Hub's Home page (see hub/main.py) — the same nav.top's brand link does
  // there, so it behaves the same way whether you're on a Hub page or inside the app itself.
  const brand = document.createElement('div');
  brand.className = 'top-bar-brand';
  const brandLink = document.createElement('a');
  brandLink.className = 'top-bar-wordmark';
  brandLink.href = '/';
  brandLink.appendChild(iconBrandMark());
  brandLink.appendChild(document.createTextNode('AnnoBio'));
  brand.appendChild(brandLink);
  bar.appendChild(brand);

  const divider = document.createElement('div');
  divider.className = 'top-bar-divider';
  bar.appendChild(divider);

  // ---- Current project (click = switch/open) ----
  const projectBtn = document.createElement('button');
  projectBtn.type = 'button';
  projectBtn.className = 'top-bar-project';
  const projectNameEl = document.createElement('span');
  projectNameEl.className = 'top-bar-project-name';
  projectNameEl.textContent = 'AnnoBio';
  projectBtn.appendChild(projectNameEl);
  projectBtn.appendChild(iconChevronDown());
  projectBtn.title = 'Switch project';
  projectBtn.addEventListener('click', () => onOpenProject?.());
  bar.appendChild(projectBtn);

  // ---- Icon rail (sits right after the project name, not pushed to the far edge — the
  // spacer goes after it, so only the account avatar gets pushed right) ----
  const rail = document.createElement('div');
  rail.className = 'top-bar-rail';

  function iconButton({ icon, label, onClick }) {
    const wrap = document.createElement('div');
    wrap.className = 'top-bar-icon-item';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'top-bar-icon-btn';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.appendChild(icon());
    btn.addEventListener('click', onClick);
    wrap.appendChild(btn);
    return { wrap, btn };
  }

  // There's no "New project" or "Duplicate" button here. New/Open live on the project name
  // itself (left side) — a second entry doing the same thing just sat there feeling redundant.
  // Duplicate moved into the project picker (webProjectModal.js), grouped with Download/Delete
  // as a project-management action on any listed project, not just the one that's open — see
  // renderer.js's onSaveAsProject wiring, which web no longer uses.
  function setSaveAsEnabled() {}

  // Settings — first in the rail. Not project-scoped, so it's the one action that's always been
  // meaningful with nothing open yet. No Python settings (nothing local to browse for outside the
  // desktop app) and no Display mode (web is always light, see renderer.js's setTheme call — no
  // switcher to show), so it's a single action, not a dropdown.
  const undoBtn = iconButton({ icon: iconUndo, label: 'Undo', onClick: () => { if (!undoBtn.btn.disabled) onUndo?.(); } });
  const redoBtn = iconButton({ icon: iconRedo, label: 'Redo', onClick: () => { if (!redoBtn.btn.disabled) onRedo?.(); } });
  undoBtn.btn.disabled = true;
  redoBtn.btn.disabled = true;
  rail.appendChild(undoBtn.wrap);
  rail.appendChild(redoBtn.wrap);

  const settingsBtn = iconButton({ icon: iconLlmChip, label: 'LLM settings', onClick: openSettingsModal });
  rail.appendChild(settingsBtn.wrap);

  // Create prompt / dataset — always visible and always enabled, same as Settings: with no
  // project open yet, clicking one just creates a project first (see renderer.js's
  // ensureWebProjectOpen) instead of sitting hidden/disabled until you open one some other way.
  function setAddMenuEnabled() {}

  const newPromptBtn = iconButton({
    icon: iconNewPrompt,
    label: 'Create new prompt',
    onClick: () => openAddPromptModal(),
  });
  rail.appendChild(newPromptBtn.wrap);

  const newDatasetBtn = iconButton({
    icon: iconNewDataset,
    label: 'Create new dataset',
    onClick: () => openAddDatasetModal(),
  });
  rail.appendChild(newDatasetBtn.wrap);

  // No Merge button here — it's a per-row action in the project picker now (click the project
  // name), grouped with the other things you do to another project rather than the one you're
  // in. See webProjectModal.js and onOpenProject below.
  function setMergeEnabled() {}

  bar.appendChild(rail);

  const spacer = document.createElement('div');
  spacer.className = 'top-bar-spacer';
  bar.appendChild(spacer);

  // ---- Account avatar (only present when served by the Hub and logged in) — hover dropdown
  // with Profile + Log out, matching the Hub nav's own avatar (hub/main.py's render_nav) exactly,
  // so clicking the avatar behaves the same everywhere on the site. ----
  fetch('/whoami').then((res) => (res.ok ? res.json() : null)).then((who) => {
    const email = String(who?.email || '').trim();
    if (!email) return;
    const initials = email.slice(0, 2).toUpperCase();
    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'top-bar-icon-item has-submenu top-bar-avatar-item';
    avatarWrap.innerHTML = `
      <button type="button" class="top-bar-avatar" title="${email}" aria-label="Account: ${email}">${initials}</button>
      <div class="menu-dropdown top-bar-icon-dropdown top-bar-avatar-dropdown">
        <div class="top-bar-avatar-email">${email}</div>
        <a class="menu-option" href="/archive">Archive</a>
        <a class="menu-option" href="/profile">Profile</a>
        <button type="button" class="menu-option" data-action="logout">Log out</button>
      </div>
    `;
    avatarWrap.querySelector('[data-action="logout"]').addEventListener('click', async () => {
      await fetch('/logout', { method: 'POST' }).catch(() => {});
      window.location.href = '/login';
    });
    bar.appendChild(avatarWrap);
  }).catch(() => {});

  root.insertBefore(bar, root.firstChild);

  function setProjectTitle(title) {
    const normalized = String(title || '').trim();
    const isPlaceholder = !normalized || normalized === 'AnnoBio';
    projectNameEl.textContent = isPlaceholder ? 'Open a project' : normalized;
    projectBtn.title = isPlaceholder ? 'Open or create a project' : `${normalized} — click to switch project`;
    projectBtn.classList.toggle('top-bar-project--placeholder', isPlaceholder);
  }

  function setUndoRedoEnabled(canUndo, canRedo) {
    undoBtn.btn.disabled = !canUndo;
    redoBtn.btn.disabled = !canRedo;
  }

  return { setAddMenuEnabled, setSaveAsEnabled, setMergeEnabled, setProjectTitle, setUndoRedoEnabled };
}
