const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#1e1e2e',
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
}

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
  if (process.platform !== 'darwin') app.quit();
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

// ---- IPC: read a file as text, streamed line-by-line summary ----
// Returns { path, name, sizeBytes, totalLines, parsedLines, errors, truncated }
// Parses up to maxLines lines to keep the renderer snappy on huge files.
ipcMain.handle('file:read', async (event, filePath, maxLines = 5000) => {
  return await new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    const name = path.basename(filePath);

    const parsedLines = [];
    const errors = [];
    let totalLines = 0;
    let bytesRead = 0;
    let leftover = '';
    let truncated = false;

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });

    stream.on('data', (chunk) => {
      bytesRead += chunk.length;
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
  await fs.promises.writeFile(filePath, contents, 'utf8');
  return true;
});
