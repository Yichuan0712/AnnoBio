const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  importImages: (paths) => ipcRenderer.invoke('assets:import', paths),
  pickImageFiles: () => ipcRenderer.invoke('assets:pick-files'),
  pickImageDirectory: () => ipcRenderer.invoke('assets:pick-directory'),
  imagePreview: (id, thumbnail = true) => ipcRenderer.invoke('assets:preview', id, thumbnail),
  prepareAssets: () => ipcRenderer.invoke('assets:prepare'),
  resolveImageCandidates: (rows, baseDir) => ipcRenderer.invoke('assets:resolve-candidates', rows, baseDir),
  resolveImagePaths: (rows) => ipcRenderer.invoke('assets:resolve-paths', rows),
  exportImageDataset: (file, content) => ipcRenderer.invoke('assets:export-dataset', file, content),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onSetTheme: (callback) => {
    ipcRenderer.on('set-theme', (_event, mode) => callback(mode));
  },
  onWindowMaximizedChanged: (callback) => {
    ipcRenderer.on('window:maximized-changed', (_event, isMaximized) => callback(!!isMaximized));
  },
  showNewProjectDialog: () => ipcRenderer.invoke('project:new-dialog'),
  showOpenProjectDialog: () => ipcRenderer.invoke('project:open-dialog'),
  showSaveAsProjectDialog: (defaultPath) => ipcRenderer.invoke('project:save-as-dialog', defaultPath),
  saveProject: (filePath, state) => ipcRenderer.invoke('project:save', filePath, state),
  loadProject: (filePath) => ipcRenderer.invoke('project:load', filePath),
  loadAgentConversations: (projectPath) => ipcRenderer.invoke('agent-conversations:load', projectPath),
  saveAgentConversations: (projectPath, data) => ipcRenderer.invoke('agent-conversations:save', projectPath, data),
  showSaveFileDialog: (opts) => ipcRenderer.invoke('dialog:show-save', opts),
  showPickPythonDialog: () => ipcRenderer.invoke('dialog:pick-python'),
  writeFile: (filePath, data, encoding) => ipcRenderer.invoke('fs:write-file', filePath, data, encoding),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
});
