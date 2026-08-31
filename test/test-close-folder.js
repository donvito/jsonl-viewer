// Functional test: launches a custom Electron main process that loads the
// real renderer, opens a temp folder in the explorer, opens a file from it,
// then closes the folder and verifies the open file survives.
//
// Run with: ./node_modules/.bin/electron --no-sandbox --disable-gpu <this file>

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let win;
const failures = [];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-close-folder-'));
const fileA = path.join(tmp, 'alpha.jsonl');
const fileB = path.join(tmp, 'beta.jsonl');
fs.writeFileSync(fileA, '{"id":1,"name":"a"}\n{"id":2,"name":"b"}\n');
fs.writeFileSync(fileB, '{"id":3,"name":"c"}\n');

function parseJsonl(filePath) {
  const stat = fs.statSync(filePath);
  const parsedLines = [];
  const errors = [];
  const raws = fs.readFileSync(filePath, 'utf8').split('\n');
  let totalLines = 0;
  for (const raw of raws) {
    if (raw === '' ) continue;
    const trimmed = raw.trim();
    totalLines++;
    if (trimmed === '') continue;
    try {
      parsedLines.push({ index: totalLines - 1, raw: trimmed, value: JSON.parse(trimmed) });
    } catch (err) {
      parsedLines.push({ index: totalLines - 1, raw: trimmed, value: null, parseError: err.message });
      errors.push({ index: totalLines - 1, message: err.message });
    }
  }
  return { path: filePath, name: path.basename(filePath), sizeBytes: stat.size,
           totalLines, parsedLines, errors, truncated: false };
}

ipcMain.handle('theme:list', () => true);
ipcMain.handle('theme:current', () => true);
ipcMain.handle('recent:update', () => true);
ipcMain.handle('dialog:openFile', () => null);
ipcMain.handle('dialog:openFolder', () => tmp);
ipcMain.handle('dialog:saveFile', () => null);
ipcMain.handle('file:write', () => true);
ipcMain.handle('file:watch', () => true);
ipcMain.handle('shell:showItem', () => true);
ipcMain.handle('file:readRange', () => ({ lines: [] }));
ipcMain.handle('file:read', (_e, p) => parseJsonl(p));
ipcMain.handle('fs:stat', (_e, p) => {
  try {
    const st = fs.statSync(p);
    return { exists: true, isDirectory: st.isDirectory(), isFile: st.isFile(), size: st.size };
  } catch { return { exists: false }; }
});
ipcMain.handle('dir:list', (_e, dirPath) => {
  const entries = [];
  for (const name of fs.readdirSync(dirPath)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dirPath, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) entries.push({ name, path: full, kind: 'dir' });
    else if (/\.(jsonl|ndjson)$/i.test(name)) entries.push({ name, path: full, kind: 'file', size: st.size });
  }
  return { path: dirPath, name: path.basename(dirPath), entries };
});

function assert(cond, msg) {
  if (!cond) { failures.push(msg); console.error('  ✗ ' + msg); return false; }
  console.log('  ✓ ' + msg);
  return true;
}

const js = (code) => win.webContents.executeJavaScript(code);

async function runTests() {
  await new Promise((r) => setTimeout(r, 400));
  // Start from a clean slate: localStorage survives across runs in the same userData dir.
  await js(`(function(){ localStorage.clear(); explorer.folder=null; explorer.folderName='';
    explorer.children={}; explorer.expanded=new Set(); explorer.autoFolderDisabled=false;
    explorer.openFiles=[]; explorer.sessions={}; explorer.activePath=null; renderExplorer(); true; })()`);

  console.log('Explorer actions:');
  const actions = await js(`(function() {
    const buttons = Array.from(document.querySelectorAll('.explorer-actions button'));
    return {
      labels: buttons.map((button) => button.textContent.trim()),
      duplicateFolderCta: !!document.querySelector('#explorerTree button'),
      emptyText: document.querySelector('#explorerTree .explorer-empty').textContent
    };
  })()`);
  assert(actions.labels.join('|') === 'File|Folder|Traces',
    `explorer has one clear action row (got ${actions.labels.join(', ')})`);
  assert(actions.duplicateFolderCta === false, 'no duplicate Open Folder CTA in the empty state');
  assert(/^No folder open\./.test(actions.emptyText), 'empty state is informational');

  console.log('\nOpen folder:');
  const opened = await js(`
    (async function() {
      await openExplorerFolder(${JSON.stringify(tmp)});
      return {
        folder: explorer.folder,
        label: document.getElementById('explorerFolderLabel').textContent,
        closeHidden: document.getElementById('explorerCloseFolder').hidden,
        refreshHidden: document.getElementById('explorerRefresh').hidden,
        fileRows: document.querySelectorAll('#explorerTree .ex-file').length,
        stored: localStorage.getItem('jsonl-viewer:folder')
      };
    })()
  `);
  assert(opened.folder === tmp, 'explorer.folder set to opened folder');
  assert(opened.label === path.basename(tmp), `folder label shows "${path.basename(tmp)}" (got "${opened.label}")`);
  assert(opened.closeHidden === false, 'close-folder button visible while a folder is open');
  assert(opened.refreshHidden === false, 'refresh button visible while a folder is open');
  assert(opened.fileRows === 2, `tree lists 2 .jsonl files (got ${opened.fileRows})`);
  assert(opened.stored === tmp, 'folder persisted to localStorage');

  console.log('\nOpen a file from that folder:');
  const withFile = await js(`
    (async function() {
      await openFile(${JSON.stringify(fileA)});
      return {
        filePath: state.filePath,
        rows: state.parsedLines.length,
        openCount: explorer.openFiles.length,
        openSectionHidden: document.getElementById('explorerOpenSection').hidden,
        tabCount: document.querySelectorAll('#fileTabs .file-tab').length,
        activeTab: document.querySelector('#fileTabs .file-tab.active .file-tab-name')?.textContent,
        bodyRows: document.querySelectorAll('#viewPane tbody tr').length
      };
    })()
  `);
  assert(withFile.filePath === fileA, 'file loaded as active file');
  assert(withFile.rows === 2, `2 rows parsed (got ${withFile.rows})`);
  assert(withFile.openCount === 1, `1 entry in Open files (got ${withFile.openCount})`);
  assert(withFile.openSectionHidden === false, 'Open files section visible');
  assert(withFile.tabCount === 1, 'one file tab is visible');
  assert(withFile.activeTab === 'alpha.jsonl', 'opened file tab is active');

  console.log('\nHide and restore the explorer after opening a file:');
  const hidden = await js(`
    (function() {
      const workspace = document.getElementById('workspace');
      const workspaceMidpoint = workspace.getBoundingClientRect().top + workspace.getBoundingClientRect().height / 2;
      const hide = document.getElementById('explorerHide');
      const hideRect = hide.getBoundingClientRect();
      const hideCentered = Math.abs(hideRect.top + hideRect.height / 2 - workspaceMidpoint) < 1;
      hide.click();
      const restore = document.getElementById('explorerShow');
      const restoreRect = restore.getBoundingClientRect();
      const result = {
        explorerVisible: explorer.visible,
        workspaceHidden: document.getElementById('workspace').classList.contains('explorer-hidden'),
        restoreVisible: getComputedStyle(restore).display !== 'none',
        hideCentered,
        restoreCentered: Math.abs(restoreRect.top + restoreRect.height / 2 - workspaceMidpoint) < 1,
        filePath: state.filePath
      };
      restore.click();
      result.restored = explorer.visible;
      result.workspaceRestored = !document.getElementById('workspace').classList.contains('explorer-hidden');
      return result;
    })()
  `);
  assert(hidden.explorerVisible === false, 'hide button hides the explorer');
  assert(hidden.workspaceHidden === true, 'workspace enters explorer-hidden state');
  assert(hidden.restoreVisible === true, 'left-edge restore handle remains visible');
  assert(hidden.hideCentered === true, 'hide handle is vertically centered');
  assert(hidden.restoreCentered === true, 'restore handle uses the same vertical position');
  assert(hidden.filePath === fileA, 'active file remains loaded while explorer is hidden');
  assert(hidden.restored === true, 'restore handle shows the explorer again');
  assert(hidden.workspaceRestored === true, 'workspace leaves explorer-hidden state');

  console.log('\nClose the folder (click the ✕ button):');
  const closed = await js(`
    (function() {
      document.getElementById('explorerCloseFolder').click();
      return {
        folder: explorer.folder,
        folderName: explorer.folderName,
        childrenKeys: Object.keys(explorer.children).length,
        expandedSize: explorer.expanded.size,
        label: document.getElementById('explorerFolderLabel').textContent,
        closeHidden: document.getElementById('explorerCloseFolder').hidden,
        refreshHidden: document.getElementById('explorerRefresh').hidden,
        treeFileRows: document.querySelectorAll('#explorerTree .ex-file').length,
        emptyState: !!document.querySelector('#explorerTree .explorer-empty'),
        stored: localStorage.getItem('jsonl-viewer:folder'),
        explorerVisible: explorer.visible,
        // the open file must survive
        filePath: state.filePath,
        rows: state.parsedLines.length,
        openCount: explorer.openFiles.length,
        openSectionHidden: document.getElementById('explorerOpenSection').hidden,
        openRowActive: !!document.querySelector('#explorerOpenList .ex-row.active'),
        bodyRows: document.querySelectorAll('#viewPane tbody tr').length,
        fileInfo: document.getElementById('fileInfo').textContent
      };
    })()
  `);
  assert(closed.folder === null, 'explorer.folder cleared');
  assert(closed.folderName === '', 'folder name cleared');
  assert(closed.childrenKeys === 0, 'cached dir listings cleared');
  assert(closed.expandedSize === 0, 'expanded set cleared');
  assert(closed.label === 'No folder', `label back to "No folder" (got "${closed.label}")`);
  assert(closed.closeHidden === true, 'close-folder button hidden with no folder');
  assert(closed.refreshHidden === true, 'refresh button hidden with no folder');
  assert(closed.treeFileRows === 0, 'tree no longer lists folder files');
  assert(closed.emptyState, 'tree shows the "Open a folder" empty state');
  assert(closed.stored === null, 'stored folder removed from localStorage');
  assert(closed.explorerVisible === true, 'sidebar itself stays open');

  console.log('\n  — open file survives the close —');
  assert(closed.filePath === fileA, 'active file still loaded');
  assert(closed.rows === 2, `rows still in memory (got ${closed.rows})`);
  assert(closed.openCount === 1, `still 1 entry in Open files (got ${closed.openCount})`);
  assert(closed.openSectionHidden === false, 'Open files section still visible');
  assert(closed.openRowActive, 'open file still marked active in the sidebar');
  assert(closed.bodyRows === withFile.bodyRows && closed.bodyRows > 0,
    `table still rendered (${closed.bodyRows} rows)`);
  assert(/alpha\.jsonl/.test(closed.fileInfo), `header still names the file (got "${closed.fileInfo}")`);

  console.log('\nOpening another file does not re-adopt the closed folder:');
  const after = await js(`
    (async function() {
      await openFile(${JSON.stringify(fileB)});
      return {
        folder: explorer.folder,
        stored: localStorage.getItem('jsonl-viewer:folder'),
        openCount: explorer.openFiles.length,
        filePath: state.filePath,
        tabCount: document.querySelectorAll('#fileTabs .file-tab').length,
        activeTab: document.querySelector('#fileTabs .file-tab.active .file-tab-name')?.textContent
      };
    })()
  `);
  assert(after.folder === null, 'folder stays closed after opening another file');
  assert(after.stored === null, 'no folder re-persisted to localStorage');
  assert(after.filePath === fileB, 'the newly opened file is active');
  assert(after.openCount === 2, `both files listed as open (got ${after.openCount})`);
  assert(after.tabCount === 2, 'both open files have tabs');
  assert(after.activeTab === 'beta.jsonl', 'newly opened file tab is active');

  console.log('\nReopening a folder re-enables the tree:');
  const reopened = await js(`
    (async function() {
      await openExplorerFolder(${JSON.stringify(tmp)});
      return {
        folder: explorer.folder,
        autoDisabled: explorer.autoFolderDisabled,
        fileRows: document.querySelectorAll('#explorerTree .ex-file').length,
        closeHidden: document.getElementById('explorerCloseFolder').hidden,
        stored: localStorage.getItem('jsonl-viewer:folder'),
        openCount: explorer.openFiles.length
      };
    })()
  `);
  assert(reopened.folder === tmp, 'folder opens again after being closed');
  assert(reopened.autoDisabled === false, 'auto-adopt re-enabled on explicit open');
  assert(reopened.fileRows === 2, `tree lists files again (got ${reopened.fileRows})`);
  assert(reopened.closeHidden === false, 'close button visible again');
  assert(reopened.stored === tmp, 'folder persisted again');
  assert(reopened.openCount === 2, 'open files untouched by reopening the folder');

  console.log('\nMenu action (File › Close Folder):');
  const viaMenu = await js(`
    (function() {
      closeExplorerFolder();
      return { folder: explorer.folder, openCount: explorer.openFiles.length };
    })()
  `);
  assert(viaMenu.folder === null, 'closeExplorerFolder() clears the folder');
  assert(viaMenu.openCount === 2, 'open files still intact');

  console.log('\n' + (failures.length === 0
    ? '✅ All close-folder tests passed'
    : `❌ ${failures.length} failure(s):\n - ` + failures.join('\n - ')));
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1200, height: 800, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('    [renderer] ' + message);
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  try {
    await runTests();
  } catch (err) {
    failures.push('exception: ' + err.message);
    console.error(err);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(failures.length === 0 ? 0 : 1);
});
