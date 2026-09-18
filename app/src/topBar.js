/**
 * Top menu bar: File, Edit, Settings.
 */

import { setTheme, THEME_LIGHT, THEME_DARK } from './theme.js';
import { openSettingsModal } from './settingsModal.js';
import { openPythonSettingsModal } from './pythonSettingsModal.js';
import { iconClose, iconMaximize, iconMinimize, iconRestore } from './modalMaximize.js';

/**
 * @param {HTMLElement} root - App root (#app or body)
 * @param {{ openAddPromptModal: () => void, openAddDatasetModal: () => void, onNewProject: () => void, onOpenProject: () => void, onSaveAsProject: () => void }} options
 * @returns {{ setAddMenuEnabled: (enabled: boolean) => void, setSaveAsEnabled: (enabled: boolean) => void, setProjectTitle: (title: string) => void }}
 */
export function buildTopBar(root, { openAddPromptModal, openAddDatasetModal, onNewProject, onOpenProject, onSaveAsProject }) {
  const bar = document.createElement('nav');
  bar.className = 'top-bar';

  const projectTitleEl = document.createElement('div');
  projectTitleEl.className = 'top-bar-project-title';
  projectTitleEl.textContent = 'Prompt Studio';
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
  `;
  fileDrop.querySelector('[data-action="new-project"]').addEventListener('click', () => onNewProject?.());
  fileDrop.querySelector('[data-action="open-project"]').addEventListener('click', () => onOpenProject?.());
  const saveAsOpt = fileDrop.querySelector('[data-action="save-as-project"]');
  saveAsOpt.addEventListener('click', () => { if (!saveAsOpt.disabled) onSaveAsProject?.(); });
  fileBtn.appendChild(fileDrop);
  bar.appendChild(fileBtn);

  const editBtn = document.createElement('button');
  editBtn.className = 'menu-item has-submenu';
  editBtn.type = 'button';
  editBtn.textContent = 'Edit';
  const editDrop = document.createElement('div');
  editDrop.className = 'menu-dropdown';
  editDrop.innerHTML = `
    <button type="button" class="menu-option menu-option--create" data-action="new-prompt" disabled>Create new prompt...</button>
    <button type="button" class="menu-option menu-option--create" data-action="new-dataset" disabled>Create new dataset...</button>
  `;
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
  // 高对比模式已注释
  // <button type="button" class="menu-option" data-mode="high-contrast">High contrast</button>
  // submenu.querySelector('[data-mode="high-contrast"]').addEventListener('click', () => setTheme(THEME_HIGH_CONTRAST));
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
  // A browser tab has its own chrome; these only make sense inside Electron's frameless window.
  if (window.electronAPI) {
    bar.appendChild(windowControls);
    window.electronAPI.isWindowMaximized?.().then(applyMaximizedState).catch(() => {});
    window.electronAPI.onWindowMaximizedChanged?.(applyMaximizedState);
  }

  root.insertBefore(bar, root.firstChild);

  function setSaveAsEnabled(enabled) {
    saveAsOpt.disabled = !enabled;
  }

  function setProjectTitle(title) {
    const normalized = String(title || '').trim();
    projectTitleEl.textContent = normalized || 'Prompt Studio';
    projectTitleEl.title = normalized || 'Prompt Studio';
  }

  return { setAddMenuEnabled, setSaveAsEnabled, setProjectTitle };
}
