/**
 * Renderer entry: theme, top bar, workflow canvas.
 * Node.js integration is disabled (recommended).
 */

function showError(msg, err) {
  // Desktop: frontend exceptions join backend output in the Log tab.
  if (window.electronAPI) {
    reportAppError(msg, err);
    console.error(msg, err);
    return;
  }
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

window.addEventListener('error', (e) => {
  if (window.electronAPI) showError('Uncaught error', e.error || e.message);
  else showError('Uncaught error: ' + (e.message || e), e.error);
});
window.addEventListener('unhandledrejection', (e) => { showError('Unhandled promise rejection', e.reason); });

import './index.css';
import './topBar.css';
import './workflowCanvas.css';
import './modals.css';
import './agentWindow.css';
import { getStoredTheme, setTheme, THEME_LIGHT } from './theme.js';
import { buildTopBar } from './topBar.js';
import { buildWorkflowCanvas } from './workflowCanvas.js';
import { initModalDrag } from './modalDrag.js';
import { initModalMaximize } from './modalMaximize.js';
import { showProjectPickerModal, loadWebProject, saveWebProject, saveWebProjectThumbnail, createWebProject, findUniqueProjectName, publishCurrentProjectToGallery } from './webProjectModal.js';
import { showAlert, showConfirm } from './alertModal.js';
import { pipelineOwnerFor, setCurrentProjectId, setPipelineOwnerId } from './currentProject.js';
import { createUndoHistory } from './undoHistory.js';
import { reportAppError } from './appErrors.js';
import { pruneUnusedAssets as pruneUnusedAssetsWeb } from './webImageApi.js';
import { RunHistorySession } from './runHistorySession.js';
import { upgradeCanvasState } from './canvasFormat.js';
import { validateStepInputs } from './stepInputs.js';
import { loadRunHistoryIndex, loadRunHistoryRecord, saveRunHistoryRecord, deleteRunHistoryRecords } from './runHistoryStore.js';

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

// Import creation windows on their first use, rather than while the app is starting.
async function openAddPromptModal(api) {
  try { (await import('./addPromptModal.js')).openAddPromptModal(api); }
  catch (error) { showAlert(error?.message || 'Could not open the Prompt window.', { title: 'Prompt' }); }
}
async function openAddDatasetModal(api) {
  try { (await import('./addDatasetModal.js')).openAddDatasetModal(api); }
  catch (error) { showAlert(error?.message || 'Could not open the Dataset window.', { title: 'Dataset' }); }
}

export async function initializeApp({ onStartupStatus = () => {} } = {}) {
    const root = document.getElementById('app') || document.body;

    const isElectron = !!window.electronAPI;
    const requestedWebProjectId = isElectron ? null : new URLSearchParams(window.location.search).get('open');
    const initialWebProjectId = isElectron ? null : requestedWebProjectId || getStoredWebProjectId();
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
      projectLoading: !!initialWebProjectId,
    });
    const historyStore = {
      loadIndex: loadRunHistoryIndex,
      loadRecord: loadRunHistoryRecord,
      saveRecord: saveRunHistoryRecord,
      deleteRecords: deleteRunHistoryRecords,
      saveCanvas: (projectId, state) => isElectron
        ? window.electronAPI.saveProject(projectId, state)
        : saveWebProject(projectId, state),
    };
    let historySession = null;
    let historySync = Promise.resolve();
    let historySyncActive = false;
    let historySyncRequestedProjectId = null;
    let canvasChangeVersion = 0;
    const waitForHistoryChangeToSettle = () => new Promise((resolve) => setTimeout(resolve, 150));
    async function syncHistory(projectId) {
      for (let attempt = 0; attempt < 3 && historySession?.projectId === projectId && currentProjectPath === projectId; attempt += 1) {
        const result = await canvasAPI.reconcileHistory();
        if (!result?.stale) return;
        await waitForHistoryChangeToSettle();
      }
      if (historySession?.projectId === projectId && currentProjectPath === projectId) {
        throw new Error('History inputs kept changing. Try again after the current edits finish.');
      }
    }
    function queueHistorySync(projectId) {
      historySyncRequestedProjectId = projectId;
      if (historySyncActive) return;
      historySyncActive = true;
      historySync = (async () => {
        while (historySyncRequestedProjectId) {
          const nextProjectId = historySyncRequestedProjectId;
          historySyncRequestedProjectId = null;
          await waitForHistoryChangeToSettle();
          await syncHistory(nextProjectId);
        }
      })().finally(() => {
        historySyncActive = false;
        if (historySyncRequestedProjectId) queueHistorySync(historySyncRequestedProjectId);
      });
      // Autosave reports a failed sync; attach a handler now so it is never unhandled.
      historySync.catch(() => {});
    }
    async function loadCanvasWithHistory(projectId, savedState) {
      // A never-edited project is saved as {} (see backend create_project) — load it as an empty
      // canvas; loadCanvasState skips a state without a nodes array, leaving the previous project.
      // Every opened, merged or restored canvas is brought to the current format first (canvasFormat.js).
      const state = upgradeCanvasState({ ...savedState, nodes: savedState?.nodes || [], connections: savedState?.connections || [] });
      if (import.meta.env.DEV) {
        const problems = validateStepInputs(state);
        if (problems.length) console.warn('Step inputs that break the canvas format:', problems);
      }
      if (isElectron) state.pipelineOwner = await pipelineOwnerFor(projectId, savedState?.pipelineOwner);
      await historySync.catch(() => {});
      historySession = new RunHistorySession(historyStore);
      canvasAPI.setHistorySession(historySession);
      try {
        const opened = await historySession.open(projectId, state);
        canvasAPI.loadCanvasState(opened.state);
        await syncHistory(projectId);
        await canvasAPI.recoverHistoryJobs();
      } catch (error) {
        historySession = null;
        canvasAPI.setHistorySession(null);
        canvasAPI.loadCanvasState(state);
        showAlert(`History could not be loaded: ${error?.message || error}`, { title: 'Project history' });
      }
      // Pipeline History attaches only now, so it never acts on the previous project's canvas.
      if (isElectron && currentProjectPath === projectId) setPipelineOwnerId(state.pipelineOwner.id);
    }

  const APP_TITLE = 'AnnoBio';
  let currentProjectName = null;
  function updateWindowTitle(displayName) {
    currentProjectName = displayName || null;
    document.title = displayName ? `${displayName} - ${APP_TITLE}` : APP_TITLE;
    topBarAPI?.setProjectTitle?.(displayName || APP_TITLE);
  }

  function updateWindowTitleFromPath(projectPath) {
    let name = projectPath ? projectPath.replace(/^.*[/\\]/, '') : null;
    if (name && /\.(json|yc)$/i.test(name)) name = name.replace(/\.(json|yc)$/i, '');
    updateWindowTitle(name);
  }

  /** A blank project at `path`, which the user chose. `adoptAgentConversationId`: the Agent chat whose
   * create_project made it, which moves into the project and carries on (see syncProjectPanels). */
  const startNewProjectDesktop = async (path, { adoptAgentConversationId = '' } = {}) => {
    const api = window.electronAPI;
    setCurrentProject(path);
    updateWindowTitleFromPath(path);
    // Always a blank canvas — copying the open project into a new file is what Save as is for.
    const state = { version: 2, nodes: [], connections: [] };
    canvasAPI.clearSelection?.();
    await api.saveProject(path, state);
    await loadCanvasWithHistory(path, state);
    undoHistory.reset(canvasAPI.getCanvasState());
    topBarAPI.setAddMenuEnabled(true);
    topBarAPI.setSaveAsEnabled?.(true);
    topBarAPI.setMergeEnabled?.(true);
    await canvasAPI.syncProjectPanels?.({ adoptAgentConversationId });
  };

  const onNewProjectDesktop = async () => {
    const api = window.electronAPI;
    if (!api?.showNewProjectDialog) return;
    const path = await api.showNewProjectDialog();
    if (!path) return;
    await startNewProjectDesktop(path);
  };

  // The Agent's create_project card (agent/project/createProject.js): the user picks where to save,
  // as with File → New. Only offered while no project is open, which only the desktop app shows.
  canvasAPI.setAgentProjectCreator?.(async ({ name, adoptAgentConversationId }) => {
    const api = window.electronAPI;
    if (!api?.showNewProjectDialog) return { status: 'failed', error: 'Only the desktop app can create a project here.' };
    if (currentProjectPath) return { status: 'failed', error: 'A project is already open.' };
    const path = await api.showNewProjectDialog(name);
    if (!path) return { status: 'cancelled', feedback: 'The user closed the save dialog without choosing where to save the project.' };
    await startNewProjectDesktop(path, { adoptAgentConversationId });
    return { status: 'created', name: path.replace(/^.*[/\\]/, '').replace(/\.(json|yc)$/i, ''), path };
  });

  const onOpenProjectDesktop = async () => {
    const api = window.electronAPI;
    if (!api?.showOpenProjectDialog || !api?.loadProject) return;
    const path = await api.showOpenProjectDialog();
    if (!path) return;
    const loaded = await api.loadProject(path);
    const state = loaded?.state || loaded;
    const resolvedPath = loaded?.resolvedPath || path;
    setCurrentProject(resolvedPath);
    await loadCanvasWithHistory(resolvedPath, state);
    undoHistory.reset(canvasAPI.getCanvasState());
    canvasAPI.clearSelection?.();
    updateWindowTitleFromPath(resolvedPath);
    topBarAPI.setAddMenuEnabled(true);
    topBarAPI.setSaveAsEnabled?.(true);
    topBarAPI.setMergeEnabled?.(true);
    canvasAPI.syncProjectPanels?.();
  };

  const onSaveAsProjectDesktop = async () => {
    const api = window.electronAPI;
    if (!api?.showSaveAsProjectDialog || !api?.saveProject) return;
    const path = await api.showSaveAsProjectDialog(currentProjectPath || undefined);
    if (!path) return;
    const state = canvasAPI.getCanvasState();
    await api.saveProject(path, state, { copySessionFromCurrent: true });
    setCurrentProject(path);
    await loadCanvasWithHistory(path, state);
    updateWindowTitleFromPath(path);
    topBarAPI.setAddMenuEnabled(true);
    topBarAPI.setSaveAsEnabled?.(true);
    topBarAPI.setMergeEnabled?.(true);
    canvasAPI.syncProjectPanels?.();
  };

  const onMergeProjectDesktop = async () => {
    const api = window.electronAPI;
    if (!api?.showMergeSourceDialog || !api?.mergeProject || !currentProjectPath) return;
    const sourcePath = await api.showMergeSourceDialog();
    if (!sourcePath) return;
    try {
      const mergedState = await api.mergeProject(currentProjectPath, sourcePath);
      await loadCanvasWithHistory(currentProjectPath, mergedState);
      undoHistory.reset(canvasAPI.getCanvasState());
      canvasAPI.clearSelection?.();
    } catch (err) {
      showAlert(err.message || 'Could not merge project.', { title: 'Error' });
    }
  };

  // Web: New and Open both surface the same picker (list existing / create new) since there's
  // no native "Open File" dialog in a browser — see webProjectModal.js. Restoring a deleted
  // project can fall back to an empty state; temporary failures must keep the remembered ID
  // and surface through the startup screen, so Retry can restore the same workspace.
  // Shown instead of the generic error alert when the Hub reports its per-user containers are
  // all full (see hub/containers.py's CapacityExceeded, surfaced via loadWebProject/
  // createWebProject's throwApiError in webProjectModal.js) — offers the desktop app as a
  // working alternative rather than just leaving the user stuck.
  const offerDesktopDownload = async (message) => {
    const goDownload = await showConfirm(message, { title: 'Server busy', confirmText: 'Download desktop app' });
    if (goDownload) window.location.href = '/download';
  };

  const openProjectWeb = async ({ id, name }, { silent = false, startup = false } = {}) => {
    canvasAPI.setProjectLoading(true);
    try {
      const project = await loadWebProject(id);
      setCurrentProject(id);
      await loadCanvasWithHistory(id, project.state || {});
      undoHistory.reset(canvasAPI.getCanvasState());
      canvasAPI.clearSelection?.();
      setStoredWebProjectId(id);
      updateWindowTitle(project.name || name);
      topBarAPI.setAddMenuEnabled(true);
      topBarAPI.setSaveAsEnabled?.(true);
      topBarAPI.setMergeEnabled?.(true);
      topBarAPI.setPublishEnabled?.(true);
      canvasAPI.syncProjectPanels?.();
      return true;
    } catch (err) {
      if (silent && err.status === 404) { setStoredWebProjectId(null); return false; }
      if (startup) throw err;
      if (err.capacityExceeded) { await offerDesktopDownload(err.message); return; }
      showAlert(err.message || 'Could not open project.', { title: 'Error' });
      return false;
    } finally {
      canvasAPI.setProjectLoading(false);
    }
  };

  // The picker doubles as the merge entry point (click a project's "merge into current" button
  // instead of "open") when a project is already open — see webProjectModal.js.
  const onNewOrOpenProjectWeb = async () => {
    const picked = await showProjectPickerModal(currentProjectPath, {
      onRenamed: (name) => updateWindowTitle(name),
    });
    if (!picked) return;
    if (picked.type === 'merged') {
      await loadCanvasWithHistory(currentProjectPath, picked.state);
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
      if (err.capacityExceeded) { await offerDesktopDownload(err.message); return false; }
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
  // A new Generate or Process opens its window, which says how to connect its inputs on the canvas.
  const addNodeAndOpen = (eventName) => document.dispatchEvent(new CustomEvent(eventName, { detail: { open: true } }));
  const addRunNode = async () => {
    if (isElectron || await ensureWebProjectOpen()) addNodeAndOpen('workflow:add-run-node');
  };
  const addProcessNode = async () => {
    if (isElectron || await ensureWebProjectOpen()) addNodeAndOpen('workflow:add-process-node');
  };
  const onPublishToGalleryWeb = async () => {
    if (!currentProjectPath) return;
    await publishCurrentProjectToGallery(currentProjectPath, currentProjectName || 'Untitled Project');
  };

  // Undo/redo: snapshot-based (see undoHistory.js), scoped to whatever project is currently
  // open — reset() is called everywhere a different project's state gets loaded in below.
  let notifyUndoRedo = () => {};
  const undoHistory = createUndoHistory({
    loadCanvasState: (state) => canvasAPI.loadCanvasState(state),
    getCanvasState: () => canvasAPI.getCanvasState(),
    onChange: (info) => notifyUndoRedo(info),
  });
  undoHistory.reset(canvasAPI.getCanvasState());
  canvasAPI.setOnCanvasChange(() => undoHistory.push(canvasAPI.getCanvasState()));
  canvasAPI.setOnCanvasChange(() => {
    canvasChangeVersion += 1;
    const projectId = currentProjectPath;
    if (!projectId || historySession?.projectId !== projectId) return;
    queueHistorySync(projectId);
  });

  const topBarAPI = buildTopBar(root, {
    openAddPromptModal: isElectron ? () => openAddPromptModal(canvasAPI) : openAddPromptModalWeb,
    openAddDatasetModal: isElectron ? () => openAddDatasetModal(canvasAPI) : openAddDatasetModalWeb,
    addRunNode,
    addProcessNode,
    onNewProject,
    onOpenProject,
    onSaveAsProject,
    onMergeProject: isElectron ? onMergeProjectDesktop : undefined,
    onUndo: () => undoHistory.undo(),
    onRedo: () => undoHistory.redo(),
    onPublishToGallery: isElectron ? undefined : onPublishToGalleryWeb,
    panelToggles: canvasAPI.panelToggles,
  });
  notifyUndoRedo = ({ canUndo, canRedo }) => topBarAPI.setUndoRedoEnabled?.(canUndo, canRedo);
  topBarAPI.setProjectTitle?.(APP_TITLE);
  topBarAPI.setAddMenuEnabled(false);
  topBarAPI.setPublishEnabled?.(false);
  canvasAPI.syncProjectPanels?.();

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

  let openingProject = null;
  if (!isElectron) {
    // Arriving from the Hub's Profile page (see hub/main.py) with ?open=<id> — a specific
    // workspace was picked there, so it wins over the usual "reopen the last project" restore.
    const openId = requestedWebProjectId;
    if (openId) {
      onStartupStatus('Opening your project…');
      openingProject = openProjectWeb({ id: openId, name: '' }, { startup: true }).then((opened) => {
        if (!opened) return;
        const url = new URL(window.location.href);
        url.searchParams.delete('open');
        window.history.replaceState({}, '', url);
      });
    } else {
      const lastId = initialWebProjectId;
      if (lastId) {
        onStartupStatus('Opening your project…');
        openingProject = openProjectWeb({ id: lastId, name: '' }, { silent: true, startup: true });
      }
    }
  }

  let saveTimeout = null;
  function scheduleAutosave() {
    if (!currentProjectPath) return;
    if (isElectron && !window.electronAPI?.saveProject) return;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      const projectId = currentProjectPath;
      const changeVersion = canvasChangeVersion;
      try {
        let pendingSync;
        do {
          pendingSync = historySync;
          await pendingSync;
        } while (pendingSync !== historySync);
      } catch (err) {
        showError('Could not update project history before saving', err);
        return;
      }
      if (projectId !== currentProjectPath || changeVersion !== canvasChangeVersion) return;
      const state = canvasAPI.getCanvasState();
      if (isElectron) {
        await window.electronAPI.saveProject(projectId, state);
      } else {
        try {
          await saveWebProject(projectId, state);
        } catch (err) {
          showAlert(err.message || 'Could not save project.', { title: 'Error' });
          return;
        }
        // Best-effort preview for the Hub's Profile page — not awaited, autosave shouldn't wait
        // on a canvas screenshot.
        saveWebProjectThumbnail(currentProjectPath);
      }
      // Silent housekeeping, not a user-initiated action — no dialog either way, success or
      // failure. Runs after every autosave (not just via the manual "Clean up unused images..."
      // action) so images orphaned by deleting/clearing a cell don't just sit there until someone
      // remembers to clean up by hand.
      try {
        const usedIds = canvasAPI.getUsedAssetIds?.() || [];
        const pruneResult = isElectron
          ? await window.electronAPI.pruneUnusedAssets(usedIds)
          : await pruneUnusedAssetsWeb(projectId, usedIds);
        if (pruneResult?.removed?.length) {
          if (isElectron) await window.electronAPI.saveProject(projectId, state);
          else await saveWebProject(projectId, state);
        }
      } catch (_) { /* best-effort — a failed sweep just tries again on the next save */ }
    }, 400);
  }
  canvasAPI.setOnCanvasChange(scheduleAutosave);
  document.addEventListener('workflow:viewport-changed', () => {
    canvasChangeVersion += 1;
    scheduleAutosave();
  });
  await openingProject;
}
