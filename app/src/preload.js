const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onSetTheme: (callback) => {
    ipcRenderer.on('set-theme', (_event, mode) => callback(mode));
  },
});
