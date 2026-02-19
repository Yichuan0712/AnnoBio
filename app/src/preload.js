const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onSetTheme: (callback) => {
    ipcRenderer.on('set-theme', (_event, mode) => callback(mode));
  },
  showNewProjectDialog: () => ipcRenderer.invoke('project:new-dialog'),
  showOpenProjectDialog: () => ipcRenderer.invoke('project:open-dialog'),
  showSaveAsProjectDialog: (defaultPath) => ipcRenderer.invoke('project:save-as-dialog', defaultPath),
  saveProject: (filePath, state) => ipcRenderer.invoke('project:save', filePath, state),
  loadProject: (filePath) => ipcRenderer.invoke('project:load', filePath),
  showSaveFileDialog: (opts) => ipcRenderer.invoke('dialog:show-save', opts),
  writeFile: (filePath, data, encoding) => ipcRenderer.invoke('fs:write-file', filePath, data, encoding),
});
