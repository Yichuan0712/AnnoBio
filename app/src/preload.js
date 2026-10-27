const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  importImages: (paths) => ipcRenderer.invoke('assets:import', paths),
  importPdfs: (paths) => ipcRenderer.invoke('assets:import-pdfs', paths),
  pruneUnusedAssets: (usedIds, options) => ipcRenderer.invoke('assets:prune-unused', usedIds, options),
  pickImageFiles: () => ipcRenderer.invoke('assets:pick-files'),
  pickPdfFiles: () => ipcRenderer.invoke('assets:pick-pdf-files'),
  pickImageDirectory: () => ipcRenderer.invoke('assets:pick-directory'),
  imagePreview: (id, thumbnail = true) => ipcRenderer.invoke('assets:preview', id, thumbnail),
  prepareAssets: () => ipcRenderer.invoke('assets:prepare'),
  resolveImageCandidates: (rows, baseDir) => ipcRenderer.invoke('assets:resolve-candidates', rows, baseDir),
  resolveImagePaths: (rows) => ipcRenderer.invoke('assets:resolve-paths', rows),
  exportImageDataset: (file, content) => ipcRenderer.invoke('assets:export-dataset', file, content),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // Agent chat attachments (docs/design/AGENT_ATTACHMENTS_PLAN.md): dropped File objects become paths here.
  pickAgentAttachments: () => ipcRenderer.invoke('agent:pick-attachments'),
  attachDroppedFiles: (files) => ipcRenderer.invoke('agent:register-attachments',
    Array.from(files || []).map((file) => webUtils.getPathForFile(file)).filter(Boolean)),
  readAgentAttachment: (filePath) => ipcRenderer.invoke('agent:read-attachment', filePath),
  onSetTheme: (callback) => {
    ipcRenderer.on('set-theme', (_event, mode) => callback(mode));
  },
  onWindowMaximizedChanged: (callback) => {
    ipcRenderer.on('window:maximized-changed', (_event, isMaximized) => callback(!!isMaximized));
  },
  onWindowFullscreenChanged: (callback) => {
    ipcRenderer.on('window:fullscreen-changed', (_event, isFullscreen) => callback(!!isFullscreen));
  },
  showNewProjectDialog: (defaultName) => ipcRenderer.invoke('project:new-dialog', defaultName),
  showOpenProjectDialog: () => ipcRenderer.invoke('project:open-dialog'),
  showSaveAsProjectDialog: (defaultPath) => ipcRenderer.invoke('project:save-as-dialog', defaultPath),
  saveProject: (filePath, state, options) => ipcRenderer.invoke('project:save', filePath, state, options),
  loadProject: (filePath) => ipcRenderer.invoke('project:load', filePath),
  showMergeSourceDialog: () => ipcRenderer.invoke('project:pick-merge-source-dialog'),
  mergeProject: (targetFile, sourceFile) => ipcRenderer.invoke('project:merge', targetFile, sourceFile),
  loadRunRecords: (projectPath) => ipcRenderer.invoke('run-records:load', projectPath),
  saveRunRecords: (projectPath, records) => ipcRenderer.invoke('run-records:save', projectPath, records),
  loadAgentConversations: (projectPath) => ipcRenderer.invoke('agent-conversations:load', projectPath),
  saveAgentConversations: (projectPath, data) => ipcRenderer.invoke('agent-conversations:save', projectPath, data),
  loadRunHistoryIndex: (projectPath) => ipcRenderer.invoke('history:index', projectPath),
  loadRunHistoryRecord: (projectPath, recordId) => ipcRenderer.invoke('history:record', projectPath, recordId),
  saveRunHistoryRecord: (projectPath, record) => ipcRenderer.invoke('history:save-record', projectPath, record),
  deleteRunHistoryRecords: (projectPath, recordId, expectedIds) => ipcRenderer.invoke('history:delete-records', projectPath, recordId, expectedIds),
  showSaveFileDialog: (opts) => ipcRenderer.invoke('dialog:show-save', opts),
  showPickPythonDialog: () => ipcRenderer.invoke('dialog:pick-python'),
  writeFile: (filePath, data, encoding) => ipcRenderer.invoke('fs:write-file', filePath, data, encoding),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  getBackendLog: () => ipcRenderer.invoke('backend-log:get'),
  reportRendererError: (entry) => ipcRenderer.invoke('backend-log:renderer-error', entry),
  /** Calls `callback(lines)` with each batch of new backend output; returns an unsubscribe function. */
  onBackendLog: (callback) => {
    const listener = (_event, lines) => callback(lines);
    ipcRenderer.on('backend-log:lines', listener);
    return () => ipcRenderer.removeListener('backend-log:lines', listener);
  },
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
});
