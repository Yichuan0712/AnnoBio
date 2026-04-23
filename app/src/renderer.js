/**
 * Renderer entry: theme, top bar, workflow canvas.
 * Node.js integration is disabled (recommended).
 */

function showError(msg, err) {
  const root = document.getElementById('app') || document.body;
  if (root && !root.querySelector('.renderer-error-box')) {
    const box = document.createElement('div');
    box.className = 'renderer-error-box';
    box.style.cssText = 'padding:20px;font-family:system-ui;color:#c00;white-space:pre-wrap;background:#fff;margin:8px;border:1px solid #c00;';
    box.textContent = msg + (err ? '\n\n' + (err.stack || err.message || err) : '');
    root.insertBefore(box, root.firstChild);
  }
  console.error(msg, err);
}

window.addEventListener('error', (e) => { showError('Uncaught error: ' + (e.message || e), e.error); });
window.addEventListener('unhandledrejection', (e) => { showError('Unhandled promise rejection', e.reason); });

import './index.css';
import './topBar.css';
import './workflowCanvas.css';
import './modals.css';
import './agentWindow.css';
import { getStoredTheme, setTheme } from './theme.js';
import { buildTopBar } from './topBar.js';
import { buildWorkflowCanvas } from './workflowCanvas.js';
import { openAddPromptModal } from './addPromptModal.js';
import { openAddDatasetModal } from './addDatasetModal.js';
import { initModalDrag } from './modalDrag.js';
import { initModalMaximize } from './modalMaximize.js';

function showInitError(err) {
  const root = document.getElementById('app') || document.body;
  root.innerHTML = `<div style="padding:20px;font-family:system-ui;color:#c00;white-space:pre-wrap;">Init error:\n${err?.message || err}\n\n${err?.stack || ''}</div>`;
  console.error('Init error', err);
}

window.addEventListener('DOMContentLoaded', () => {
  let root;
  try {
    root = document.getElementById('app') || document.body;
    const loadingEl = root.querySelector('.app-loading');
    if (loadingEl) loadingEl.remove();

    setTheme(getStoredTheme());
    initModalDrag();
    initModalMaximize();

    window.electronAPI?.onSetTheme?.(setTheme);

    const appBody = document.createElement('div');
    appBody.className = 'app-body';
    const appMain = document.createElement('main');
    appMain.className = 'app-main';
    appBody.appendChild(appMain);
    root.appendChild(appBody);

    let currentProjectPath = null;
    const canvasAPI = buildWorkflowCanvas(appMain, {
      getCurrentProjectPath: () => currentProjectPath,
    });

  const APP_TITLE = 'Prompt Studio';
  function updateWindowTitle(projectPath) {
    let name = projectPath ? projectPath.replace(/^.*[/\\]/, '') : null;
    if (name && name.endsWith('.json')) name = name.slice(0, -5);
    document.title = name ? `${name} - ${APP_TITLE}` : APP_TITLE;
  }

  const onNewProject = async () => {
    const api = window.electronAPI;
    if (!api?.showNewProjectDialog) return;
    const path = await api.showNewProjectDialog();
    if (!path) return;
    currentProjectPath = path;
    updateWindowTitle(path);
    const state = canvasAPI.getCanvasState();
    await api.saveProject(path, state);
    topBarAPI.setAddMenuEnabled(true);
    topBarAPI.setSaveAsEnabled?.(true);
    canvasAPI.setAgentWindowVisible?.(true);
  };

  const onOpenProject = async () => {
    const api = window.electronAPI;
    if (!api?.showOpenProjectDialog || !api?.loadProject) return;
    const path = await api.showOpenProjectDialog();
    if (!path) return;
    const state = await api.loadProject(path);
    canvasAPI.loadCanvasState(state);
    currentProjectPath = path;
    updateWindowTitle(path);
    topBarAPI.setAddMenuEnabled(true);
    topBarAPI.setSaveAsEnabled?.(true);
    canvasAPI.setAgentWindowVisible?.(true);
  };

  const onSaveAsProject = async () => {
    const api = window.electronAPI;
    if (!api?.showSaveAsProjectDialog || !api?.saveProject) return;
    const path = await api.showSaveAsProjectDialog(currentProjectPath || undefined);
    if (!path) return;
    const state = canvasAPI.getCanvasState();
    await api.saveProject(path, state);
    currentProjectPath = path;
    updateWindowTitle(path);
    topBarAPI.setAddMenuEnabled(true);
    topBarAPI.setSaveAsEnabled?.(true);
    canvasAPI.setAgentWindowVisible?.(true);
  };

  const topBarAPI = buildTopBar(root, {
    openAddPromptModal: () => openAddPromptModal(canvasAPI),
    openAddDatasetModal: () => openAddDatasetModal(canvasAPI),
    onNewProject,
    onOpenProject,
    onSaveAsProject,
  });
  topBarAPI.setAddMenuEnabled(false);
  canvasAPI.setAgentWindowVisible?.(false);

  let saveTimeout = null;
  canvasAPI.setOnCanvasChange(() => {
    if (!currentProjectPath || !window.electronAPI?.saveProject) return;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      const state = canvasAPI.getCanvasState();
      await window.electronAPI.saveProject(currentProjectPath, state);
    }, 400);
  });
  } catch (err) {
    showInitError(err);
  }
});
