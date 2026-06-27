// Functional test: launches a custom Electron main process that loads
// the real renderer, then uses webContents.executeJavaScript to verify
// that switching themes updates <html data-theme>, the --accent CSS
// variable, and the JSON syntax-highlight color (.k class).
//
// Run with: xvfb-run -a ./node_modules/.bin/electron --no-sandbox --disable-gpu test-themes-functional.js

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const THEMES = [
  { key: 'dark',           accent: '#89b4fa', green: '#a6e3a1', orange: '#fab387', accent2: '#f5c2e7' },
  { key: 'tokyo-night',    accent: '#7aa2f7', green: '#9ece6a', orange: '#ff9e64', accent2: '#bb9af7' },
  { key: 'dracula',        accent: '#bd93f9', green: '#50fa7b', orange: '#ffb86c', accent2: '#ff79c6' },
  { key: 'gruvbox-dark',   accent: '#83a598', green: '#b8bb26', orange: '#fe8019', accent2: '#d3869b' },
  { key: 'solarized-dark', accent: '#268bd2', green: '#859900', orange: '#cb4b16', accent2: '#d33682' },
  { key: 'github-dark',    accent: '#58a6ff', green: '#3fb950', orange: '#db6d28', accent2: '#d2a8ff' },
  { key: 'one-dark',       accent: '#61afef', green: '#98c379', orange: '#d19a66', accent2: '#c678dd' },
  { key: 'light',          accent: '#1e66f5', green: '#40a02b', orange: '#fe640b', accent2: '#ea76cb' },
  { key: 'solarized-light',accent: '#268bd2', green: '#859900', orange: '#cb4b16', accent2: '#d33682' },
  { key: 'github-light',   accent: '#0969da', green: '#1a7f37', orange: '#bc4c00', accent2: '#bf3989' }
];

let win;
const failures = [];

// Stub IPC handlers so the renderer doesn't choke on first load.
ipcMain.handle('theme:list', () => true);
ipcMain.handle('theme:current', () => true);
ipcMain.handle('recent:update', () => true);
ipcMain.handle('dialog:openFile', () => null);
ipcMain.handle('file:read', () => ({ parsedLines: [], errors: [], totalLines: 0, truncated: false }));
ipcMain.handle('file:readRange', () => ({ lines: [] }));
ipcMain.handle('dialog:saveFile', () => null);
ipcMain.handle('file:write', () => true);

function assert(cond, msg) {
  if (!cond) {
    failures.push(msg);
    console.error('  ✗ ' + msg);
    return false;
  }
  console.log('  ✓ ' + msg);
  return true;
}

// Normalize a color to lowercase hex (or rgb → hex) for comparison.
function normalize(color) {
  if (!color) return '';
  const c = color.trim().toLowerCase();
  // rgb(r, g, b) → #rrggbb
  const m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) {
    const hex = (n) => Number(n).toString(16).padStart(2, '0');
    return '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
  }
  return c;
}

async function probeTheme(key) {
  // Switch to the theme and read back the DOM + computed style for each
  // JSON syntax-highlight class (.k key, .s string, .n number, .b boolean).
  return await win.webContents.executeJavaScript(`
    (function() {
      setTheme(${JSON.stringify(key)});
      const root = document.documentElement;
      const cs = getComputedStyle(root);
      const read = (className) => {
        const wrap = document.createElement('div');
        wrap.className = 'preview';
        wrap.style.display = 'none';
        const probe = document.createElement('span');
        probe.className = className;
        wrap.appendChild(probe);
        document.body.appendChild(wrap);
        const color = getComputedStyle(probe).color;
        wrap.remove();
        return color;
      };
      return {
        dataTheme: root.getAttribute('data-theme'),
        accent: cs.getPropertyValue('--accent').trim(),
        green: cs.getPropertyValue('--green').trim(),
        orange: cs.getPropertyValue('--orange').trim(),
        accent2: cs.getPropertyValue('--accent-2').trim(),
        kColor: read('k'),
        sColor: read('s'),
        nColor: read('n'),
        bColor: read('b')
      };
    })()
  `);
}

async function runTests() {
  // The renderer has finished loading (we awaited loadFile). Give the
  // theme list IPC a moment to round-trip before probing.
  await new Promise((r) => setTimeout(r, 300));

  console.log('Theme switching + JSON syntax highlighting:');
  for (const t of THEMES) {
    const r = await probeTheme(t.key);
    assert(r.dataTheme === t.key, `data-theme === "${t.key}" (got "${r.dataTheme}")`);
    assert(normalize(r.accent) === t.accent.toLowerCase(),
      `--accent for "${t.key}" === ${t.accent} (got ${r.accent})`);
    assert(normalize(r.green) === t.green.toLowerCase(),
      `--green for "${t.key}" === ${t.green} (got ${r.green})`);
    assert(normalize(r.orange) === t.orange.toLowerCase(),
      `--orange for "${t.key}" === ${t.orange} (got ${r.orange})`);
    assert(normalize(r.accent2) === t.accent2.toLowerCase(),
      `--accent-2 for "${t.key}" === ${t.accent2} (got ${r.accent2})`);
    assert(normalize(r.kColor) === t.accent.toLowerCase(),
      `.k (JSON key) for "${t.key}" === ${t.accent} (got ${r.kColor})`);
    assert(normalize(r.sColor) === t.green.toLowerCase(),
      `.s (JSON string) for "${t.key}" === ${t.green} (got ${r.sColor})`);
    assert(normalize(r.nColor) === t.orange.toLowerCase(),
      `.n (JSON number) for "${t.key}" === ${t.orange} (got ${r.nColor})`);
    assert(normalize(r.bColor) === t.accent2.toLowerCase(),
      `.b (JSON boolean) for "${t.key}" === ${t.accent2} (got ${r.bColor})`);
  }

  console.log('\nTheme picker UI:');
  const ui = await win.webContents.executeJavaScript(`
    (function() {
      const btn = document.getElementById('themeBtn');
      const menu = document.getElementById('themeMenu');
      const label = document.getElementById('themeLabel');
      // Open the picker
      btn.click();
      const itemCount = menu.querySelectorAll('.theme-item').length;
      const hasSections = menu.querySelectorAll('.theme-section').length;
      // Find the tokyo-night item and click it
      const item = menu.querySelector('.theme-item[data-theme="tokyo-night"]');
      const itemPresent = !!item;
      item && item.click();
      return {
        btnPresent: !!btn,
        menuPresent: !!menu,
        labelPresent: !!label,
        labelAfter: label ? label.textContent : null,
        itemCount,
        hasSections,
        itemPresent,
        dataThemeAfter: document.documentElement.getAttribute('data-theme')
      };
    })()
  `);
  assert(ui.btnPresent, 'theme button present');
  assert(ui.menuPresent, 'theme menu present');
  assert(ui.labelPresent, 'theme label present');
  assert(ui.itemCount === THEMES.length, `menu lists ${THEMES.length} themes (got ${ui.itemCount})`);
  assert(ui.hasSections >= 2, `menu has Dark/Light section headers (got ${ui.hasSections})`);
  assert(ui.itemPresent, 'tokyo-night item present in menu');
  assert(ui.dataThemeAfter === 'tokyo-night', 'clicking menu item switches theme');

  console.log('\nPersistence (localStorage):');
  const persisted = await win.webContents.executeJavaScript(
    `localStorage.getItem('jsonl-viewer:theme')`
  );
  assert(persisted === 'tokyo-night', `localStorage persisted "tokyo-night" (got "${persisted}")`);

  if (failures.length) {
    console.error(`\n${failures.length} FAILURE(S)`);
    app.exit(1);
  } else {
    console.log('\nALL THEME TESTS PASSED ✅');
    app.exit(0);
  }
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
  win.webContents.on('console-message', (_e, level, message) => {
    if (level <= 2) console.log(`[renderer:${level}] ${message}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer process gone:', details);
    app.exit(1);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
    .then(() => console.log('[main] loadFile resolved'))
    .then(runTests)
    .catch((err) => {
      console.error('Test failed:', err);
      app.exit(1);
    });
});

// Hard timeout in case something hangs.
setTimeout(() => {
  console.error('Test timed out');
  app.exit(1);
}, 20000);
