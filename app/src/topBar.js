/**
 * Top menu bar: File, Add, Settings.
 */

import { setTheme, THEME_LIGHT, THEME_DARK } from './theme.js';

/**
 * @param {HTMLElement} root - App root (#app or body)
 * @param {{ openAddPromptModal: () => void, openAddDatasetModal: () => void, openCredentialsModal: () => void, onNewProject: () => void, onOpenProject: () => void, onSaveAsProject: () => void }} options
 * @returns {{ setAddMenuEnabled: (enabled: boolean) => void }}
 */
export function buildTopBar(root, { openAddPromptModal, openAddDatasetModal, openCredentialsModal, onNewProject, onOpenProject, onSaveAsProject }) {
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
    <button type="button" class="menu-option" data-action="save-as-project">Save as...</button>
  `;
  fileDrop.querySelector('[data-action="new-project"]').addEventListener('click', () => onNewProject?.());
  fileDrop.querySelector('[data-action="open-project"]').addEventListener('click', () => onOpenProject?.());
  fileDrop.querySelector('[data-action="save-as-project"]').addEventListener('click', () => onSaveAsProject?.());
  fileBtn.appendChild(fileDrop);
  bar.appendChild(fileBtn);

  const addMenuBtn = document.createElement('button');
  addMenuBtn.className = 'menu-item has-submenu';
  addMenuBtn.type = 'button';
  addMenuBtn.textContent = 'Create';
  const addDrop = document.createElement('div');
  addDrop.className = 'menu-dropdown';
  addDrop.innerHTML = `
    <button type="button" class="menu-option menu-option--add" data-action="new-prompt" disabled>New prompt...</button>
    <button type="button" class="menu-option menu-option--add" data-action="new-dataset" disabled>New source dataset...</button>
  `;
  const addOptions = addDrop.querySelectorAll('.menu-option--add');
  addDrop.querySelector('[data-action="new-prompt"]').addEventListener('click', () => { if (!addOptions[0].disabled) openAddPromptModal(); });
  addDrop.querySelector('[data-action="new-dataset"]').addEventListener('click', () => { if (!addOptions[1].disabled) openAddDatasetModal(); });
  addMenuBtn.appendChild(addDrop);
  bar.appendChild(addMenuBtn);

  function setAddMenuEnabled(enabled) {
    addOptions.forEach((el) => { el.disabled = !enabled; });
  }

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'menu-item has-submenu';
  settingsBtn.type = 'button';
  settingsBtn.textContent = 'Settings';
  const settingsDrop = document.createElement('div');
  settingsDrop.className = 'menu-dropdown';
  const credentialsOpt = document.createElement('button');
  credentialsOpt.type = 'button';
  credentialsOpt.className = 'menu-option';
  credentialsOpt.setAttribute('data-action', 'my-credentials');
  credentialsOpt.textContent = 'My credentials...';
  credentialsOpt.addEventListener('click', openCredentialsModal);
  settingsDrop.appendChild(credentialsOpt);
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

  root.insertBefore(bar, root.firstChild);
  return { setAddMenuEnabled };
}
