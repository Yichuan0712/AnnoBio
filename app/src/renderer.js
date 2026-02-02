/**
 * This file will automatically be loaded by vite and run in the "renderer" context.
 * Node.js integration is disabled (recommended). We'll just use fetch().
 */

import './index.css';

const THEME_KEY = 'app-display-mode';
const THEME_LIGHT = 'light';
const THEME_DARK = 'dark';

function getStoredTheme() {
  return localStorage.getItem(THEME_KEY) || THEME_LIGHT;
}

function setTheme(mode) {
  const html = document.documentElement;
  if (mode === THEME_DARK) {
    html.classList.add('dark');
  } else {
    html.classList.remove('dark');
  }
  localStorage.setItem(THEME_KEY, mode);
}

function buildTopBar(root) {
  const bar = document.createElement('nav');
  bar.className = 'top-bar';

  const fileBtn = document.createElement('button');
  fileBtn.className = 'menu-item has-submenu';
  fileBtn.type = 'button';
  fileBtn.textContent = 'File';
  const fileDrop = document.createElement('div');
  fileDrop.className = 'menu-dropdown';
  fileDrop.innerHTML = `
    <button type="button" class="menu-option">New project...</button>
    <button type="button" class="menu-option">Open project...</button>
  `;
  fileBtn.appendChild(fileDrop);
  bar.appendChild(fileBtn);

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'menu-item has-submenu';
  settingsBtn.type = 'button';
  settingsBtn.textContent = 'Settings';
  const settingsDrop = document.createElement('div');
  settingsDrop.className = 'menu-dropdown';
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
}

window.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app') || document.body;
  setTheme(getStoredTheme());

  window.electronAPI?.onSetTheme?.(setTheme);

  buildTopBar(root);

  const canvas = document.createElement('div');
  canvas.className = 'workflow-canvas';
  root.appendChild(canvas);
});
