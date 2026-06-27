// Capture screenshots of the app under several themes for the PR.
//
// Run with:
//   xvfb-run -a --server-args="-screen 0 1280x800x24" \
//     ./node_modules/.bin/electron --no-sandbox --disable-gpu test-theme-screenshots.js
//
// Writes PNGs to /opt/cursor/artifacts/screenshots/themes/.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const SAMPLE = path.join(__dirname, 'sample.jsonl');
const OUT_DIR = '/opt/cursor/artifacts/screenshots/themes';

const SHOT_THEMES = [
  { key: 'dark', file: 'theme-mocha.png', openPicker: false },
  { key: 'dracula', file: 'theme-dracula.png', openPicker: false },
  { key: 'tokyo-night', file: 'theme-tokyo-night.png', openPicker: false },
  { key: 'github-light', file: 'theme-github-light.png', openPicker: false },
  { key: 'dark', file: 'theme-picker-open.png', openPicker: true }
];

let win;

// Inline file reader mirroring src/main.js's file:read handler so we can
// populate the table in the screenshot without spinning up the full app.
function readJsonl(filePath, maxLines = 5000) {
  const stat = fs.statSync(filePath);
  const name = path.basename(filePath);
  const parsedLines = [];
  const errors = [];
  let totalLines = 0;
  let leftover = '';
  let truncated = false;
  const data = fs.readFileSync(filePath, 'utf8');
  for (const raw of data.split('\n')) {
    totalLines++;
    const trimmed = raw.replace(/\r$/, '').trim();
    if (trimmed === '') continue;
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
  return {
    path: filePath, name, sizeBytes: stat.size,
    totalLines, parsedLines, errors, truncated, maxLines
  };
}

// Stub IPC handlers — the real ones live in src/main.js, but we're running
// a custom main process for the screenshot.
ipcMain.handle('theme:list', () => true);
ipcMain.handle('theme:current', () => true);
ipcMain.handle('recent:update', () => true);
ipcMain.handle('dialog:openFile', () => SAMPLE);
ipcMain.handle('file:read', (_e, filePath) => readJsonl(filePath));
ipcMain.handle('file:readRange', () => ({ lines: [] }));
ipcMain.handle('dialog:saveFile', () => null);
ipcMain.handle('file:write', () => true);

async function loadSample() {
  // Drive the renderer's openFile() directly so the table fills with data.
  await win.webContents.executeJavaScript(`openFile(${JSON.stringify(SAMPLE)})`);
  // Wait for the async load + render to settle.
  await new Promise((r) => setTimeout(r, 500));
}

async function captureShots() {
  await loadSample();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const shot of SHOT_THEMES) {
    await win.webContents.executeJavaScript(`
      (function() {
        setTheme(${JSON.stringify(shot.key)});
        ${shot.openPicker ? `
          const btn = document.getElementById('themeBtn');
          btn.click();
        ` : `
          const menu = document.getElementById('themeMenu');
          if (!menu.hidden) menu.hidden = true;
        `}
        return document.documentElement.getAttribute('data-theme');
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
    const buf = await win.webContents.capturePage();
    const outPath = path.join(OUT_DIR, shot.file);
    fs.writeFileSync(outPath, buf.toPNG());
    console.log('wrote', outPath);
  }
  app.exit(0);
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
    .then(() => new Promise((r) => setTimeout(r, 300)))
    .then(captureShots)
    .catch((err) => {
      console.error('Screenshot capture failed:', err);
      app.exit(1);
    });
});

setTimeout(() => { console.error('Timed out'); app.exit(1); }, 30000);
