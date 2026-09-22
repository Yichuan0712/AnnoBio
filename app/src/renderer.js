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
import { getStoredTheme, setTheme, THEME_LIGHT } from './theme.js';
import { buildTopBar } from './topBar.js';
import { buildWorkflowCanvas } from './workflowCanvas.js';
import { openAddPromptModal } from './addPromptModal.js';
import { openAddDatasetModal } from './addDatasetModal.js';
import { initModalDrag } from './modalDrag.js';
import { initModalMaximize } from './modalMaximize.js';
import { showProjectPickerModal, loadWebProject, saveWebProject, createWebProject, findUniqueProjectName } from './webProjectModal.js';
import { showAlert } from './alertModal.js';
import { setCurrentProjectId } from './currentProject.js';
import { createUndoHistory } from './undoHistory.js';

// Web has no "recent files" of its own the way the OS gives desktop one — without this, every
// page refresh drops back to "Open a project" even though the project itself is untouched. Falls
// back silently (and forgets the id) if the stored project no longer loads, e.g. it was deleted.
const WEB_LAST_PROJECT_KEY = 'promptStudio.web.lastProjectId';
function getStoredWebProjectId() {
  try { return localStorage.getItem(WEB_LAST_PROJECT_KEY) || null; } catch (_) { return null; }
}
function setStoredWebProjectId(id) {
  try {
    if (id) localStorage.setItem(WEB_LAST_PROJECT_KEY, id);
    else localStorage.removeItem(WEB_LAST_PROJECT_KEY);
  } catch (_) { /* private mode / storage blocked — just skip persistence */ }
}

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

    const isElectron = !!window.electronAPI;
    // Web has no theme switcher (see topBar.js) — always light, regardless of what a previous
    // desktop session on this machine left in localStorage or what the OS prefers.
    setTheme(isElectron ? getStoredTheme() : THEME_LIGHT);
    initModalDrag();
    initModalMaximize();

    window.electronAPI?.onSetTheme?.(setTheme);

    const appBody = document.createElement('div');
    appBody.className = 'app-body';
    const appMain = document.createElement('main');
    appMain.className = 'app-main';
    appBody.appendChild(appMain);
    root.appendChild(appBody);

    let currentProjectPath = null; // desktop: absolute file path. web: opaque project id.
    function setCurrentProject(path) {
      currentProjectPath = path;
      setCurrentProjectId(path);
    }
    const canvasAPI = buildWorkflowCanvas(appMain, {
      getCurrentProjectPath: () => currentProjectPath,
      isElectron,
    });

  const APP_TITLE = 'AnnoBio';
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
    undoHistory.reset(state);
    canvasAPI.clearSelection?.();
    await api.saveProject(path, state);
    topBarAPI.setAddMenuEnabled(true);
    topBarAPI.setSaveAsEnabled?.(true);
    topBarAPI.setMergeEnabled?.(true);
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
    undoHistory.reset(canvasAPI.getCanvasState());
    canvasAPI.clearSelection?.();
    setCurrentProject(resolvedPath);
    updateWindowTitleFromPath(resolvedPath);
    topBarAPI.setAddMenuEnabled(true);
    topBarAPI.setSaveAsEnabled?.(true);
    topBarAPI.setMergeEnabled?.(true);
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
    topBarAPI.setMergeEnabled?.(true);
    canvasAPI.setAgentWindowVisible?.(true);
  };

  const onMergeProjectDesktop = async () => {
    const api = window.electronAPI;
    if (!api?.showMergeSourceDialog || !api?.mergeProject || !currentProjectPath) return;
    const sourcePath = await api.showMergeSourceDialog();
    if (!sourcePath) return;
    try {
      const mergedState = await api.mergeProject(currentProjectPath, sourcePath);
      canvasAPI.loadCanvasState(mergedState);
      undoHistory.reset(canvasAPI.getCanvasState());
      canvasAPI.clearSelection?.();
    } catch (err) {
      showAlert(err.message || 'Could not merge project.', { title: 'Error' });
    }
  };

  // Web: New and Open both surface the same picker (list existing / create new) since there's
  // no native "Open File" dialog in a browser — see webProjectModal.js. `silent` is used by the
  // page-load restore attempt below, where a stale/deleted project id should just fall back to
  // the empty state instead of popping an error dialog on every refresh.
  const openProjectWeb = async ({ id, name }, { silent = false } = {}) => {
    try {
      const project = await loadWebProject(id);
      canvasAPI.loadCanvasState(project.state || {});
      undoHistory.reset(canvasAPI.getCanvasState());
      canvasAPI.clearSelection?.();
      setCurrentProject(id);
      setStoredWebProjectId(id);
      updateWindowTitle(project.name || name);
      topBarAPI.setAddMenuEnabled(true);
      topBarAPI.setSaveAsEnabled?.(true);
      topBarAPI.setMergeEnabled?.(true);
      canvasAPI.setAgentWindowVisible?.(true);
    } catch (err) {
      if (silent) { setStoredWebProjectId(null); return; }
      showAlert(err.message || 'Could not open project.', { title: 'Error' });
    }
  };

  // The picker doubles as the merge entry point (click a project's "merge into current" button
  // instead of "open") when a project is already open — see webProjectModal.js.
  const onNewOrOpenProjectWeb = async () => {
    const picked = await showProjectPickerModal(currentProjectPath);
    if (!picked) return;
    if (picked.type === 'merged') {
      canvasAPI.loadCanvasState(picked.state);
      undoHistory.reset(canvasAPI.getCanvasState());
      canvasAPI.clearSelection?.();
      return;
    }
    await openProjectWeb(picked);
  };

  const onNewProject = isElectron ? onNewProjectDesktop : onNewOrOpenProjectWeb;
  const onOpenProject = isElectron ? onOpenProjectDesktop : onNewOrOpenProjectWeb;
  // Web has no "Save as" entry point anymore — Duplicate lives in the project picker instead
  // (webProjectModal.js), working on any listed project rather than just the one that's open.
  const onSaveAsProject = isElectron ? onSaveAsProjectDesktop : undefined;

  // Web's Create-prompt/dataset buttons are always enabled (see topBar.js) — with no project
  // open yet, clicking one just creates an Untitled Project first instead of requiring you to
  // go through the picker separately.
  const ensureWebProjectOpen = async () => {
    if (currentProjectPath) return true;
    try {
      const name = await findUniqueProjectName('Untitled Project');
      const { id } = await createWebProject(name);
      await openProjectWeb({ id, name });
      return true;
    } catch (err) {
      showAlert(err.message || 'Could not create project.', { title: 'Error' });
      return false;
    }
  };
  const openAddPromptModalWeb = async () => {
    if (await ensureWebProjectOpen()) openAddPromptModal(canvasAPI);
  };
  const openAddDatasetModalWeb = async () => {
    if (await ensureWebProjectOpen()) openAddDatasetModal(canvasAPI);
  };

  // Undo/redo: snapshot-based (see undoHistory.js), scoped to whatever project is currently
  // open — reset() is called everywhere a different project's state gets loaded in below.
  let notifyUndoRedo = () => {};
  const undoHistory = createUndoHistory({
    loadCanvasState: (state) => canvasAPI.loadCanvasState(state),
    onChange: (info) => notifyUndoRedo(info),
  });
  undoHistory.reset(canvasAPI.getCanvasState());
  canvasAPI.setOnCanvasChange(() => undoHistory.push(canvasAPI.getCanvasState()));

  const topBarAPI = buildTopBar(root, {
    openAddPromptModal: isElectron ? () => openAddPromptModal(canvasAPI) : openAddPromptModalWeb,
    openAddDatasetModal: isElectron ? () => openAddDatasetModal(canvasAPI) : openAddDatasetModalWeb,
    onNewProject,
    onOpenProject,
    onSaveAsProject,
    onMergeProject: isElectron ? onMergeProjectDesktop : undefined,
    onUndo: () => undoHistory.undo(),
    onRedo: () => undoHistory.redo(),
  });
  notifyUndoRedo = ({ canUndo, canRedo }) => topBarAPI.setUndoRedoEnabled?.(canUndo, canRedo);
  topBarAPI.setProjectTitle?.(APP_TITLE);
  topBarAPI.setAddMenuEnabled(false);
  canvasAPI.setAgentWindowVisible?.(false);

  // Keyboard shortcuts — Delete/Backspace and undo/redo are ignored while typing in a field
  // (including CodeMirror's process-node editor) so they don't fight normal text editing there.
  // Escape (clear selection) isn't gated the same way — it doesn't collide with anything a text
  // field itself does with Escape, so it's fine to also fire while a field has focus.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') canvasAPI.clearSelection?.();

    const active = document.activeElement;
    const tag = active?.tagName;
    const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      || active?.isContentEditable || !!active?.closest?.('.cm-editor');
    if (isEditable) return;

    const isUndo = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z' && !e.shiftKey;
    const isRedo = (e.ctrlKey || e.metaKey) && !e.altKey && (
      (e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y'
    );
    if (isUndo || isRedo) {
      e.preventDefault();
      if (isUndo) undoHistory.undo(); else undoHistory.redo();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      canvasAPI.deleteSelectedNodes?.();
    }
  });

  if (!isElectron) {
    // Arriving from the Hub's Profile page (see hub/main.py) with ?open=<id> — a specific
    // workspace was picked there, so it wins over the usual "reopen the last project" restore.
    const openId = new URLSearchParams(window.location.search).get('open');
    if (openId) {
      const url = new URL(window.location.href);
      url.searchParams.delete('open');
      window.history.replaceState({}, '', url);
      openProjectWeb({ id: openId, name: '' });
    } else {
      const lastId = getStoredWebProjectId();
      if (lastId) openProjectWeb({ id: lastId, name: '' }, { silent: true });
    }
  }

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
