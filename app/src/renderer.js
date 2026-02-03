/**
 * Renderer entry: theme, top bar, workflow canvas.
 * Node.js integration is disabled (recommended).
 */

import './index.css';
import './topBar.css';
import './workflowCanvas.css';
import './modals.css';
import { getStoredTheme, setTheme } from './theme.js';
import { buildTopBar } from './topBar.js';
import { buildWorkflowCanvas } from './workflowCanvas.js';
import { openAddPromptModal } from './addPromptModal.js';
import { openAddDatasetModal } from './addDatasetModal.js';
import { openAddAgentModal } from './addAgentModal.js';
import { openCredentialsModal } from './credentialsModal.js';
import { initModalDrag } from './modalDrag.js';

window.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app') || document.body;
  setTheme(getStoredTheme());
  initModalDrag();

  window.electronAPI?.onSetTheme?.(setTheme);

  const canvasAPI = buildWorkflowCanvas(root);
  let currentProjectPath = null;

  const onNewProject = async () => {
    const api = window.electronAPI;
    if (!api?.showNewProjectDialog) return;
    const path = await api.showNewProjectDialog();
    if (!path) return;
    currentProjectPath = path;
    const state = canvasAPI.getCanvasState();
    await api.saveProject(path, state);
    topBarAPI.setAddMenuEnabled(true);
  };

  const onOpenProject = async () => {
    const api = window.electronAPI;
    if (!api?.showOpenProjectDialog || !api?.loadProject) return;
    const path = await api.showOpenProjectDialog();
    if (!path) return;
    const state = await api.loadProject(path);
    canvasAPI.loadCanvasState(state);
    currentProjectPath = path;
    topBarAPI.setAddMenuEnabled(true);
  };

  const topBarAPI = buildTopBar(root, {
    openAddPromptModal,
    openAddDatasetModal,
    openAddAgentModal,
    openCredentialsModal,
    onNewProject,
    onOpenProject,
  });
  topBarAPI.setAddMenuEnabled(false);

  let saveTimeout = null;
  canvasAPI.setOnCanvasChange(() => {
    if (!currentProjectPath || !window.electronAPI?.saveProject) return;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      const state = canvasAPI.getCanvasState();
      await window.electronAPI.saveProject(currentProjectPath, state);
    }, 400);
  });
});
