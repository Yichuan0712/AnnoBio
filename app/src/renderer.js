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
import { showProjectPickerModal, loadWebProject, saveWebProject } from './webProjectModal.js';
import { showAlert } from './alertModal.js';
import { setCurrentProjectId } from './currentProject.js';

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

    const isElectron = !!window.electronAPI;
    let currentProjectPath = null; // desktop: absolute file path. web: opaque project id.
    function setCurrentProject(path) {
      currentProjectPath = path;
      setCurrentProjectId(path);
    }
    const canvasAPI = buildWorkflowCanvas(appMain, {
      getCurrentProjectPath: () => currentProjectPath,
    });

  const APP_TITLE = 'Prompt Studio';
  function updateWindowTitle(displayName) {
    document.title = displayName ? `${displayName} - ${APP_TITLE}` : APP_TITLE;
    topBarAPI?.setProjectTitle?.(displayName || APP_TITLE);
  }

  function updateWindowTitleFromPath(projectPath) {
    let name = projectPath ? projectPath.replace(/^.*[/\\]/, '') : null;
    if (name && /\.(json|yc)$/i.test(name)) name = name.replace(/\.(json|yc)$/i, '');
    updateWindowTitle(name);
  }

  const onNewProjectDesktop = async () => {
    const api = window.electronAPI;
    if (!api?.showNewProjectDialog) return;
    const path = await api.showNewProjectDialog();
    if (!path) return;
    setCurrentProject(path);
    updateWindowTitleFromPath(path);
    const state = canvasAPI.getCanvasState();
    await api.saveProject(path, state);
    topBarAPI.setAddMenuEnabled(true);
    topBarAPI.setSaveAsEnabled?.(true);
    canvasAPI.setAgentWindowVisible?.(true);
  };

  const onOpenProjectDesktop = async () => {
    const api = window.electronAPI;
    if (!api?.showOpenProjectDialog || !api?.loadProject) return;
    const path = await api.showOpenProjectDialog();
    if (!path) return;
    const loaded = await api.loadProject(path);
    const state = loaded?.state || loaded;
    const resolvedPath = loaded?.resolvedPath || path;
    canvasAPI.loadCanvasState(state);
    setCurrentProject(resolvedPath);
    updateWindowTitleFromPath(resolvedPath);
    topBarAPI.setAddMenuEnabled(true);
    topBarAPI.setSaveAsEnabled?.(true);
    canvasAPI.setAgentWindowVisible?.(true);
  };

  const onSaveAsProjectDesktop = async () => {
    const api = window.electronAPI;
    if (!api?.showSaveAsProjectDialog || !api?.saveProject) return;
    const path = await api.showSaveAsProjectDialog(currentProjectPath || undefined);
    if (!path) return;
    const state = canvasAPI.getCanvasState();
    await api.saveProject(path, state);
    setCurrentProject(path);
    updateWindowTitleFromPath(path);
    topBarAPI.setAddMenuEnabled(true);
    topBarAPI.setSaveAsEnabled?.(true);
    canvasAPI.setAgentWindowVisible?.(true);
  };

  // Web: New and Open both surface the same picker (list existing / create new) since there's
  // no native "Open File" dialog in a browser — see webProjectModal.js.
  const openProjectWeb = async ({ id, name }) => {
    try {
      const project = await loadWebProject(id);
      canvasAPI.loadCanvasState(project.state || {});
      setCurrentProject(id);
      updateWindowTitle(project.name || name);
      topBarAPI.setAddMenuEnabled(true);
      topBarAPI.setSaveAsEnabled?.(true);
      canvasAPI.setAgentWindowVisible?.(true);
    } catch (err) {
      showAlert(err.message || 'Could not open project.', { title: 'Error' });
    }
  };

  const onNewOrOpenProjectWeb = async () => {
    const picked = await showProjectPickerModal();
    if (!picked) return;
    await openProjectWeb(picked);
  };

  const onSaveAsProjectWeb = async () => {
    const picked = await showProjectPickerModal();
    // The picker doubles as "save as" here: creating a fresh project from it and then
    // saving the current canvas into it approximates desktop's "duplicate under a new name".
    if (!picked) return;
    const state = canvasAPI.getCanvasState();
    try {
      await saveWebProject(picked.id, state);
      await openProjectWeb(picked);
    } catch (err) {
      showAlert(err.message || 'Could not save project.', { title: 'Error' });
    }
  };

  const onNewProject = isElectron ? onNewProjectDesktop : onNewOrOpenProjectWeb;
  const onOpenProject = isElectron ? onOpenProjectDesktop : onNewOrOpenProjectWeb;
  const onSaveAsProject = isElectron ? onSaveAsProjectDesktop : onSaveAsProjectWeb;

  const topBarAPI = buildTopBar(root, {
    openAddPromptModal: () => openAddPromptModal(canvasAPI),
    openAddDatasetModal: () => openAddDatasetModal(canvasAPI),
    onNewProject,
    onOpenProject,
    onSaveAsProject,
  });
  topBarAPI.setProjectTitle?.(APP_TITLE);
  topBarAPI.setAddMenuEnabled(false);
  canvasAPI.setAgentWindowVisible?.(false);

  let saveTimeout = null;
  canvasAPI.setOnCanvasChange(() => {
    if (!currentProjectPath) return;
    if (isElectron && !window.electronAPI?.saveProject) return;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      const state = canvasAPI.getCanvasState();
      if (isElectron) {
        await window.electronAPI.saveProject(currentProjectPath, state);
      } else {
        try {
          await saveWebProject(currentProjectPath, state);
        } catch (err) {
          showAlert(err.message || 'Could not save project.', { title: 'Error' });
        }
      }
    }, 400);
  });
  } catch (err) {
    showInitError(err);
  }
});
