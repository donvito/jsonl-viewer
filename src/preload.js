const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  readFile: (filePath, maxLines) => ipcRenderer.invoke('file:read', filePath, maxLines),
  readRange: (filePath, startLine, count) =>
    ipcRenderer.invoke('file:readRange', filePath, startLine, count),
  saveFile: (defaultName) => ipcRenderer.invoke('dialog:saveFile', defaultName),
  writeFile: (filePath, contents) => ipcRenderer.invoke('file:write', filePath, contents),
  onAutoOpen: (cb) => ipcRenderer.on('auto-open', (_e, filePath) => cb(filePath))
});
