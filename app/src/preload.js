const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
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
