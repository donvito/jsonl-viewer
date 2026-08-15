const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const DATA_EXTS = ['.jsonl', '.ndjson', '.json', '.log', '.txt'];
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.next', '.cache',
  'dist', 'build', 'coverage', '__pycache__'
]);

let mainWindow;
let recentFiles = [];
let themeList = [];
let currentTheme = 'dark';

// Watch the open file's directory so atomic editor saves (temp + rename)
// still notify the renderer. Our own writes are ignored via ignoreUntil
// plus a last-known mtime/size stamp.
let watchedPath = null;
let dirWatcher = null;
let changeTimer = null;
let ignoreUntil = 0;
let lastStat = { mtimeMs: 0, size: -1 };

const IS_WIN = process.platform === 'win32';
const WATCH_DEBOUNCE_MS = IS_WIN ? 350 : 180;
const STAT_RETRY_MS = IS_WIN ? 100 : 70;
const STAT_RETRIES = IS_WIN ? 8 : 4;

function sameFileName(a, b) {
  if (process.platform === 'darwin' || IS_WIN) {
    return String(a).toLowerCase() === String(b).toLowerCase();
  }
  return a === b;
}

function normalizeWatchPath(filePath) {
  const resolved = path.resolve(filePath);
  return IS_WIN ? resolved.toLowerCase() : resolved;
}

function isRetryableFsError(err) {
  return !!err && (
    err.code === 'ENOENT' ||
    err.code === 'EPERM' ||
    err.code === 'EBUSY' ||
    err.code === 'EACCES' ||
    err.code === 'EAGAIN'
  );
}

function stopWatching() {
  if (changeTimer) {
    clearTimeout(changeTimer);
    changeTimer = null;
  }
  if (dirWatcher) {
    dirWatcher.close();
    dirWatcher = null;
  }
  watchedPath = null;
  lastStat = { mtimeMs: 0, size: -1 };
}

function refreshLastStat(filePath) {
  try {
    const st = fs.statSync(filePath);
    lastStat = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    // File may have vanished between read and stat.
  }
}

function emitIfChanged(retries = STAT_RETRIES) {
  if (!watchedPath) return;
  if (Date.now() < ignoreUntil) return;
  fs.stat(watchedPath, (err, st) => {
    if (!watchedPath) return;
    if (err) {
      // Atomic save or a Windows exclusive lock while the editor writes.
      if (isRetryableFsError(err) && retries > 0) {
        changeTimer = setTimeout(() => {
          changeTimer = null;
          emitIfChanged(retries - 1);
        }, STAT_RETRY_MS);
        return;
      }
      if (err.code === 'ENOENT') {
        send('file:changed', { path: watchedPath, deleted: true });
      }
      return;
    }
    if (st.mtimeMs === lastStat.mtimeMs && st.size === lastStat.size) return;
    lastStat = { mtimeMs: st.mtimeMs, size: st.size };
    send('file:changed', { path: watchedPath, deleted: false, mtimeMs: st.mtimeMs, size: st.size });
  });
}

function scheduleExternalChange() {
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    changeTimer = null;
    emitIfChanged();
  }, WATCH_DEBOUNCE_MS);
}

function startWatching(filePath) {
  const resolved = path.resolve(filePath);
  const watchKey = normalizeWatchPath(filePath);
  if (watchedPath && normalizeWatchPath(watchedPath) === watchKey && dirWatcher) {
    refreshLastStat(resolved);
    return;
  }
  stopWatching();
  if (!filePath) return;
  watchedPath = resolved;
  refreshLastStat(resolved);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  try {
    dirWatcher = fs.watch(dir, (eventType, filename) => {
      if (filename && !sameFileName(path.basename(String(filename)), base)) return;
      if (Date.now() < ignoreUntil) return;
      scheduleExternalChange();
    });
    dirWatcher.on('error', () => stopWatching());
  } catch {
    watchedPath = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: themeBackgroundColor(currentTheme),
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Allow dragging a file onto the window
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  buildMenu();
}

// ---- Application menu ----
function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

// Background color matching each theme's --bg, used to set the BrowserWindow
// background so the initial flash before the renderer loads matches the
// persisted theme. Must stay in sync with themes.css.
const THEME_BG = {
  'dark': '#1e1e2e',
  'light': '#eff1f5',
  'tokyo-night': '#1a1b26',
  'dracula': '#282a36',
  'gruvbox-dark': '#282828',
  'solarized-dark': '#002b36',
  'solarized-light': '#fdf6e3',
  'github-dark': '#0d1117',
  'github-light': '#ffffff',
  'one-dark': '#282c34'
};

function themeBackgroundColor(key) {
  return THEME_BG[key] || THEME_BG['dark'];
}

function themeSubmenu() {
  if (!themeList.length) {
    return [{ label: 'No themes loaded', enabled: false }];
  }
  const dark = themeList.filter((t) => !t.isLight);
  const light = themeList.filter((t) => t.isLight);
  const toItem = (t) => ({
    label: t.label,
    type: 'radio',
    checked: t.key === currentTheme,
    click: () => send('menu:theme', t.key)
  });
  return [
    ...dark.map(toItem),
    { type: 'separator' },
    ...light.map(toItem)
  ];
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const recentTemplate = recentFiles.length
    ? [
        ...recentFiles.map((p) => ({
          label: p.split(/[\\/]/).pop(),
          sublabel: p,
          click: () => send('menu:open-file', p)
        })),
        { type: 'separator' },
        { label: 'Clear Recent History', click: () => send('menu:clear-recent') }
      ]
    : [{ label: 'No recent files', enabled: false }];

  const template = [
    ...(isMac ? [{
      role: 'appMenu', submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:open') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('menu:open-folder') },
        { label: 'Open Recent', submenu: recentTemplate },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu:save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('menu:save-as') },
        { label: 'Close File', accelerator: 'CmdOrCtrl+Shift+W', click: () => send('menu:close-file') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'copy' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Copy JSON (selected row)', click: () => send('menu:copy-json') },
        { label: 'Copy raw (selected row)', click: () => send('menu:copy-raw') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggledevtools' },
        { type: 'separator' },
        { label: 'Table', click: () => send('menu:view', 'table') },
        { label: 'Tree', click: () => send('menu:view', 'tree') },
        { label: 'Raw', click: () => send('menu:view', 'raw') },
        { type: 'separator' },
        { label: 'Toggle Explorer', accelerator: 'CmdOrCtrl+B', click: () => send('menu:toggle-explorer') },
        { type: 'separator' },
        { label: 'Theme', submenu: themeSubmenu() },
        { label: 'Cycle Theme', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('menu:cycle-theme') }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }])
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('recent:update', (_e, list) => {
  recentFiles = Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
  buildMenu();
  return true;
});

ipcMain.handle('theme:list', (_e, list) => {
  themeList = Array.isArray(list)
    ? list
        .filter((t) => t && typeof t.key === 'string' && typeof t.label === 'string')
        .map((t) => ({ key: t.key, label: t.label, isLight: !!t.isLight, accent: t.accent || null }))
    : [];
  buildMenu();
  return true;
});

ipcMain.handle('theme:current', (_e, key) => {
  if (typeof key === 'string') {
    currentTheme = key;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(themeBackgroundColor(key));
    }
    buildMenu();
  }
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Auto-open a file passed on the command line:
  //   electron . --file=sample.jsonl   (or --file sample.jsonl)
  // Fallback: any argv entry ending in a known data-file extension.
  const exts = ['.jsonl', '.ndjson', '.json', '.log', '.txt'];
  let fileArg = null;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--file' && i + 1 < process.argv.length) { fileArg = process.argv[i + 1]; break; }
    if (a.startsWith('--file=')) { fileArg = a.slice('--file='.length); break; }
  }
  if (!fileArg) {
    fileArg = process.argv.find((a) => !a.startsWith('-') && exts.some((e) => a.toLowerCase().endsWith(e)));
  }
  if (fileArg) {
    const resolved = path.resolve(fileArg);
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('auto-open', resolved);
    });
  }
});

app.on('window-all-closed', () => {
  stopWatching();
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC: open folder dialog ----
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Folder',
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('fs:stat', async (_e, filePath) => {
  if (!filePath || typeof filePath !== 'string') return null;
  try {
    const st = await fs.promises.stat(filePath);
    return { isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size };
  } catch {
    return null;
  }
});

ipcMain.handle('dir:list', async (_e, dirPath) => {
  if (!dirPath || typeof dirPath !== 'string') {
    return { path: dirPath, entries: [], error: 'Invalid path' };
  }
  try {
    const names = await fs.promises.readdir(dirPath);
    const entries = [];
    for (const name of names) {
      if (name === '.' || name === '..') continue;
      if (name.startsWith('.')) continue;
      if (SKIP_DIRS.has(name)) continue;
      if (name === 'Thumbs.db' || name === 'desktop.ini') continue;
      const full = path.join(dirPath, name);
      let st;
      try { st = await fs.promises.stat(full); } catch { continue; }
      if (st.isDirectory()) {
        entries.push({ name, path: full, kind: 'dir' });
      } else if (st.isFile() && DATA_EXTS.some((ext) => name.toLowerCase().endsWith(ext))) {
        entries.push({ name, path: full, kind: 'file', size: st.size });
      }
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return { path: dirPath, name: path.basename(dirPath), entries };
  } catch (err) {
    return { path: dirPath, entries: [], error: err.message };
  }
});

ipcMain.handle('shell:showItem', async (_e, filePath) => {
  if (!filePath || typeof filePath !== 'string') return false;
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('file:watch', (_e, filePath) => {
  if (filePath && typeof filePath === 'string') startWatching(filePath);
  else stopWatching();
  return true;
});

// ---- IPC: open file dialog ----
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open JSONL file',
    filters: [
      { name: 'JSONL / JSON Lines', extensions: ['jsonl', 'ndjson', 'json', 'log', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

function readJsonlFile(filePath, maxLines = 5000) {
  return new Promise((resolve, reject) => {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      reject(err);
      return;
    }
    const name = path.basename(filePath);

    const parsedLines = [];
    const errors = [];
    let totalLines = 0;
    let leftover = '';
    let truncated = false;

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });

    stream.on('data', (chunk) => {
      leftover += chunk;
      let idx;
      while ((idx = leftover.indexOf('\n')) !== -1) {
        const raw = leftover.slice(0, idx).replace(/\r$/, '');
        leftover = leftover.slice(idx + 1);
        totalLines++;
        if (parsedLines.length < maxLines) {
          const trimmed = raw.trim();
          if (trimmed === '') continue;
          try {
            parsedLines.push({ index: totalLines - 1, raw: trimmed, value: JSON.parse(trimmed) });
          } catch (err) {
            parsedLines.push({ index: totalLines - 1, raw: trimmed, value: null, parseError: err.message });
            errors.push({ index: totalLines - 1, message: err.message });
          }
        } else {
          truncated = true;
        }
      }
    });

    stream.on('end', () => {
      // Handle trailing line without newline
      if (leftover.trim() !== '') {
        totalLines++;
        const trimmed = leftover.trim();
        if (parsedLines.length < maxLines) {
          try {
            parsedLines.push({ index: totalLines - 1, raw: trimmed, value: JSON.parse(trimmed) });
          } catch (err) {
            parsedLines.push({ index: totalLines - 1, raw: trimmed, value: null, parseError: err.message });
            errors.push({ index: totalLines - 1, message: err.message });
          }
        } else {
          truncated = true;
        }
      }
      resolve({
        path: filePath,
        name,
        sizeBytes: stat.size,
        totalLines,
        parsedLines,
        errors,
        truncated,
        maxLines
      });
    });

    stream.on('error', (err) => reject(err));
  });
}

async function readJsonlFileWithRetry(filePath, maxLines = 5000) {
  let lastErr;
  for (let attempt = 0; attempt <= STAT_RETRIES; attempt++) {
    try {
      return await readJsonlFile(filePath, maxLines);
    } catch (err) {
      lastErr = err;
      if (!isRetryableFsError(err) || attempt === STAT_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, STAT_RETRY_MS));
    }
  }
  throw lastErr;
}

// ---- IPC: read a file as text, streamed line-by-line summary ----
// Returns { path, name, sizeBytes, totalLines, parsedLines, errors, truncated }
// Parses up to maxLines lines to keep the renderer snappy on huge files.
ipcMain.handle('file:read', async (event, filePath, maxLines = 5000) => {
  const result = await readJsonlFileWithRetry(filePath, maxLines);
  startWatching(filePath);
  return result;
});

// ---- IPC: read a specific line range from a file (for lazy loading) ----
ipcMain.handle('file:readRange', async (event, filePath, startLine, count) => {
  return await new Promise((resolve, reject) => {
    const lines = [];
    let leftover = '';
    let lineNo = 0;
    let started = false;
    const endLine = startLine + count;

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });

    stream.on('data', (chunk) => {
      leftover += chunk;
      let idx;
      while ((idx = leftover.indexOf('\n')) !== -1) {
        const raw = leftover.slice(0, idx).replace(/\r$/, '');
        leftover = leftover.slice(idx + 1);
        if (lineNo >= startLine && lineNo < endLine) {
          started = true;
          const trimmed = raw.trim();
          if (trimmed !== '') {
            try {
              lines.push({ index: lineNo, raw: trimmed, value: JSON.parse(trimmed) });
            } catch (err) {
              lines.push({ index: lineNo, raw: trimmed, value: null, parseError: err.message });
            }
          } else {
            lines.push({ index: lineNo, raw: '', value: null, empty: true });
          }
        }
        lineNo++;
        if (lineNo >= endLine) {
          stream.destroy();
          resolve({ lines, startLine, count });
          return;
        }
      }
    });

    stream.on('end', () => {
      if (lineNo < endLine && leftover.trim() !== '') {
        const trimmed = leftover.trim();
        if (lineNo >= startLine) {
          try {
            lines.push({ index: lineNo, raw: trimmed, value: JSON.parse(trimmed) });
          } catch (err) {
            lines.push({ index: lineNo, raw: trimmed, value: null, parseError: err.message });
          }
        }
      }
      resolve({ lines, startLine, count });
    });

    stream.on('error', (err) => reject(err));
  });
});

// ---- IPC: save dialog + write text to a file ----
ipcMain.handle('dialog:saveFile', async (_e, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save JSONL file',
    defaultPath: defaultName || 'output.jsonl',
    filters: [
      { name: 'JSONL / JSON Lines', extensions: ['jsonl', 'ndjson'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle('file:write', async (_e, filePath, contents) => {
  ignoreUntil = Date.now() + 800;
  await fs.promises.writeFile(filePath, contents, 'utf8');
  refreshLastStat(filePath);
  return true;
});
