/**
 * Top menu bar: File, Edit, Settings.
 */

import { setTheme, THEME_LIGHT, THEME_DARK } from './theme.js';
import { openSettingsModal } from './settingsModal.js';

/**
 * @param {HTMLElement} root - App root (#app or body)
 * @param {{ openAddPromptModal: () => void, openAddDatasetModal: () => void, onNewProject: () => void, onOpenProject: () => void, onSaveAsProject: () => void }} options
 * @returns {{ setAddMenuEnabled: (enabled: boolean) => void, setSaveAsEnabled: (enabled: boolean) => void }}
 */
export function buildTopBar(root, { openAddPromptModal, openAddDatasetModal, onNewProject, onOpenProject, onSaveAsProject }) {
  const bar = document.createElement('nav');
  bar.className = 'top-bar';

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
  runReviewDefaultsOpt.textContent = 'Model settings...';
  runReviewDefaultsOpt.addEventListener('click', openSettingsModal);
  settingsDrop.appendChild(runReviewDefaultsOpt);
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

  root.insertBefore(bar, root.firstChild);

  function setSaveAsEnabled(enabled) {
    saveAsOpt.disabled = !enabled;
  }

  return { setAddMenuEnabled, setSaveAsEnabled };
}
