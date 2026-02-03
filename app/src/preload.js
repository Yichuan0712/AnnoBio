const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onSetTheme: (callback) => {
    ipcRenderer.on('set-theme', (_event, mode) => callback(mode));
  },
  showNewProjectDialog: () => ipcRenderer.invoke('project:new-dialog'),
  showOpenProjectDialog: () => ipcRenderer.invoke('project:open-dialog'),
  saveProject: (filePath, state) => ipcRenderer.invoke('project:save', filePath, state),
  loadProject: (filePath) => ipcRenderer.invoke('project:load', filePath),
});
