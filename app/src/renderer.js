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

  buildTopBar(root, { openAddPromptModal, openAddDatasetModal, openAddAgentModal, openCredentialsModal });
  buildWorkflowCanvas(root);
});
