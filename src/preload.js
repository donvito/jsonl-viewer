const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  listDir: (dirPath) => ipcRenderer.invoke('dir:list', dirPath),
  listTraceFiles: (source) => ipcRenderer.invoke('trace:list', source),
  statPath: (filePath) => ipcRenderer.invoke('fs:stat', filePath),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItem', filePath),
  watchFile: (filePath) => ipcRenderer.invoke('file:watch', filePath),
  readFile: (filePath, maxLines) => ipcRenderer.invoke('file:read', filePath, maxLines),
  readRange: (filePath, startLine, count) =>
    ipcRenderer.invoke('file:readRange', filePath, startLine, count),
  saveFile: (defaultName) => ipcRenderer.invoke('dialog:saveFile', defaultName),
  writeFile: (filePath, contents) => ipcRenderer.invoke('file:write', filePath, contents),
  // Electron 32+ removed File.path; resolve dropped File objects here.
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch (err) {
      return '';
    }
  },
  updateRecent: (list) => ipcRenderer.invoke('recent:update', list),
  setThemeList: (list) => ipcRenderer.invoke('theme:list', list),
  updateTheme: (key) => ipcRenderer.invoke('theme:current', key),
  onAutoOpen: (cb) => ipcRenderer.on('auto-open', (_e, filePath) => cb(filePath)),
  onFileChanged: (cb) => ipcRenderer.on('file:changed', (_e, info) => cb(info)),
  onMenu: (cb) => ipcRenderer.on('menu:open', () => cb('open'))
    .on('menu:open-folder', () => cb('open-folder'))
    .on('menu:trace-sources', () => cb('trace-sources'))
    .on('menu:close-folder', () => cb('close-folder'))
    .on('menu:close-file', () => cb('close-file'))
    .on('menu:toggle-explorer', () => cb('toggle-explorer'))
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
