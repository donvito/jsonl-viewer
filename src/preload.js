const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  readFile: (filePath, maxLines) => ipcRenderer.invoke('file:read', filePath, maxLines),
  readRange: (filePath, startLine, count) =>
    ipcRenderer.invoke('file:readRange', filePath, startLine, count),
  saveFile: (defaultName) => ipcRenderer.invoke('dialog:saveFile', defaultName),
  writeFile: (filePath, contents) => ipcRenderer.invoke('file:write', filePath, contents),
  updateRecent: (list) => ipcRenderer.invoke('recent:update', list),
  setThemeList: (list) => ipcRenderer.invoke('theme:list', list),
  updateTheme: (key) => ipcRenderer.invoke('theme:current', key),
  onAutoOpen: (cb) => ipcRenderer.on('auto-open', (_e, filePath) => cb(filePath)),
  onMenu: (cb) => ipcRenderer.on('menu:open', () => cb('open'))
    .on('menu:save', () => cb('save'))
    .on('menu:save-as', () => cb('save-as'))
    .on('menu:open-file', (_e, p) => cb('open-file', p))
    .on('menu:copy-json', () => cb('copy-json'))
    .on('menu:copy-raw', () => cb('copy-raw'))
    .on('menu:view', (_e, v) => cb('view', v))
    .on('menu:theme', (_e, k) => cb('theme', k))
    .on('menu:cycle-theme', () => cb('cycle-theme'))
    .on('menu:clear-recent', () => cb('clear-recent'))
});
