const state = {
  filePath: null,
  fileName: null,
  totalLines: 0,
  sizeBytes: 0,
  parsedLines: [],
  errors: [],
  truncated: false,
  trace: null,
  maxLines: 5000,
  view: 'table',
  traceLayout: 'compact',
  traceExpansion: 'expanded',
  traceOpen: new Set(),
  traceClosed: new Set(),
  traceNavCurrent: -1,
  zoom: 1,
  filter: '',
  expanded: new Set(),
  treeExpanded: new Set(),
  selectedIndex: null,
  editMode: false,
  columnWidths: {},
  showSidebarRaw: false,
  allKeys: [],
  columnVisibility: {},
  recent: []
};

// Trace detail values stay in memory instead of being copied into HTML
// attributes. This keeps large tool inputs/results out of the DOM and makes
// the copy buttons safe for arbitrary trace content.
const traceCopyValues = new Map();
let traceCopySerial = 0;

const TRACE_SOURCES = [
  { key: 'codex', label: 'Codex', location: '~/.codex/sessions' },
  { key: 'claude', label: 'Claude Code', location: '~/.claude/projects' },
  { key: 'pi', label: 'Pi', location: '~/.pi/agent/sessions' },
  { key: 'hermes', label: 'Hermes', location: '~/.hermes/session-exports/traces' }
];
const traceSourceResults = new Map();
const traceSourceFileValues = new Map();
let traceSourceFileSerial = 0;
let traceSourcesRequest = 0;

const explorer = {
  visible: true,
  width: 248,
  folder: null,
  folderName: '',
  autoFolderDisabled: false,
  children: {},
  expanded: new Set(),
  openFiles: [],
  sessions: {},
  activePath: null
};

const $ = (sel) => document.querySelector(sel);

const els = {
  workspace: $('#workspace'),
  explorer: $('#explorer'),
  explorerShow: $('#explorerShow'),
  explorerOpenFile: $('#explorerOpenFile'),
  explorerOpenFolder: $('#explorerOpenFolder'),
  explorerOpenTraces: $('#explorerOpenTraces'),
  explorerHide: $('#explorerHide'),
  explorerRefresh: $('#explorerRefresh'),
  explorerCloseFolder: $('#explorerCloseFolder'),
  explorerOpenSection: $('#explorerOpenSection'),
  explorerOpenList: $('#explorerOpenList'),
  explorerFolderLabel: $('#explorerFolderLabel'),
  explorerTree: $('#explorerTree'),
  explorerResizer: $('#explorerResizer'),
  emptyOpenFile: $('#emptyOpenFile'),
  emptyOpenFolder: $('#emptyOpenFolder'),
  loadMoreBtn: $('#loadMoreBtn'),
  themeBtn: $('#themeBtn'),
  themeLabel: $('#themeLabel'),
  themeMenu: $('#themeMenu'),
  traceSourcesMenu: $('#traceSourcesMenu'),
  editToggle: $('#editToggle'),
  saveBtn: $('#saveBtn'),
  fileInfo: $('#fileInfo'),
  controls: $('#controls'),
  search: $('#search'),
  stat: $('#stat'),
  traceViewToggle: $('#traceViewToggle'),
  traceControls: $('#traceControls'),
  traceNav: $('#traceNav'),
  traceNavUp: $('#traceNavUp'),
  traceNavDown: $('#traceNavDown'),
  traceNavPos: $('#traceNavPos'),
  content: $('#content'),
  viewPane: $('#viewPane'),
  sidebar: $('#sidebar'),
  sidebarTitle: $('#sidebarTitle'),
  sidebarBody: $('#sidebarBody'),
  sidebarClose: $('#sidebarClose'),
  sidebarCopy: $('#sidebarCopy'),
  sidebarRawToggle: $('#sidebarRawToggle'),
  colToggle: $('#colToggle'),
  colPopover: $('#colPopover'),
  treeExpandAll: $('#treeExpandAll'),
  treeCollapseAll: $('#treeCollapseAll'),
  emptyState: $('#emptyState'),
  emptyTraceSources: $('#emptyTraceSources'),
  zoomOutBtn: $('#zoomOutBtn'),
  zoomResetBtn: $('#zoomResetBtn'),
  zoomInBtn: $('#zoomInBtn'),
  dropOverlay: $('#dropOverlay'),
  ctxMenu: $('#ctxMenu')
};

const COL_DEFAULTS = { line: 60, actions: 44, __value: 220 };
const COL_MIN = 50;
const ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5];

function zoomIndex(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ZOOM_LEVELS.indexOf(1);
  let best = 0;
  let distance = Infinity;
  ZOOM_LEVELS.forEach((level, index) => {
    const nextDistance = Math.abs(level - n);
    if (nextDistance < distance) {
      best = index;
      distance = nextDistance;
    }
  });
  return best;
}

function persistZoom() {
  try { localStorage.setItem('jsonl-viewer:zoom', String(state.zoom)); } catch (e) {}
}

function updateZoomControls() {
  const index = zoomIndex(state.zoom);
  const label = `${Math.round(state.zoom * 100)}%`;
  if (els.zoomOutBtn) els.zoomOutBtn.disabled = index <= 0;
  if (els.zoomInBtn) els.zoomInBtn.disabled = index >= ZOOM_LEVELS.length - 1;
  if (els.zoomResetBtn) {
    els.zoomResetBtn.textContent = label;
    els.zoomResetBtn.title = state.zoom === 1 ? 'Zoom (100%)' : 'Reset zoom to 100%';
    els.zoomResetBtn.setAttribute('aria-label', state.zoom === 1 ? 'Zoom, 100 percent' : `Reset zoom to 100 percent (currently ${label})`);
  }
}

function setZoom(value, { persist = true } = {}) {
  const next = ZOOM_LEVELS[zoomIndex(value)];
  const pane = els.viewPane;
  const scrollTop = pane ? pane.scrollTop : 0;
  const scrollLeft = pane ? pane.scrollLeft : 0;
  state.zoom = next;
  try {
    if (window.api && window.api.setZoomFactor) window.api.setZoomFactor(next);
    else document.documentElement.style.zoom = String(next);
  } catch (e) {}
  if (persist) persistZoom();
  updateZoomControls();
  if (pane) {
    requestAnimationFrame(() => {
      pane.scrollTop = scrollTop;
      pane.scrollLeft = scrollLeft;
    });
  }
}

function changeZoom(direction) {
  const index = zoomIndex(state.zoom);
  setZoom(ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index + direction))]);
}

(function initZoom() {
  let saved = null;
  try {
    const raw = localStorage.getItem('jsonl-viewer:zoom');
    if (raw !== null) saved = Number(raw);
  } catch (e) {}
  setZoom(Number.isFinite(saved) ? saved : 1, { persist: false });
})();

function colWidth(id) {
  return state.columnWidths[id] || COL_DEFAULTS[id] || COL_DEFAULTS.__value;
}

function persistColumnWidths() {
  try { localStorage.setItem('jsonl-viewer:colWidths', JSON.stringify(state.columnWidths)); } catch (e) {}
}

(function loadColumnWidths() {
  try {
    const w = localStorage.getItem('jsonl-viewer:colWidths');
    if (w) state.columnWidths = JSON.parse(w);
  } catch (e) {}
})();

function recomputeAllKeys() {
  state.allKeys = collectKeys(state.parsedLines);
}

function recomputeTrace() {
  state.trace = window.traceParser && window.traceParser.parse
    ? window.traceParser.parse(state.parsedLines, state.filePath)
    : null;
  if (!state.trace && state.view === 'trace') state.view = 'table';
}

function visibleKeys() {
  return state.allKeys.filter((k) => state.columnVisibility[k] !== false);
}

function persistColumnVisibility() {
  try { localStorage.setItem('jsonl-viewer:colVis', JSON.stringify(state.columnVisibility)); } catch (e) {}
}

(function loadColumnVisibility() {
  try {
    const v = localStorage.getItem('jsonl-viewer:colVis');
    if (v) state.columnVisibility = JSON.parse(v);
  } catch (e) {}
})();

// ---- Recent files ----
function persistRecent() {
  try { localStorage.setItem('jsonl-viewer:recent', JSON.stringify(state.recent)); } catch (e) {}
  if (window.api && window.api.updateRecent) window.api.updateRecent(state.recent);
}
(function loadRecent() {
  try {
    const r = localStorage.getItem('jsonl-viewer:recent');
    if (r) state.recent = JSON.parse(r).filter((p) => typeof p === 'string');
  } catch (e) {}
})();
function addRecent(filePath) {
  if (!filePath) return;
  state.recent = [filePath, ...state.recent.filter((p) => p !== filePath)].slice(0, 10);
  persistRecent();
}

function samePath(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
}

function fileName(p) {
  return String(p || '').split(/[\\/]/).pop() || String(p || '');
}

function findOpen(filePath) {
  return explorer.openFiles.find((f) => samePath(f.path, filePath)) || null;
}

function sessionKey(filePath) {
  const hit = findOpen(filePath);
  return hit ? hit.path : filePath;
}

function markDirty(on = true) {
  if (!state.filePath) return;
  const entry = findOpen(state.filePath);
  if (entry && entry.dirty !== on) {
    entry.dirty = on;
    renderExplorer();
  }
}

// ---- Theme ----
// Single source of truth for the available themes. Each entry's `key`
// matches a `:root[data-theme="<key>"]` block in themes.css; `accent` is
// used to render the swatch preview in the picker; `isLight` groups the
// picker menu into Dark / Light sections. The list is also forwarded to
// the main process so the native menu's Theme submenu can mirror it.
const THEMES = [
  { key: 'dark',           label: 'Mocha',           accent: '#89b4fa', isLight: false },
  { key: 'tokyo-night',    label: 'Tokyo Night',     accent: '#7aa2f7', isLight: false },
  { key: 'dracula',        label: 'Dracula',         accent: '#bd93f9', isLight: false },
  { key: 'gruvbox-dark',   label: 'Gruvbox Dark',    accent: '#83a598', isLight: false },
  { key: 'solarized-dark', label: 'Solarized Dark',  accent: '#268bd2', isLight: false },
  { key: 'github-dark',    label: 'GitHub Dark',     accent: '#58a6ff', isLight: false },
  { key: 'one-dark',       label: 'One Dark',        accent: '#61afef', isLight: false },
  { key: 'light',          label: 'Latte',           accent: '#1e66f5', isLight: true  },
  { key: 'solarized-light',label: 'Solarized Light', accent: '#268bd2', isLight: true  },
  { key: 'github-light',   label: 'GitHub Light',    accent: '#0969da', isLight: true  }
];

function themeMeta(key) {
  return THEMES.find((t) => t.key === key) || THEMES[0];
}

function applyTheme(theme) {
  const meta = themeMeta(theme);
  document.documentElement.setAttribute('data-theme', meta.key);
  els.themeLabel.textContent = meta.label;
  els.themeBtn.title = `Theme: ${meta.label}`;
  els.themeBtn.setAttribute('aria-label', `Theme: ${meta.label}`);
  // Reflect the active theme in the open picker, if any
  els.themeMenu.querySelectorAll('.theme-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === meta.key);
  });
  try { localStorage.setItem('jsonl-viewer:theme', meta.key); } catch (e) {}
  if (window.api && window.api.updateTheme) window.api.updateTheme(meta.key);
}

function toggleTheme() {
  // Cycle through themes — handy for the View menu and keyboard users.
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const idx = THEMES.findIndex((t) => t.key === current);
  const next = THEMES[(idx + 1) % THEMES.length];
  applyTheme(next.key);
}

function setTheme(key) {
  if (!THEMES.some((t) => t.key === key)) return;
  applyTheme(key);
}

function renderThemeMenu() {
  const sections = { dark: [], light: [] };
  for (const t of THEMES) (t.isLight ? sections.light : sections.dark).push(t);
  const renderSection = (title, items) => `
    <div class="theme-section">${title}</div>
    ${items.map((t) => `
      <button type="button" class="theme-item" data-theme="${escapeHtml(t.key)}">
        <span class="theme-swatch" style="background:${escapeHtml(t.accent)}"></span>
        <span class="theme-name">${escapeHtml(t.label)}</span>
        <span class="theme-check">✓</span>
      </button>
    `).join('')}
  `;
  els.themeMenu.innerHTML = renderSection('Dark', sections.dark) + renderSection('Light', sections.light);
  els.themeMenu.querySelectorAll('.theme-item').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setTheme(btn.dataset.theme);
      closeThemeMenu();
    });
  });
  // Reflect currently applied theme
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  els.themeMenu.querySelectorAll('.theme-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === current);
  });
}

function openThemeMenu() {
  renderThemeMenu();
  els.themeMenu.hidden = false;
  els.themeBtn.setAttribute('aria-expanded', 'true');
}

function closeThemeMenu() {
  els.themeMenu.hidden = true;
  els.themeBtn.setAttribute('aria-expanded', 'false');
}

function toggleThemeMenu() {
  if (els.themeMenu.hidden) openThemeMenu(); else closeThemeMenu();
}

(function initTheme() {
  let theme;
  try { theme = localStorage.getItem('jsonl-viewer:theme'); } catch (e) {}
  if (!THEMES.some((t) => t.key === theme)) theme = 'dark';
  applyTheme(theme);
  if (window.api && window.api.setThemeList) window.api.setThemeList(THEMES);
})();

// ---- Helpers ----
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---- Common agent trace locations ----
function traceSourceDefinition(key) {
  return TRACE_SOURCES.find((source) => source.key === key) || null;
}

function formatTraceSourceTime(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(Number(value)) || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

function traceSourceLocationLabel(source, result) {
  const roots = result && Array.isArray(result.roots) ? result.roots : [];
  const existing = roots.filter((root) => root.exists && root.displayPath).map((root) => root.displayPath);
  const all = roots.filter((root) => root.displayPath).map((root) => root.displayPath);
  return (existing.length ? existing : all).join(' · ') || source.location;
}

function traceSourceFileToken(filePath) {
  const token = `trace-source-file-${++traceSourceFileSerial}`;
  traceSourceFileValues.set(token, filePath);
  return token;
}

function renderTraceSourcesMenu() {
  if (!els.traceSourcesMenu) return;
  traceSourceFileValues.clear();
  const sourceCards = TRACE_SOURCES.map((source) => {
    const result = traceSourceResults.get(source.key);
    const location = traceSourceLocationLabel(source, result);
    const folder = result && Array.isArray(result.roots)
      ? result.roots.find((root) => root.exists)
      : null;
    const folderButton = folder
      ? `<button type="button" class="trace-source-folder" data-trace-folder="${escapeHtml(source.key)}">Open folder</button>`
      : '';

    let body = '<div class="trace-source-loading">Scanning…</div>';
    if (result) {
      if (result.error) {
        body = `<div class="trace-source-empty">${escapeHtml(result.error)}</div>`;
      } else if (result.files && result.files.length) {
        const files = result.files.map((file) => {
          const token = traceSourceFileToken(file.path);
          const detail = [
            file.displayPath,
            formatBytes(file.size),
            formatTraceSourceTime(file.mtimeMs)
          ].filter(Boolean).join(' · ');
          return `<button type="button" class="trace-source-file" data-trace-file="${escapeHtml(token)}" title="${escapeHtml(file.path)}">
            <span class="trace-source-file-name">${escapeHtml(file.name)}</span>
            <span class="trace-source-file-detail">${escapeHtml(detail)}</span>
          </button>`;
        }).join('');
        const total = Number(result.totalFiles) || result.files.length;
        const more = total > result.files.length
          ? `<div class="trace-source-count">Showing the latest ${result.files.length} of ${total} traces</div>`
          : `<div class="trace-source-count">${total} trace${total === 1 ? '' : 's'}</div>`;
        body = `<div class="trace-source-files">${files}</div>${more}`;
      } else {
        body = '<div class="trace-source-empty">No JSONL traces found here.</div>';
        if (result.emptyNote) {
          body += `<div class="trace-source-note">${escapeHtml(result.emptyNote)}</div>`;
        }
      }
    }

    return `<section class="trace-source-card">
      <div class="trace-source-head">
        <div class="trace-source-name"><strong>${escapeHtml(source.label)}</strong><code>${escapeHtml(location)}</code></div>
        ${folderButton}
      </div>
      ${body}
    </section>`;
  }).join('');

  els.traceSourcesMenu.innerHTML = `<div class="trace-sources-head">
    <div><strong>Open agent traces</strong><span>Choose a recent session</span></div>
    <button type="button" class="trace-sources-refresh" data-trace-refresh title="Refresh trace locations" aria-label="Refresh trace locations">↻</button>
  </div><div class="trace-sources-list">${sourceCards}</div>`;

  const refresh = els.traceSourcesMenu.querySelector('[data-trace-refresh]');
  if (refresh) refresh.addEventListener('click', (event) => {
    event.stopPropagation();
    loadTraceSources();
  });
  els.traceSourcesMenu.querySelectorAll('[data-trace-file]').forEach((button) => {
    button.addEventListener('click', () => openTraceSourceFile(button.dataset.traceFile));
  });
  els.traceSourcesMenu.querySelectorAll('[data-trace-folder]').forEach((button) => {
    button.addEventListener('click', () => openTraceSourceFolder(button.dataset.traceFolder));
  });
}

async function loadTraceSources() {
  if (!els.traceSourcesMenu || !window.api.listTraceFiles) return;
  const request = ++traceSourcesRequest;
  traceSourceResults.clear();
  renderTraceSourcesMenu();
  const results = await Promise.all(TRACE_SOURCES.map(async (source) => {
    try {
      return await window.api.listTraceFiles(source.key);
    } catch (error) {
      return { key: source.key, label: source.label, roots: [], files: [], error: error.message || 'Unable to scan this location' };
    }
  }));
  if (request !== traceSourcesRequest || els.traceSourcesMenu.hidden) return;
  results.forEach((result) => traceSourceResults.set(result.key, result));
  renderTraceSourcesMenu();
}

async function openTraceSourceFile(token) {
  const filePath = traceSourceFileValues.get(token);
  closeTraceSourcesMenu();
  if (filePath) await openFile(filePath);
}

async function openTraceSourceFolder(key) {
  const source = traceSourceDefinition(key);
  const result = traceSourceResults.get(key);
  const root = result && Array.isArray(result.roots) ? result.roots.find((item) => item.exists) : null;
  closeTraceSourcesMenu();
  if (!root) {
    showToast(`${source ? source.label : 'Trace'} folder not found`, { kind: 'error' });
    return;
  }
  await openExplorerFolder(root.path, { persist: true });
}

function closeTraceSourcesMenu() {
  if (!els.traceSourcesMenu) return;
  els.traceSourcesMenu.hidden = true;
}

function openTraceSourcesMenu() {
  if (!els.traceSourcesMenu) return;
  if (!els.traceSourcesMenu.hidden) {
    closeTraceSourcesMenu();
    return;
  }
  if (els.themeMenu) closeThemeMenu();
  if (els.colPopover) els.colPopover.hidden = true;
  els.traceSourcesMenu.hidden = false;
  renderTraceSourcesMenu();
  loadTraceSources();
}


// Produce syntax-highlighted HTML from a JS value
function highlightValue(value, indent = 0) {
  if (value === null) return '<span class="null">null</span>';
  if (value === undefined) return '<span class="null">undefined</span>';
  if (typeof value === 'boolean') return `<span class="b">${value}</span>`;
  if (typeof value === 'number') return `<span class="n">${value}</span>`;
  if (typeof value === 'string') return `<span class="s">${escapeHtml(JSON.stringify(value))}</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="punc">[]</span>';
    const pad = '  '.repeat(indent + 1);
    const closePad = '  '.repeat(indent);
    const items = value.map((v) => pad + highlightValue(v, indent + 1)).join('<span class="punc">,</span>\n');
    return `<span class="punc">[</span>\n${items}\n${closePad}<span class="punc">]</span>`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '<span class="punc">{}</span>';
    const pad = '  '.repeat(indent + 1);
    const closePad = '  '.repeat(indent);
    const entries = keys.map((k) =>
      `${pad}<span class="k">${escapeHtml(JSON.stringify(k))}</span><span class="punc">: </span>${highlightValue(value[k], indent + 1)}`
    ).join('<span class="punc">,</span>\n');
    return `<span class="punc">{</span>\n${entries}\n${closePad}<span class="punc">}</span>`;
  }
  return escapeHtml(String(value));
}

function shortPreview(value) {
  if (value === null) return 'null';
  const json = JSON.stringify(value);
  if (json.length <= 160) return json;
  return json.slice(0, 157) + '…';
}

function collectKeys(lines) {
  const keys = new Set();
  for (const l of lines) {
    if (l.value && typeof l.value === 'object' && !Array.isArray(l.value)) {
      for (const k of Object.keys(l.value)) keys.add(k);
    }
  }
  return Array.from(keys);
}

// ---- Rendering ----
function render() {
  const activeViewRadio = document.querySelector(`input[name="view"][value="${state.view}"]`);
  if (activeViewRadio) activeViewRadio.checked = true;
  if (!state.filePath) {
    els.controls.hidden = true;
    els.viewPane.innerHTML = '';
    els.viewPane.appendChild(els.emptyState);
    els.emptyState.hidden = false;
    els.sidebar.hidden = true;
    els.saveBtn.classList.add('hidden-slot');
    els.colToggle.hidden = true;
    els.treeExpandAll.hidden = true;
    els.treeCollapseAll.hidden = true;
    els.traceViewToggle.hidden = true;
    els.traceControls.hidden = true;
    els.traceNav.hidden = true;
    els.editToggle.hidden = false;
    els.search.placeholder = 'Filter rows by text (searches raw JSON)…';
    return;
  }

  els.emptyState.hidden = true;
  els.controls.hidden = false;
  els.traceViewToggle.hidden = !state.trace;
  els.traceControls.hidden = state.view !== 'trace' || !state.trace;
  els.traceNav.hidden = state.view !== 'trace' || !state.trace;
  els.search.placeholder = state.view === 'trace'
    ? 'Filter trace content (messages, tools, results)…'
    : 'Filter rows by text (searches raw JSON)…';
  els.colToggle.hidden = state.view !== 'table';
  els.treeExpandAll.hidden = state.view !== 'tree';
  els.treeCollapseAll.hidden = state.view !== 'tree';
  els.editToggle.hidden = state.view === 'trace';

  const filtered = applyFilter(state.parsedLines);

  if (state.view === 'table') {
    renderTable(filtered);
  } else if (state.view === 'tree') {
    renderTree(filtered);
  } else if (state.view === 'trace' && state.trace) {
    renderTrace(state.trace);
  } else {
    renderRaw(filtered);
  }

  renderSidebar();

  const shown = state.view === 'trace' && state.trace
    ? filteredTraceItems(state.trace).length
    : filtered.length;
  const statPrefix = state.view === 'trace' && state.trace ? 'trace items' : 'loaded';
  els.stat.textContent = `Showing ${shown} ${statPrefix} · ${state.totalLines} total in file${state.errors.length ? ` · ${state.errors.length} parse errors` : ''}`;
  els.loadMoreBtn.disabled = !state.truncated;
  els.saveBtn.classList.toggle('hidden-slot', !state.editMode);
}

function findLine(index) {
  return state.parsedLines.find((l) => l.index === index) || null;
}

function selectRow(index) {
  state.selectedIndex = index;
  renderSidebar();
  // Update highlight without full re-render
  els.viewPane.querySelectorAll('.selected').forEach((el) => el.classList.remove('selected'));
  const sel = els.viewPane.querySelector(`[data-idx="${index}"]`);
  if (sel) sel.classList.add('selected');
}

function renderSidebar() {
  if (state.selectedIndex === null) {
    els.sidebar.hidden = true;
    return;
  }
  const l = findLine(state.selectedIndex);
  if (!l) {
    els.sidebar.hidden = true;
    return;
  }
  els.sidebar.hidden = false;
  els.sidebarTitle.textContent = `Row ${l.index + 1}${l.parseError ? ' · parse error' : ''}`;
  els.sidebarRawToggle.classList.toggle('active', state.showSidebarRaw);

  const rawBlock = (idAttr) => state.showSidebarRaw
    ? `<div class="sidebar-raw"><div class="sidebar-label">Raw line</div><div class="sidebar-raw-text"${idAttr ? ` id="${idAttr}"` : ''}>${escapeHtml(l.raw)}</div></div>`
    : '';

  let body;
  if (state.editMode) {
    const initial = l.parseError ? l.raw : JSON.stringify(l.value, null, 2);
    body = `<div class="sidebar-label">Formatted JSON — editable</div>
      <textarea class="sidebar-edit" id="sidebarEdit" spellcheck="false">${escapeHtml(initial)}</textarea>
      ${rawBlock('sidebarRaw')}`;
    els.sidebarBody.innerHTML = body;
    const ta = $('#sidebarEdit');
    const rawEl = $('#sidebarRaw');
    const update = () => {
      const text = ta.value;
      try {
        l.value = JSON.parse(text);
        l.raw = JSON.stringify(l.value);
        l.parseError = null;
        ta.classList.remove('invalid');
        state.errors = state.errors.filter((e) => e.index !== l.index);
      } catch (err) {
        l.value = null;
        l.parseError = err.message;
        l.raw = text;
        ta.classList.add('invalid');
      }
      if (rawEl) rawEl.textContent = l.raw;
      els.sidebarTitle.textContent = `Row ${l.index + 1}${l.parseError ? ' · parse error' : ''}`;
      recomputeTrace();
      markDirty(true);
    };
    ta.addEventListener('input', update);
    ta.addEventListener('blur', () => render());
    return;
  }

  if (l.parseError) {
    body = `<div class="sidebar-label">Parse error</div>
      <div class="sidebar-raw-text" style="color:var(--red)">${escapeHtml(l.parseError)}</div>
      ${rawBlock(null)}`;
  } else {
    const pretty = highlightValue(l.value);
    body = `<div class="sidebar-label">Formatted JSON</div><div class="sidebar-json">${pretty}</div>
      ${rawBlock(null)}`;
  }
  els.sidebarBody.innerHTML = body;
}

function applyFilter(lines) {
  const q = state.filter.trim().toLowerCase();
  if (!q) return lines;
  return lines.filter((l) => (l.raw || '').toLowerCase().includes(q));
}

function parseCellValue(text) {
  // Try JSON first; fall back to treating the text as a string literal.
  try { return JSON.parse(text); } catch (e) {}
  return text;
}

function commitCellEdit(line, key, text) {
  const newVal = parseCellValue(text);
  if (keys_count(line) === 0) {
    line.value = newVal;
  } else {
    line.value[key] = newVal;
  }
  line.raw = JSON.stringify(line.value);
  line.parseError = null;
  state.errors = state.errors.filter((e) => e.index !== line.index);
  recomputeTrace();
  markDirty(true);
}

function keys_count(line) {
  return line.value && typeof line.value === 'object' && !Array.isArray(line.value) ? Object.keys(line.value).length : 0;
}

function renderTable(lines) {
  const keys = visibleKeys();
  const colIds = ['actions', 'line', ...(keys.length ? keys : ['__value'])];
  // The last value column is left flexible (auto) so it absorbs slack;
  // this keeps the # and actions columns from stretching when columns are hidden.
  const flexId = colIds[colIds.length - 1];
  const colgroup = colIds.map((id) => {
    const isFlex = id === flexId && state.columnWidths[id] == null;
    const w = isFlex ? 'auto' : colWidth(id) + 'px';
    return `<col data-colid="${escapeHtml(id)}" style="width:${w}"></col>`;
  }).join('');
  const headerCells = [
    '<th data-colid="actions" class="col-actions"></th>',
    '<th data-colid="line" class="col-line">#</th>',
    ...keys.map((k) => `<th data-colid="${escapeHtml(k)}">${escapeHtml(k)}</th>`),
    !keys.length ? '<th data-colid="__value">Value</th>' : ''
  ].join('');

  const editable = state.editMode;

  const rows = lines.map((l) => {
    const expanded = state.expanded.has(l.index);
    const isError = !!l.parseError;
    const selected = state.selectedIndex === l.index ? ' selected' : '';
    const chevron = '<svg class="chevron" viewBox="0 0 16 16" width="12" height="12"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const expandBtn = `<button class="row-expand-btn${expanded ? ' expanded' : ''}" data-idx="${l.index}" title="${expanded ? 'Collapse row' : 'Expand row'}" aria-label="${expanded ? 'Collapse row' : 'Expand row'}">${chevron}</button>`;

    let cells;
    if (isError) {
      cells = `<td colspan="${keys.length || 1}"><span class="err-badge">⚠ ${escapeHtml(l.parseError)}</span><div class="preview">${escapeHtml(l.raw)}</div></td>`;
    } else if (keys.length === 0) {
      const inner = editable
        ? `<div class="preview" contenteditable="true" data-edit="value" data-idx="${l.index}"></div>`
        : `<div class="preview">${highlightValue(l.value)}</div>`;
      cells = `<td class="cell-editable">${inner}</td>`;
    } else {
      cells = keys.map((k) => {
        const present = l.value && typeof l.value === 'object' && Object.prototype.hasOwnProperty.call(l.value, k);
        if (!present) return `<td><span style="color:var(--text-faint)">—</span></td>`;
        const v = l.value[k];
        if (editable) {
          return `<td class="cell-editable"><div class="preview" contenteditable="true" data-edit="${escapeHtml(k)}" data-idx="${l.index}"></div></td>`;
        }
        return `<td><div class="preview">${highlightValue(v)}</div></td>`;
      }).join('');
    }

    let detailRow = '';
    if (expanded && !isError) {
      detailRow = `<tr class="detail"><td colspan="${keys.length + 2}"><div class="detail-panel"><div class="label">Line ${l.index + 1} · full JSON</div>${highlightValue(l.value)}</div></td></tr>`;
    }

    return `<tr class="${isError ? 'error' : ''}${selected}" data-idx="${l.index}">
      <td class="col-actions">${expandBtn}</td>
      <td class="col-line">${l.index + 1}</td>
      ${cells}
    </tr>${detailRow}`;
  }).join('');

  els.viewPane.innerHTML = `
    <table class="jsonl">
      <colgroup>${colgroup}</colgroup>
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  // Populate editable cells with raw JSON text (so editing is predictable)
  if (editable) {
    els.viewPane.querySelectorAll('[contenteditable="true"]').forEach((el) => {
      const idx = Number(el.dataset.idx);
      const line = findLine(idx);
      if (!line) return;
      const key = el.dataset.edit;
      const v = key === 'value' ? line.value : (line.value && line.value[key]);
      el.textContent = JSON.stringify(v);
      el.addEventListener('blur', () => {
        const text = el.textContent;
        commitCellEdit(line, key, text);
        render();
      });
      el.addEventListener('click', (e) => e.stopPropagation());
    });
  }

  els.viewPane.querySelectorAll('.row-expand-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      if (state.expanded.has(idx)) state.expanded.delete(idx);
      else state.expanded.add(idx);
      render();
    });
  });

  els.viewPane.querySelectorAll('tr[data-idx]').forEach((tr) => {
    tr.addEventListener('click', () => selectRow(Number(tr.dataset.idx)));
  });

  setupColumnResizers();
}

function setupColumnResizers() {
  const ths = els.viewPane.querySelectorAll('table.jsonl thead th[data-colid]');
  ths.forEach((th) => {
    const resizer = document.createElement('div');
    resizer.className = 'col-resizer';
    th.appendChild(resizer);
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const colId = th.dataset.colid;
      const col = Array.from(els.viewPane.querySelectorAll('col')).find((c) => c.dataset.colid === colId);
      if (!col) return;
      const startX = e.clientX;
      const startWidth = col.getBoundingClientRect().width;
      resizer.classList.add('dragging');
      document.body.classList.add('col-resizing');

      const onMove = (ev) => {
        const w = Math.max(COL_MIN, Math.round(startWidth + (ev.clientX - startX)));
        col.style.width = w + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        resizer.classList.remove('dragging');
        document.body.classList.remove('col-resizing');
        const w = parseFloat(col.style.width);
        if (!isNaN(w)) {
          state.columnWidths[colId] = w;
          persistColumnWidths();
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

function renderRaw(lines) {
  if (state.editMode) {
    const rows = lines.map((l) => {
      const selected = state.selectedIndex === l.index ? ' selected' : '';
      return `<div class="raw-row ${selected}" data-idx="${l.index}">
        <div class="ln">${l.index + 1}</div>
        <div class="txt"><textarea class="raw-edit" data-idx="${l.index}">${escapeHtml(l.raw)}</textarea></div>
      </div>`;
    }).join('');
    els.viewPane.innerHTML = `<div class="raw-view">${rows}</div>`;
    els.viewPane.querySelectorAll('.raw-edit').forEach((ta) => {
      const idx = Number(ta.dataset.idx);
      ta.addEventListener('click', (e) => e.stopPropagation());
      ta.addEventListener('input', () => {
        const line = findLine(idx);
        if (!line) return;
        try {
          line.value = JSON.parse(ta.value);
          line.parseError = null;
          line.raw = ta.value;
          ta.classList.remove('invalid');
          state.errors = state.errors.filter((e) => e.index !== idx);
        } catch (err) {
          line.value = null;
          line.parseError = err.message;
          line.raw = ta.value;
          ta.classList.add('invalid');
        }
        recomputeTrace();
        markDirty(true);
      });
      ta.addEventListener('blur', () => render());
    });
    els.viewPane.querySelectorAll('.raw-row[data-idx]').forEach((row) => {
      row.addEventListener('click', () => selectRow(Number(row.dataset.idx)));
    });
    return;
  }

  const rows = lines.map((l) => {
    const cls = (l.parseError ? 'error' : '') + (state.selectedIndex === l.index ? ' selected' : '');
    return `<div class="raw-row ${cls}" data-idx="${l.index}"><div class="ln">${l.index + 1}</div><div class="txt">${escapeHtml(l.raw)}</div></div>`;
  }).join('');
  els.viewPane.innerHTML = `<div class="raw-view">${rows}</div>`;
  els.viewPane.querySelectorAll('.raw-row[data-idx]').forEach((row) => {
    row.addEventListener('click', () => selectRow(Number(row.dataset.idx)));
  });
}

// ---- Agent trace view ----
function filteredTraceItems(trace) {
  if (!trace) return [];
  const q = state.filter.trim().toLowerCase();
  if (!q) return trace.items;
  return trace.items.filter((item) => (item.searchText || '').includes(q));
}

function traceDisclosureOpen(key) {
  if (state.traceOpen.has(key)) return true;
  if (state.traceClosed.has(key)) return false;
  return state.traceExpansion === 'expanded';
}

function toggleTraceDisclosure(key) {
  if (traceDisclosureOpen(key)) {
    state.traceOpen.delete(key);
    state.traceClosed.add(key);
  } else {
    state.traceClosed.delete(key);
    state.traceOpen.add(key);
  }
}

function traceCopyToken(value) {
  const key = `trace-copy-${traceCopySerial++}`;
  traceCopyValues.set(key, value == null ? '' : String(value));
  return key;
}

function formatTraceValue(value) {
  if (value == null || value === '') return '—';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return String(part);
      if (part.type === 'image' || part.type === 'input_image' || part.type === 'output_image') return '[image attachment]';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.thinking === 'string') return part.thinking;
      return null;
    });
    if (parts.every((part) => part != null)) return parts.join('\n');
  }
  if (typeof value === 'object' && (typeof value.stdout === 'string' || typeof value.stderr === 'string')) {
    return [value.stdout, value.stderr].filter((part) => part).join('\n');
  }
  try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
}

function traceCompactValue(value, maxLength = 180) {
  const compact = formatTraceValue(value).replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return compact.slice(0, maxLength - 1) + '…';
}

function traceInlineMarkdown(text) {
  let output = escapeHtml(text);
  output = output.replace(/`([^`]+)`/g, '<code>$1</code>');
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  output = output.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
  return output;
}

// Small, safe Markdown subset for agent responses. Trace content is escaped
// before formatting so model output can never inject renderer HTML.
function renderTraceMarkdown(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let inCode = false;
  let codeLines = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      closeList();
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length);
      html.push(`<h${level}>${traceInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      const nextType = bullet ? 'ul' : 'ol';
      if (listType !== nextType) {
        closeList();
        listType = nextType;
        html.push(`<${listType}>`);
      }
      html.push(`<li>${traceInlineMarkdown((bullet || numbered)[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${traceInlineMarkdown(line)}</p>`);
  }
  if (inCode) html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  closeList();
  return html.join('');
}

function traceRoleLabel(item) {
  if (item.kind === 'user') return 'User';
  if (item.kind === 'assistant') return 'Assistant';
  if (item.kind === 'tool') return item.label || 'Tool';
  return item.label || 'Event';
}

function traceRoleGlyph(item) {
  if (item.kind === 'user') return '●';
  if (item.kind === 'assistant') return '◉';
  if (item.kind === 'tool') return '⚙';
  return '◆';
}

function traceToolGroupLabel(calls) {
  const count = calls.length;
  const names = Array.from(new Set(calls.map(({ block }) => block.name || 'tool')));
  const suffix = names.length === 1 ? ` (${names[0]})` : '';
  return `${count} tool call${count === 1 ? '' : 's'}${suffix}`;
}

function renderTraceToolDetails(block) {
  const input = formatTraceValue(block.input);
  const hasResult = !!block.result;
  const result = hasResult ? formatTraceValue(block.result.output) : 'Waiting for result…';
  const resultError = hasResult && !!block.result.error;
  const inputCopy = traceCopyToken(input);
  const resultCopy = traceCopyToken(result);
  return `<div class="trace-tool-body">
    <div class="trace-code-section">
      <div class="trace-code-head"><div class="trace-code-label">Input</div><button type="button" class="trace-copy-button" data-trace-copy="${escapeHtml(inputCopy)}" aria-label="Copy tool input" title="Copy tool input">⧉</button></div>
      <pre><code>${escapeHtml(input)}</code></pre>
    </div>
    <div class="trace-code-section">
      <div class="trace-code-head"><div class="trace-code-label">${resultError ? 'Error' : 'Result'}</div><button type="button" class="trace-copy-button" data-trace-copy="${escapeHtml(resultCopy)}" aria-label="Copy tool result" title="Copy tool result">⧉</button></div>
      <pre class="${resultError ? 'error' : ''}"><code>${escapeHtml(result)}</code></pre>
    </div>
  </div>`;
}

function renderTraceToolRow(item, block, blockIndex) {
  const key = `tool:${item.sourceLine}:${block.id || blockIndex}`;
  const open = traceDisclosureOpen(key);
  const hasResult = !!block.result;
  const resultError = (hasResult && !!block.result.error) || !!block.error;
  const status = hasResult ? (resultError ? '· error' : '· complete') : '· running';
  const inputPreview = traceCompactValue(block.input);
  const resultPreview = traceCompactValue(hasResult ? block.result.output : 'Waiting for result…', 220);
  const detailMarkup = open ? renderTraceToolDetails(block) : '';
  return `<div class="trace-tool-row">
    <button type="button" class="trace-disclosure trace-tool-summary" data-trace-disclosure="${escapeHtml(key)}" aria-expanded="${open}">
      <span class="trace-disclosure-caret">${open ? '▾' : '▸'}</span><span class="trace-tool-icon">↗</span><strong class="trace-tool-name">${escapeHtml(block.name || 'tool')}</strong>${inputPreview ? `<span class="trace-tool-input-preview">${escapeHtml(inputPreview)}</span>` : ''}<span class="trace-tool-status${resultError ? ' error' : ''}">${escapeHtml(status)}</span>
    </button>
    <div class="trace-tool-result-preview${resultError ? ' error' : ''}"><span class="trace-result-dot">●</span><span>${escapeHtml(resultPreview)}</span></div>
    ${detailMarkup}
  </div>`;
}

function renderTraceToolGroup(item, calls) {
  const firstBlock = calls[0] && calls[0].block;
  const key = `tools:${item.sourceLine}:${firstBlock && (firstBlock.id || calls[0].blockIndex)}`;
  const open = traceDisclosureOpen(key);
  return `<section class="trace-tool-group">
    <button type="button" class="trace-tool-group-header trace-disclosure" data-trace-disclosure="${escapeHtml(key)}" aria-expanded="${open}">
      <span class="trace-disclosure-caret">${open ? '▾' : '▸'}</span><strong>${escapeHtml(traceToolGroupLabel(calls))}</strong>
    </button>
    ${open ? `<div class="trace-tool-list">${calls.map(({ block, blockIndex }) => renderTraceToolRow(item, block, blockIndex)).join('')}</div>` : ''}
  </section>`;
}

function renderTraceBlocks(item) {
  const html = [];
  let toolCalls = [];
  const flushTools = () => {
    if (!toolCalls.length) return;
    html.push(renderTraceToolGroup(item, toolCalls));
    toolCalls = [];
  };
  item.blocks.forEach((block, blockIndex) => {
    if (block.kind === 'tool-call') {
      toolCalls.push({ block, blockIndex });
      return;
    }
    flushTools();
    html.push(renderTraceBlock(item, block, blockIndex));
  });
  flushTools();
  return html.join('');
}

function renderTraceBlock(item, block, blockIndex) {
  if (!block) return '';
  if (block.kind === 'text') {
    return `<div class="trace-text">${renderTraceMarkdown(block.text)}</div>`;
  }
  if (block.kind === 'image') {
    const label = block.mimeType ? `Image · ${escapeHtml(block.mimeType)}` : 'Image attachment';
    let preview = '';
    if (block.data && block.data.length <= 2 * 1024 * 1024) {
      const src = String(block.data).startsWith('data:')
        ? String(block.data)
        : `data:${block.mimeType || 'image/png'};base64,${block.data}`;
      preview = `<img class="trace-image" src="${escapeHtml(src)}" alt="Trace image attachment" />`;
    }
    return `<div class="trace-attachment"><span class="trace-attachment-icon">▧</span>${label}</div>${preview}`;
  }
  if (block.kind === 'thinking') {
    const key = `thinking:${item.sourceLine}:${blockIndex}`;
    const open = traceDisclosureOpen(key);
    const thinkingPreview = String(block.text || '').replace(/\s+/g, ' ').trim().slice(0, 150);
    return `<div class="trace-thinking-block">
      <button type="button" class="trace-disclosure trace-thinking-summary" data-trace-disclosure="${escapeHtml(key)}" aria-expanded="${open}">
        <span class="trace-thinking-badge">Thinking</span><span class="trace-thinking-preview">${escapeHtml(thinkingPreview)}${thinkingPreview.length >= 150 ? '…' : ''}</span><span class="trace-disclosure-caret">${open ? '▴' : '▾'}</span>
      </button>
      ${open ? `<div class="trace-thinking-body">${renderTraceMarkdown(block.text || '')}</div>` : ''}
    </div>`;
  }
  if (block.kind === 'tool-result') {
    const key = `result:${item.sourceLine}:${block.id || blockIndex}`;
    const open = traceDisclosureOpen(key);
    const output = formatTraceValue(block.output);
    const outputCopy = traceCopyToken(output);
    return `<div class="trace-tool-group trace-tool-group-standalone">
      <button type="button" class="trace-tool-group-header trace-disclosure" data-trace-disclosure="${escapeHtml(key)}" aria-expanded="${open}">
        <span class="trace-disclosure-caret">${open ? '▾' : '▸'}</span><strong>Tool result</strong>
      </button>
      ${open ? `<div class="trace-tool-body"><div class="trace-code-section"><div class="trace-code-head"><div class="trace-code-label">${block.error ? 'Error' : 'Result'}</div><button type="button" class="trace-copy-button" data-trace-copy="${escapeHtml(outputCopy)}" aria-label="Copy tool result" title="Copy tool result">⧉</button></div><pre class="${block.error ? 'error' : ''}"><code>${escapeHtml(output)}</code></pre></div></div>` : ''}
    </div>`;
  }
  return '';
}

function formatTraceTokens(value) {
  return value == null ? '' : Number(value).toLocaleString();
}

function renderTraceItem(item) {
  const idx = item.sourceLine == null ? '' : ` data-idx="${item.sourceLine}"`;
  const model = item.provider && item.model ? `${item.provider}/${item.model}` : (item.model || item.provider || '');
  const usage = item.usage && (item.usage.input != null || item.usage.output != null)
    ? `${formatTraceTokens(item.usage.input)}↓ ${formatTraceTokens(item.usage.output)}↑${item.usage.cacheRead ? ` (${formatTraceTokens(item.usage.cacheRead)} cached)` : ''}`
    : '';
  const blocks = renderTraceBlocks(item);
  const body = blocks || (item.kind === 'event' ? '<div class="trace-event-empty">No additional details</div>' : '<div class="trace-event-empty">No visible content</div>');
  const metadata = [];
  if (usage) metadata.push(`<span class="trace-usage">${escapeHtml(usage)}</span>`);
  if (item.metadata && item.metadata.durationMs != null) metadata.push(`<span class="trace-usage">${escapeHtml(String(item.metadata.durationMs))} ms</span>`);
  if (item.metadata && item.metadata.costUsd != null) metadata.push(`<span class="trace-usage">$${escapeHtml(Number(item.metadata.costUsd).toFixed(4))}</span>`);
  const identity = `<span class="trace-role-glyph">${traceRoleGlyph(item)}</span><strong>${escapeHtml(traceRoleLabel(item))}</strong>${model ? `<span class="trace-entry-model">${escapeHtml(model)}</span>` : ''}${item.timestamp ? `<time class="trace-entry-time">${escapeHtml(item.timestamp)}</time>` : ''}`;
  return `<article class="trace-entry trace-entry-${escapeHtml(item.kind)}"${idx}>
    <header class="trace-entry-header">
      <div class="trace-entry-identity">${identity}</div>
      <div class="trace-entry-meta">${metadata.join('')}</div>
    </header>
    <div class="trace-entry-body">${body}</div>
  </article>`;
}

function updateTraceControls() {
  if (!els.traceControls) return;
  els.traceControls.querySelectorAll('[data-trace-layout]').forEach((button) => {
    button.classList.toggle('active', button.dataset.traceLayout === state.traceLayout);
  });
  els.traceControls.querySelectorAll('[data-trace-expansion]').forEach((button) => {
    button.classList.toggle('active', button.dataset.traceExpansion === state.traceExpansion);
  });
}

function setTraceLayout(layout) {
  if (layout !== 'compact' && layout !== 'wide') return;
  state.traceLayout = layout;
  render();
}

function setTraceExpansion(expansion) {
  if (expansion !== 'collapsed' && expansion !== 'expanded') return;
  state.traceExpansion = expansion;
  state.traceOpen = new Set();
  state.traceClosed = new Set();
  render();
}

function renderTrace(trace) {
  traceCopyValues.clear();
  updateTraceControls();
  const items = filteredTraceItems(trace);
  const tools = trace.stats ? trace.stats.toolCalls : 0;
  const headerMeta = [];
  if (trace.cwd) headerMeta.push(`<span title="Working directory">⌂ ${escapeHtml(trace.cwd)}</span>`);
  if (trace.id) headerMeta.push(`<span title="Session id">ID ${escapeHtml(trace.id)}</span>`);
  headerMeta.push(`<span>${items.length} items</span>`);
  if (tools) headerMeta.push(`<span>${tools} tool call${tools === 1 ? '' : 's'}</span>`);
  const cards = items.map(renderTraceItem).join('');
  els.viewPane.innerHTML = `<div class="trace-view trace-${escapeHtml(state.traceLayout)}">
    <div class="trace-header-card">
      <div class="trace-header-title"><span class="trace-agent-glyph">◉</span><strong>${escapeHtml(trace.title || `${trace.label} trace`)}</strong><span class="trace-format-badge">${escapeHtml(trace.label || trace.format)}</span></div>
      <div class="trace-header-meta">${headerMeta.join(' · ')}</div>
    </div>
    <div class="trace-timeline">${cards || '<div class="trace-no-results">No trace items match the current filter.</div>'}</div>
  </div>`;

  els.viewPane.querySelectorAll('.trace-disclosure').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const scrollTop = els.viewPane.scrollTop;
      toggleTraceDisclosure(button.dataset.traceDisclosure);
      render();
      els.viewPane.scrollTop = scrollTop;
    });
  });
  els.viewPane.querySelectorAll('.trace-copy-button').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const value = traceCopyValues.get(button.dataset.traceCopy);
      if (value == null) return;
      copyText(value);
      const original = button.textContent;
      button.textContent = '✓';
      setTimeout(() => { button.textContent = original; }, 900);
    });
  });
  els.viewPane.querySelectorAll('.trace-entry[data-idx]').forEach((entry) => {
    entry.addEventListener('click', () => selectRow(Number(entry.dataset.idx)));
  });
  traceNavUpdate();
}

// ---- Trace message navigation ----
// Up/down buttons (and [ / ] keys) jump between user and assistant messages
// in the trace timeline; tool calls and events are skipped. The position
// indicator tracks the last message whose top has scrolled past the top of
// the viewport, so the buttons always move relative to what you're looking at.
function traceNavMessageEls() {
  return Array.from(els.viewPane.querySelectorAll('.trace-entry-user, .trace-entry-assistant'));
}

// While a button-driven jump is in flight (or when the pane can't scroll
// further, e.g. the trace fits on one screen) the stored index is kept
// instead of being re-derived from the scroll position.
let traceNavJumpLock = 0;
let traceNavJumpStart = 0;
let traceNavJumpTarget = 0;
let traceNavLastScrollTop = null;
let traceNavJumpLockTimer = 0;

function traceNavUpdate() {
  if (!els.traceNav) return;
  if (state.view !== 'trace' || !state.trace) {
    els.traceNav.hidden = true;
    traceNavLastScrollTop = null;
    return;
  }
  const messages = traceNavMessageEls();
  if (!messages.length) {
    els.traceNav.hidden = true;
    traceNavLastScrollTop = null;
    return;
  }
  els.traceNav.hidden = false;
  const scrollTop = els.viewPane.scrollTop;
  const scrolled = traceNavLastScrollTop !== scrollTop;
  traceNavLastScrollTop = scrollTop;
  if (Date.now() > traceNavJumpLock && scrolled) {
    // Scroll position changed outside of a jump: track the last message
    // whose top has passed the top of the viewport.
    const anchor = els.viewPane.getBoundingClientRect().top + 40;
    let idx = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].getBoundingClientRect().top <= anchor) idx = i;
      else break;
    }
    // At the very bottom of an overflowing trace the last message is what
    // you're reading, even though its top sits below the anchor line. A few
    // pixels of slack absorb settle wobble from in-flight smooth scrolls.
    if (scrollTop + els.viewPane.clientHeight >= els.viewPane.scrollHeight - 8 &&
        els.viewPane.scrollHeight > els.viewPane.clientHeight + 2) {
      idx = messages.length - 1;
    }
    state.traceNavCurrent = idx;
  } else if (state.traceNavCurrent < 0) {
    state.traceNavCurrent = 0;
  } else if (state.traceNavCurrent > messages.length - 1) {
    state.traceNavCurrent = messages.length - 1;
  }
  const idx = state.traceNavCurrent;
  els.traceNavPos.textContent = (idx + 1) + ' / ' + messages.length;
  els.traceNavUp.disabled = idx <= 0;
  els.traceNavDown.disabled = idx >= messages.length - 1;
  const role = messages[idx].classList.contains('trace-entry-user') ? 'User' : 'Assistant';
  const textEl = messages[idx].querySelector('.trace-text');
  let label = textEl ? textEl.textContent.replace(/\s+/g, ' ').trim() : '';
  if (!label) label = role;
  if (label.length > 60) label = label.slice(0, 59) + '…';
  els.traceNavUp.title = idx <= 0 ? 'No previous message' : 'Previous message ( [ ) · ' + role + ': ' + label;
  els.traceNavDown.title = idx >= messages.length - 1 ? 'No next message' : 'Next message ( ] ) · ' + role + ': ' + label;
}

function traceNavStep(direction) {
  if (state.view !== 'trace' || !state.trace) return;
  const messages = traceNavMessageEls();
  if (!messages.length) return;
  let idx = state.traceNavCurrent;
  if (!Number.isFinite(idx) || idx < 0) idx = 0;
  if (idx > messages.length - 1) idx = messages.length - 1;
  idx = direction > 0 ? Math.min(messages.length - 1, idx + 1) : Math.max(0, idx - 1);
  const target = messages[idx];
  const pane = els.viewPane;
  const targetScroll = Math.max(0, target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 8);
  pane.scrollTo({ top: targetScroll, behavior: 'smooth' });
  state.traceNavCurrent = idx;
  traceNavJumpLock = Date.now() + 800;
  traceNavJumpStart = pane.scrollTop;
  traceNavJumpTarget = targetScroll;
  // When the lock expires without further scrolling (the jump settled, or
  // the pane could not scroll far enough, e.g. the trace fits on one
  // screen) anchor tracking to the current position so the jumped-to index
  // is kept until the user scrolls again.
  clearTimeout(traceNavJumpLockTimer);
  traceNavJumpLockTimer = setTimeout(() => {
    traceNavJumpLock = 0;
    traceNavLastScrollTop = els.viewPane.scrollTop;
  }, 800);
  target.classList.remove('trace-nav-flash');
  void target.offsetWidth; // restart the flash animation on rapid presses
  target.classList.add('trace-nav-flash');
  clearTimeout(target._traceNavFlashT);
  target._traceNavFlashT = setTimeout(() => target.classList.remove('trace-nav-flash'), 1100);
  traceNavUpdate();
}

// ---- Tree view ----
function containerSummary(value) {
  if (Array.isArray(value)) {
    return `<span class="punc">[</span><span class="tree-count">${value.length}</span><span class="punc">]</span>`;
  }
  const n = Object.keys(value).length;
  return `<span class="punc">{</span><span class="tree-count">${n}</span><span class="punc">}</span>`;
}

function treeChild(key, value, path, isArray) {
  const isContainer = value && typeof value === 'object';
  const keyLabel = isArray
    ? `<span class="tree-key idx">${escapeHtml(key)}</span><span class="punc">: </span>`
    : `<span class="tree-key">${escapeHtml(JSON.stringify(key))}</span><span class="punc">: </span>`;
  if (isContainer) {
    const open = state.treeExpanded.has(path);
    const caret = `<button class="tree-caret" data-path="${escapeHtml(path)}">${open ? '▾' : '▸'}</button>`;
    const head = `<div class="tree-node">${caret}${keyLabel}<span class="tree-summary">${containerSummary(value)}</span></div>`;
    if (!open) return head;
    return head + `<div class="tree-children">${treeNode(value, path)}</div>`;
  }
  return `<div class="tree-node tree-leaf-row"><span class="tree-caret-placeholder"></span>${keyLabel}<span class="tree-leaf">${highlightValue(value)}</span></div>`;
}

function treeNode(value, path) {
  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="punc">[]</span>';
    return value.map((v, i) => treeChild(`[${i}]`, v, `${path}>${i}`, true)).join('');
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '<span class="punc">{}</span>';
    return keys.map((k) => treeChild(k, value[k], `${path}>${k}`, false)).join('');
  }
  return `<span class="tree-leaf">${highlightValue(value)}</span>`;
}

function renderTree(lines) {
  const items = lines.map((l) => {
    const lineKey = String(l.index);
    const selected = state.selectedIndex === l.index ? ' selected' : '';
    if (l.parseError) {
      return `<div class="tree-node tree-line error${selected}" data-idx="${l.index}">
        <span class="ln">${l.index + 1}</span>
        <span class="tree-caret-placeholder"></span>
        <span class="err-badge">⚠ ${escapeHtml(l.parseError)}</span>
        <div class="preview">${escapeHtml(l.raw)}</div>
      </div>`;
    }
    const open = state.treeExpanded.has(lineKey);
    const caret = `<button class="tree-caret" data-path="${escapeHtml(lineKey)}">${open ? '▾' : '▸'}</button>`;
    const head = `<div class="tree-node tree-line${selected}" data-idx="${l.index}">
      <span class="ln">${l.index + 1}</span>
      ${caret}
      <span class="tree-preview">${escapeHtml(shortPreview(l.value))}</span>
    </div>`;
    if (!open) return head;
    const openBrace = Array.isArray(l.value) ? '[' : '{';
    const closeBrace = Array.isArray(l.value) ? ']' : '}';
    return head + `<div class="tree-line-children-wrap" data-idx="${l.index}">
      <div class="tree-brace">${openBrace}</div>
      <div class="tree-children">${treeNode(l.value, lineKey)}</div>
      <div class="tree-brace">${closeBrace}</div>
    </div>`;
  }).join('');

  els.viewPane.innerHTML = `<div class="tree-view">${items}</div>`;

  els.viewPane.querySelectorAll('.tree-caret').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = btn.dataset.path;
      if (state.treeExpanded.has(p)) state.treeExpanded.delete(p);
      else state.treeExpanded.add(p);
      render();
    });
  });

  els.viewPane.querySelectorAll('.tree-line[data-idx]').forEach((line) => {
    line.addEventListener('click', (e) => {
      const idx = Number(line.dataset.idx);
      selectRow(idx);
      // Toggle the top-level expansion when clicking the row body
      // (caret clicks are handled above and stop propagation).
      if (!e.target.closest('.tree-caret')) {
        const key = String(idx);
        if (state.treeExpanded.has(key)) state.treeExpanded.delete(key);
        else state.treeExpanded.add(key);
        render();
      }
    });
  });
}

function setFileInfo(text) {
  els.fileInfo.textContent = text;
}

// ---- Actions ----
function applyLoadedData(data, { preserveView = false } = {}) {
  const prevSelected = state.selectedIndex;
  const prevExpanded = state.expanded;
  const prevTreeExpanded = state.treeExpanded;
  const detectedTrace = window.traceParser && window.traceParser.parse
    ? window.traceParser.parse(data.parsedLines, data.path)
    : null;

  state.filePath = data.path;
  state.fileName = data.name;
  state.totalLines = data.totalLines;
  state.sizeBytes = data.sizeBytes;
  state.parsedLines = data.parsedLines;
  state.errors = data.errors;
  state.truncated = data.truncated;
  state.trace = detectedTrace;

  if (!preserveView) {
    state.expanded = new Set();
    state.treeExpanded = new Set();
    state.selectedIndex = null;
    state.filter = '';
    els.search.value = '';
    els.sidebar.hidden = true;
    state.traceOpen = new Set();
    state.traceClosed = new Set();
    if (state.trace) {
      state.view = 'trace';
      state.editMode = false;
      document.body.classList.remove('edit-mode');
      els.editToggle.textContent = 'Edit: off';
      els.editToggle.classList.remove('active');
    } else if (state.view === 'trace') {
      state.view = 'table';
    }
  } else {
    const validIndexes = new Set(data.parsedLines.map((l) => l.index));
    if (prevSelected != null && !validIndexes.has(prevSelected)) {
      state.selectedIndex = null;
    }
    state.expanded = new Set([...prevExpanded].filter((i) => validIndexes.has(i)));
    state.treeExpanded = new Set([...prevTreeExpanded].filter((p) => {
      const root = Number(String(p).split('>')[0]);
      return validIndexes.has(root);
    }));
    if (!state.trace && state.view === 'trace') state.view = 'table';
  }

  recomputeAllKeys();
  setFileInfo(`${data.name} · ${formatBytes(data.sizeBytes)} · ${data.totalLines} lines`);
  addRecent(data.path);
  ensureOpenFile(data.path, data.name);
  explorer.activePath = data.path;
  markDirty(false);
  render();
  renderExplorer();
}

function saveCurrentSession() {
  if (!state.filePath) return;
  const key = sessionKey(state.filePath);
  explorer.sessions[key] = {
    filePath: state.filePath,
    fileName: state.fileName,
    totalLines: state.totalLines,
    sizeBytes: state.sizeBytes,
    parsedLines: state.parsedLines,
    errors: state.errors,
    truncated: state.truncated,
    trace: state.trace,
    view: state.view,
    traceLayout: state.traceLayout,
    traceExpansion: state.traceExpansion,
    traceOpen: new Set(state.traceOpen),
    traceClosed: new Set(state.traceClosed),
    filter: state.filter,
    expanded: new Set(state.expanded),
    treeExpanded: new Set(state.treeExpanded),
    selectedIndex: state.selectedIndex,
    editMode: state.editMode,
    showSidebarRaw: state.showSidebarRaw,
    allKeys: state.allKeys.slice(),
    scrollTop: els.viewPane.scrollTop,
    scrollLeft: els.viewPane.scrollLeft
  };
}

function restoreSession(sess) {
  state.filePath = sess.filePath;
  state.fileName = sess.fileName;
  state.totalLines = sess.totalLines;
  state.sizeBytes = sess.sizeBytes;
  state.parsedLines = sess.parsedLines;
  state.errors = sess.errors;
  state.truncated = sess.truncated;
  state.trace = sess.trace || (window.traceParser && window.traceParser.parse
    ? window.traceParser.parse(sess.parsedLines, sess.filePath)
    : null);
  state.view = sess.view === 'trace' && !state.trace ? 'table' : sess.view;
  state.traceLayout = sess.traceLayout || 'compact';
  state.traceExpansion = sess.traceExpansion || 'expanded';
  state.traceOpen = new Set(sess.traceOpen || []);
  state.traceClosed = new Set(sess.traceClosed || []);
  state.filter = sess.filter;
  state.expanded = new Set(sess.expanded);
  state.treeExpanded = new Set(sess.treeExpanded);
  state.selectedIndex = sess.selectedIndex;
  state.showSidebarRaw = sess.showSidebarRaw;
  state.allKeys = sess.allKeys.slice();
  state.editMode = !!sess.editMode;
  document.body.classList.toggle('edit-mode', state.editMode);
  els.editToggle.textContent = 'Edit: ' + (state.editMode ? 'on' : 'off');
  els.editToggle.classList.toggle('active', state.editMode);
  els.search.value = sess.filter || '';
  const radio = document.querySelector(`input[name="view"][value="${state.view}"]`);
  if (radio) radio.checked = true;
  explorer.activePath = sess.filePath;
  setFileInfo(`${sess.fileName} · ${formatBytes(sess.sizeBytes)} · ${sess.totalLines} lines`);
  render();
  els.viewPane.scrollTop = sess.scrollTop || 0;
  els.viewPane.scrollLeft = sess.scrollLeft || 0;
}

function ensureOpenFile(filePath, name) {
  if (!filePath) return;
  const existing = findOpen(filePath);
  if (existing) return existing;
  const entry = { path: filePath, name: name || fileName(filePath), dirty: false };
  explorer.openFiles.push(entry);
  return entry;
}

function clearActiveFile() {
  state.filePath = null;
  state.fileName = null;
  state.totalLines = 0;
  state.sizeBytes = 0;
  state.parsedLines = [];
  state.errors = [];
  state.truncated = false;
  state.trace = null;
  state.expanded = new Set();
  state.treeExpanded = new Set();
  state.selectedIndex = null;
  state.filter = '';
  state.editMode = false;
  explorer.activePath = null;
  document.body.classList.remove('edit-mode');
  els.editToggle.textContent = 'Edit: off';
  els.editToggle.classList.remove('active');
  if (els.search) els.search.value = '';
  if (window.api.watchFile) window.api.watchFile(null);
  setFileInfo('No file loaded');
  render();
}

function joinPath(dir, name) {
  if (!dir) return name;
  const sep = /\\/.test(dir) && !dir.includes('/') ? '\\' : '/';
  if (/[\\/]$/.test(dir)) return dir + name;
  return dir + sep + name;
}

async function revealInExplorer(filePath) {
  if (!explorer.folder || !filePath) return;
  const folderN = explorer.folder.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const fileN = filePath.replace(/\\/g, '/').toLowerCase();
  if (fileN !== folderN && !fileN.startsWith(folderN + '/')) return;
  const rel = filePath.replace(/\\/g, '/').slice(explorer.folder.replace(/\\/g, '/').length).replace(/^\//, '');
  const parts = rel.split('/').filter(Boolean);
  parts.pop();
  let acc = explorer.folder;
  for (const part of parts) {
    acc = joinPath(acc, part);
    explorer.expanded.add(acc);
    if (!explorer.children[acc]) {
      try { await loadDir(acc); } catch (e) {}
    }
  }
}

async function loadFileFromDisk(filePath) {
  setFileInfo('Loading…');
  const data = await window.api.readFile(filePath, state.maxLines);
  applyLoadedData(data, { preserveView: false });
  if (explorer.folder) {
    await revealInExplorer(data.path);
  }
  renderExplorer();
  return data;
}

async function openFile(filePath) {
  if (!filePath) {
    filePath = await window.api.openFile();
    if (!filePath) return;
  }
  if (state.filePath && samePath(state.filePath, filePath)) {
    renderExplorer();
    return;
  }
  saveCurrentSession();
  const existing = findOpen(filePath);
  const cached = existing && explorer.sessions[existing.path];
  if (cached) {
    restoreSession(cached);
    if (window.api.watchFile) window.api.watchFile(existing.path);
    renderExplorer();
    if (!existing.dirty) {
      try { await reloadFile({ ignoreEdit: true }); } catch (e) {}
    }
    return;
  }
  try {
    const data = await loadFileFromDisk(filePath);
    console.log(`[jsonl-viewer] loaded ${data.name}: ${data.parsedLines.length} parsed, ${data.errors.length} errors, ${data.totalLines} total`);
  } catch (err) {
    setFileInfo('Error: ' + err.message);
  }
}

async function closeFile(filePath) {
  const entry = findOpen(filePath);
  if (!entry) return;
  if (entry.dirty && !window.confirm('Discard unsaved changes to ' + entry.name + '?')) return;
  explorer.openFiles = explorer.openFiles.filter((f) => !samePath(f.path, filePath));
  delete explorer.sessions[entry.path];
  if (state.filePath && samePath(state.filePath, filePath)) {
    state.filePath = null;
    const next = explorer.openFiles[explorer.openFiles.length - 1];
    if (next) await openFile(next.path);
    else clearActiveFile();
  }
  renderExplorer();
}

let reloadInFlight = false;
let reloadQueued = false;
let pendingExternalChange = false;
let editModeReloadWarned = false;

async function reloadFile({ ignoreEdit = false } = {}) {
  if (!state.filePath) return;
  if (state.editMode && !ignoreEdit) {
    pendingExternalChange = true;
    if (!editModeReloadWarned) {
      editModeReloadWarned = true;
      showToast('File changed on disk — turn Edit off to reload');
    }
    return;
  }
  if (reloadInFlight) {
    reloadQueued = true;
    return;
  }
  reloadInFlight = true;
  pendingExternalChange = false;
  const scrollTop = els.viewPane.scrollTop;
  const scrollLeft = els.viewPane.scrollLeft;
  try {
    const maxLines = Math.max(state.maxLines, state.parsedLines.length);
    const data = await window.api.readFile(state.filePath, maxLines);
    applyLoadedData(data, { preserveView: true });
    els.viewPane.scrollTop = scrollTop;
    els.viewPane.scrollLeft = scrollLeft;
    console.log(`[jsonl-viewer] reloaded ${data.name}: ${data.parsedLines.length} parsed, ${data.errors.length} errors, ${data.totalLines} total`);
  } catch (err) {
    showToast('Reload failed: ' + (err && err.message ? err.message : 'error'), { kind: 'error' });
  } finally {
    reloadInFlight = false;
    if (reloadQueued) {
      reloadQueued = false;
      reloadFile();
    }
  }
}

async function loadMore() {
  if (!state.filePath) return;
  const start = state.parsedLines.length;
  const count = 5000;
  const data = await window.api.readRange(state.filePath, start, count);
  state.parsedLines.push(...data.lines);
  recomputeTrace();
  recomputeAllKeys();
  // recompute truncated flag: if we got fewer than requested and we've reached end, not truncated
  if (data.lines.length < count) state.truncated = false;
  render();
}

function setEditMode(on) {
  state.editMode = on;
  document.body.classList.toggle('edit-mode', on);
  els.editToggle.textContent = 'Edit: ' + (on ? 'on' : 'off');
  els.editToggle.classList.toggle('active', on);
  els.editToggle.title = on ? 'Editing enabled — click cells (Table) or textareas (Raw) to edit' : 'Toggle cell editing';
  els.saveBtn.classList.toggle('hidden-slot', !on || !state.filePath);
  render();
  if (!on) {
    editModeReloadWarned = false;
    if (pendingExternalChange) reloadFile();
  }
}

async function saveFile() {
  if (!state.parsedLines.length) return;
  if (!state.filePath) {
    showToast('Nothing to save', { kind: 'error' });
    return;
  }
  const contents = state.parsedLines.map((l) => l.raw).join('\n') + '\n';
  try {
    await window.api.writeFile(state.filePath, contents);
    markDirty(false);
    showToast('Saved · ' + state.fileName);
  } catch (err) {
    showToast('Save failed: ' + (err && err.message ? err.message : 'error'), { kind: 'error' });
  }
}

async function saveAsFile() {
  if (!state.parsedLines.length) return;
  const contents = state.parsedLines.map((l) => l.raw).join('\n') + '\n';
  const defaultName = (state.fileName || 'output').replace(/\.(jsonl|ndjson|json|log|txt)$/i, '') + '.edited.jsonl';
  let outPath;
  try {
    outPath = await window.api.saveFile(defaultName);
  } catch (err) {
    showToast('Save As failed: ' + (err && err.message ? err.message : 'error'), { kind: 'error' });
    return;
  }
  if (!outPath) return; // cancelled
  try {
    await window.api.writeFile(outPath, contents);
    const savedName = outPath.split(/[\\/]/).pop();
    showToast('Saved · ' + savedName);
  } catch (err) {
    showToast('Save As failed: ' + (err && err.message ? err.message : 'error'), { kind: 'error' });
  }
}

function showToast(message, opts = {}) {
  let toast = $('#toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.toggle('error', opts.kind === 'error');
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), 1800);
}

// ---- Tree expand/collapse all ----
function collectTreePaths(value, prefix, out) {
  if (!value || typeof value !== 'object') return;
  out.push(prefix);
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectTreePaths(v, `${prefix}>${i}`, out));
  } else {
    for (const k of Object.keys(value)) collectTreePaths(value[k], `${prefix}>${k}`, out);
  }
}

function expandAllTree() {
  const out = [];
  for (const l of state.parsedLines) {
    if (l.parseError) continue;
    collectTreePaths(l.value, String(l.index), out);
  }
  state.treeExpanded = new Set(out);
  render();
}

function collapseAllTree() {
  state.treeExpanded = new Set();
  render();
}

// ---- File explorer ----
function persistExplorerPrefs() {
  try {
    localStorage.setItem('jsonl-viewer:explorer', explorer.visible ? '1' : '0');
    localStorage.setItem('jsonl-viewer:explorerWidth', String(explorer.width));
    if (explorer.folder) localStorage.setItem('jsonl-viewer:folder', explorer.folder);
    else localStorage.removeItem('jsonl-viewer:folder');
  } catch (e) {}
}

function applyExplorerWidth() {
  if (!els.explorer) return;
  els.explorer.style.flexBasis = explorer.width + 'px';
  els.explorer.style.width = explorer.width + 'px';
}

function setExplorerVisible(on, { persist = true } = {}) {
  explorer.visible = !!on;
  if (els.workspace) els.workspace.classList.toggle('explorer-hidden', !explorer.visible);
  if (persist) persistExplorerPrefs();
}

function toggleExplorer() {
  setExplorerVisible(!explorer.visible);
}

async function loadDir(dirPath) {
  if (!window.api.listDir) return [];
  const data = await window.api.listDir(dirPath);
  explorer.children[dirPath] = data.entries || [];
  return data;
}

async function openExplorerFolder(dirPath, { persist = true } = {}) {
  if (!dirPath) {
    if (!window.api.openFolder) return;
    dirPath = await window.api.openFolder();
    if (!dirPath) return;
  }
  explorer.folder = dirPath;
  explorer.folderName = fileName(dirPath) || dirPath;
  explorer.autoFolderDisabled = false;
  explorer.expanded = new Set([dirPath]);
  explorer.children = {};
  try {
    await loadDir(dirPath);
  } catch (e) {}
  if (persist) persistExplorerPrefs();
  if (!explorer.visible) setExplorerVisible(true);
  renderExplorer();
}

async function refreshExplorerFolder() {
  if (!explorer.folder) return;
  const keep = new Set(explorer.expanded);
  explorer.children = {};
  await loadDir(explorer.folder);
  for (const dir of keep) {
    if (dir !== explorer.folder) {
      try { await loadDir(dir); } catch (e) {}
    }
  }
  explorer.expanded = keep;
  renderExplorer();
}

// Closes the folder tree only. Files opened from it stay loaded in the
// editor and in the "Open files" list.
function closeExplorerFolder() {
  if (!explorer.folder) return;
  explorer.folder = null;
  explorer.folderName = '';
  explorer.children = {};
  explorer.expanded = new Set();
  explorer.autoFolderDisabled = true;
  persistExplorerPrefs();
  renderExplorer();
}

async function toggleExplorerDir(dirPath) {
  if (explorer.expanded.has(dirPath)) {
    explorer.expanded.delete(dirPath);
  } else {
    explorer.expanded.add(dirPath);
    if (!explorer.children[dirPath]) {
      try { await loadDir(dirPath); } catch (e) {}
    }
  }
  renderExplorer();
}

function renderExplorer() {
  if (!els.explorerTree) return;
  if (els.explorerFolderLabel) {
    els.explorerFolderLabel.textContent = explorer.folder ? explorer.folderName : 'No folder';
    els.explorerFolderLabel.title = explorer.folder || '';
  }
  if (els.explorerRefresh) els.explorerRefresh.hidden = !explorer.folder;
  if (els.explorerCloseFolder) els.explorerCloseFolder.hidden = !explorer.folder;

  if (els.explorerOpenSection && els.explorerOpenList) {
    els.explorerOpenSection.hidden = explorer.openFiles.length === 0;
    els.explorerOpenList.innerHTML = '';
    for (const f of explorer.openFiles) {
      const row = document.createElement('div');
      row.className = 'ex-row ex-file' + (samePath(f.path, explorer.activePath) ? ' active' : '');
      row.dataset.path = f.path;
      row.title = f.path;
      const ph = document.createElement('span');
      ph.className = 'ex-caret-ph';
      row.appendChild(ph);
      const name = document.createElement('span');
      name.className = 'ex-name';
      name.textContent = f.name;
      row.appendChild(name);
      if (f.dirty) {
        const dot = document.createElement('span');
        dot.className = 'ex-dirty';
        dot.title = 'Unsaved changes';
        row.appendChild(dot);
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'ex-close';
      close.title = 'Close';
      close.textContent = '×';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeFile(f.path);
      });
      row.appendChild(close);
      row.addEventListener('click', () => openFile(f.path));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showExplorerFileMenu(e.clientX, e.clientY, f.path, f.name, true);
      });
      els.explorerOpenList.appendChild(row);
    }
  }

  els.explorerTree.innerHTML = '';
  if (!explorer.folder) {
    const empty = document.createElement('div');
    empty.className = 'explorer-empty';
    empty.textContent = 'No folder open. Choose Open Folder above to browse .jsonl and .ndjson files.';
    els.explorerTree.appendChild(empty);
    return;
  }

  const roots = explorer.children[explorer.folder];
  if (!roots) return;
  if (roots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'explorer-empty';
    empty.textContent = 'No matching files in this folder.';
    els.explorerTree.appendChild(empty);
    return;
  }
  for (const entry of roots) appendExplorerNode(els.explorerTree, entry, 0);
}

function appendExplorerNode(parent, entry, depth) {
  const row = document.createElement('div');
  const isDir = entry.kind === 'dir';
  const active = !isDir && samePath(entry.path, explorer.activePath);
  const opened = !isDir && !!findOpen(entry.path);
  row.className = 'ex-row ' + (isDir ? 'ex-dir' : 'ex-file') + (active ? ' active' : '') + (opened && !active ? ' opened' : '');
  row.style.paddingLeft = (8 + depth * 14) + 'px';
  row.dataset.path = entry.path;
  row.dataset.kind = entry.kind;
  row.title = entry.path;

  const caret = document.createElement('span');
  if (isDir) {
    caret.className = 'ex-caret';
    caret.textContent = explorer.expanded.has(entry.path) ? '▾' : '▸';
  } else {
    caret.className = 'ex-caret-ph';
  }
  row.appendChild(caret);

  const name = document.createElement('span');
  name.className = 'ex-name';
  name.textContent = entry.name;
  row.appendChild(name);

  if (isDir) {
    row.addEventListener('click', () => toggleExplorerDir(entry.path));
  } else {
    row.addEventListener('click', () => openFile(entry.path));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showExplorerFileMenu(e.clientX, e.clientY, entry.path, entry.name, !!findOpen(entry.path));
    });
  }
  parent.appendChild(row);

  if (isDir && explorer.expanded.has(entry.path)) {
    const kids = explorer.children[entry.path] || [];
    for (const child of kids) appendExplorerNode(parent, child, depth + 1);
  }
}

function showExplorerFileMenu(x, y, filePath, name, isOpen) {
  const items = [
    { label: 'Open', onClick: () => openFile(filePath) }
  ];
  if (isOpen) items.push({ label: 'Close', onClick: () => closeFile(filePath) });
  if (window.api.showItemInFolder) {
    const isMac = /Mac/i.test(navigator.platform || navigator.userAgent || '');
    items.push({
      label: isMac ? 'Reveal in Finder' : 'Reveal in File Explorer',
      onClick: () => window.api.showItemInFolder(filePath)
    });
  }
  showCtx(x, y, items);
}

function setupExplorerResizer() {
  if (!els.explorerResizer) return;
  els.explorerResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = explorer.width;
    document.body.classList.add('explorer-resizing');
    const onMove = (ev) => {
      explorer.width = Math.max(160, Math.min(560, Math.round(startW + (ev.clientX - startX))));
      applyExplorerWidth();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('explorer-resizing');
      persistExplorerPrefs();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

(function initExplorer() {
  try {
    const v = localStorage.getItem('jsonl-viewer:explorer');
    if (v === '0') explorer.visible = false;
    const w = Number(localStorage.getItem('jsonl-viewer:explorerWidth'));
    if (w >= 160 && w <= 560) explorer.width = w;
    const folder = localStorage.getItem('jsonl-viewer:folder');
    if (folder) {
      explorer.folder = folder;
      explorer.folderName = fileName(folder);
    }
  } catch (e) {}
  applyExplorerWidth();
  setExplorerVisible(explorer.visible, { persist: false });
  if (els.explorerShow) els.explorerShow.addEventListener('click', () => setExplorerVisible(true));
  if (els.explorerHide) els.explorerHide.addEventListener('click', () => setExplorerVisible(false));
  if (els.explorerOpenFile) els.explorerOpenFile.addEventListener('click', () => openFile(null));
  if (els.explorerOpenFolder) els.explorerOpenFolder.addEventListener('click', () => openExplorerFolder(null));
  if (els.explorerOpenTraces) els.explorerOpenTraces.addEventListener('click', (event) => {
    event.stopPropagation();
    openTraceSourcesMenu();
  });
  if (els.explorerRefresh) els.explorerRefresh.addEventListener('click', refreshExplorerFolder);
  if (els.explorerCloseFolder) els.explorerCloseFolder.addEventListener('click', closeExplorerFolder);
  if (els.emptyOpenFile) els.emptyOpenFile.addEventListener('click', () => openFile(null));
  if (els.emptyTraceSources) els.emptyTraceSources.addEventListener('click', (event) => {
    event.stopPropagation();
    openTraceSourcesMenu();
  });
  if (els.emptyOpenFolder) els.emptyOpenFolder.addEventListener('click', () => openExplorerFolder(null));
  setupExplorerResizer();
  renderExplorer();
  if (explorer.folder) {
    loadDir(explorer.folder).then(() => renderExplorer()).catch(() => {});
  }
})();

// ---- Events ----
els.loadMoreBtn.addEventListener('click', loadMore);
els.themeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleThemeMenu();
});
if (els.zoomOutBtn) els.zoomOutBtn.addEventListener('click', () => changeZoom(-1));
if (els.zoomResetBtn) els.zoomResetBtn.addEventListener('click', () => setZoom(1));
if (els.zoomInBtn) els.zoomInBtn.addEventListener('click', () => changeZoom(1));
els.editToggle.addEventListener('click', () => setEditMode(!state.editMode));
els.saveBtn.addEventListener('click', saveFile);
els.treeExpandAll.addEventListener('click', expandAllTree);
els.treeCollapseAll.addEventListener('click', collapseAllTree);
els.traceControls.querySelectorAll('[data-trace-layout]').forEach((button) => {
  button.addEventListener('click', () => setTraceLayout(button.dataset.traceLayout));
});
els.traceControls.querySelectorAll('[data-trace-expansion]').forEach((button) => {
  button.addEventListener('click', () => setTraceExpansion(button.dataset.traceExpansion));
});

// Trace message navigation: buttons, scroll tracking, and [ / ] shortcuts.
els.traceNavUp.addEventListener('click', () => traceNavStep(-1));
els.traceNavDown.addEventListener('click', () => traceNavStep(1));
let traceNavScrollRaf = 0;
els.viewPane.addEventListener('scroll', () => {
  if (state.view !== 'trace' || !state.trace || traceNavScrollRaf) return;
  traceNavScrollRaf = requestAnimationFrame(() => {
    traceNavScrollRaf = 0;
    if (Date.now() <= traceNavJumpLock) {
      const st = els.viewPane.scrollTop;
      if (Math.abs(st - traceNavJumpTarget) <= 4) {
        // Jump settled: keep the jumped-to index and resume tracking from
        // the current position.
        traceNavJumpLock = 0;
        traceNavLastScrollTop = st;
        return;
      }
      // The user takes over only when scrolling against the jump direction.
      const scrolledAway = traceNavJumpTarget >= traceNavJumpStart
        ? st < traceNavJumpStart - 80
        : st > traceNavJumpStart + 80;
      if (scrolledAway) traceNavJumpLock = 0;
      else return; // animation still in flight
    }
    traceNavUpdate();
  });
}, { passive: true });
document.addEventListener('keydown', (e) => {
  if (state.view !== 'trace' || !state.trace) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.key === ']') { e.preventDefault(); traceNavStep(1); }
  else if (e.key === '[') { e.preventDefault(); traceNavStep(-1); }
});

// Close the theme menu when clicking outside it or pressing Escape
document.addEventListener('click', (e) => {
  if (els.themeMenu.hidden) return;
  if (!els.themeMenu.contains(e.target) && e.target !== els.themeBtn && !els.themeBtn.contains(e.target)) {
    closeThemeMenu();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.themeMenu.hidden) closeThemeMenu();
});

// Close the trace source menu when clicking outside it or pressing Escape.
document.addEventListener('click', (e) => {
  if (!els.traceSourcesMenu || els.traceSourcesMenu.hidden) return;
  if (!els.traceSourcesMenu.contains(e.target)) closeTraceSourcesMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && els.traceSourcesMenu && !els.traceSourcesMenu.hidden) closeTraceSourcesMenu();
});

// ---- Column visibility popover ----
function renderColPopover() {
  const keys = state.allKeys;
  const items = keys.map((k) => {
    const checked = state.columnVisibility[k] !== false ? 'checked' : '';
    return `<label><input type="checkbox" data-col="${escapeHtml(k)}" ${checked} /><span class="col-name">${escapeHtml(k)}</span></label>`;
  }).join('');
  els.colPopover.innerHTML = `<div class="col-actions">
      <button id="colShowAll" type="button">Show all</button>
      <button id="colHideAll" type="button">Hide all</button>
    </div>${items || '<div class="col-name" style="color:var(--text-faint);padding:6px">No columns</div>'}`;
  els.colPopover.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const col = cb.dataset.col;
      state.columnVisibility[col] = cb.checked;
      persistColumnVisibility();
      render();
    });
  });
  const showAll = $('#colShowAll');
  const hideAll = $('#colHideAll');
  if (showAll) showAll.addEventListener('click', () => {
    state.allKeys.forEach((k) => { state.columnVisibility[k] = true; });
    persistColumnVisibility();
    renderColPopover();
    render();
  });
  if (hideAll) hideAll.addEventListener('click', () => {
    state.allKeys.forEach((k) => { state.columnVisibility[k] = false; });
    persistColumnVisibility();
    renderColPopover();
    render();
  });
}

els.colToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !els.colPopover.hidden;
  if (open) {
    els.colPopover.hidden = true;
  } else {
    renderColPopover();
    els.colPopover.hidden = false;
  }
});

// Close popover when clicking outside or pressing Escape
document.addEventListener('click', (e) => {
  if (els.colPopover.hidden) return;
  if (!els.colPopover.contains(e.target) && e.target !== els.colToggle && !els.colToggle.contains(e.target)) {
    els.colPopover.hidden = true;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.colPopover.hidden) els.colPopover.hidden = true;
});

els.sidebarClose.addEventListener('click', () => {
  state.selectedIndex = null;
  els.viewPane.querySelectorAll('.selected').forEach((el) => el.classList.remove('selected'));
  renderSidebar();
});
els.sidebarRawToggle.addEventListener('click', () => {
  state.showSidebarRaw = !state.showSidebarRaw;
  renderSidebar();
});
els.sidebarCopy.addEventListener('click', () => {
  if (state.selectedIndex === null) return;
  const l = findLine(state.selectedIndex);
  if (!l || l.parseError) return;
  const text = JSON.stringify(l.value, null, 2);
  navigator.clipboard.writeText(text).then(() => {
    els.sidebarCopy.textContent = '✓';
    setTimeout(() => { els.sidebarCopy.textContent = '⧉'; }, 1200);
  });
});

els.search.addEventListener('input', (e) => {
  state.filter = e.target.value;
  render();
});

document.querySelectorAll('input[name="view"]').forEach((r) => {
  r.addEventListener('change', (e) => {
    state.view = e.target.value;
    els.colPopover.hidden = true;
    render();
    scrollSelectedIntoView();
  });
});

function scrollSelectedIntoView() {
  if (state.selectedIndex === null) return;
  const sel = els.viewPane.querySelector(`[data-idx="${state.selectedIndex}"]`);
  if (sel && typeof sel.scrollIntoView === 'function') {
    sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

// ---- Copy / right-click context menu ----
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}

function hideCtx() {
  els.ctxMenu.hidden = true;
  els.ctxMenu.innerHTML = '';
}

function showCtx(x, y, items) {
  els.ctxMenu.innerHTML = items.map((it) =>
    `<button type="button" data-label="${escapeHtml(it.label)}">${escapeHtml(it.label)}</button>`
  ).join('');
  els.ctxMenu.hidden = false;
  // Keep menu within viewport
  const rect = els.ctxMenu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  els.ctxMenu.style.left = Math.min(x, maxX) + 'px';
  els.ctxMenu.style.top = Math.min(y, maxY) + 'px';
  els.ctxMenu.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const label = btn.dataset.label;
      const item = items.find((i) => i.label === label);
      hideCtx();
      if (item && item.onClick) item.onClick();
    });
  });
}

function showRowContextMenu(x, y, line) {
  const items = [];
  if (!line.parseError) {
    items.push({ label: 'Copy JSON', onClick: () => copyText(JSON.stringify(line.value, null, 2)) });
  }
  items.push({ label: 'Copy raw', onClick: () => copyText((line.raw || '').replace(/\r?\n/g, '')) });
  showCtx(x, y, items);
}

// Right-click on any row in any view
els.viewPane.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('[data-idx]');
  if (!row) return;
  e.preventDefault();
  const line = findLine(Number(row.dataset.idx));
  if (!line) return;
  showRowContextMenu(e.clientX, e.clientY, line);
});

// Right-click on the sidebar raw line text
els.sidebarBody.addEventListener('contextmenu', (e) => {
  const rawEl = e.target.closest('.sidebar-raw-text');
  if (!rawEl) return;
  e.preventDefault();
  const text = (rawEl.textContent || '').replace(/\r?\n/g, '');
  showCtx(e.clientX, e.clientY, [{ label: 'Copy raw', onClick: () => copyText(text) }]);
});

// Dismiss menu on click elsewhere, scroll, or Escape
document.addEventListener('click', hideCtx);
document.addEventListener('scroll', hideCtx, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtx(); });
window.addEventListener('blur', hideCtx);

// Drag & drop onto the window
let dragCounter = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
    els.dropOverlay.hidden = false;
  }
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    els.dropOverlay.hidden = true;
  }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  els.dropOverlay.hidden = true;
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  const filePath = (window.api && window.api.getPathForFile)
    ? window.api.getPathForFile(file)
    : file.path;
  if (filePath) {
    (async () => {
      const st = window.api.statPath ? await window.api.statPath(filePath) : null;
      if (st && st.isDirectory) await openExplorerFolder(filePath);
      else await openFile(filePath);
    })();
  } else {
    showToast('Could not read dropped file path', { kind: 'error' });
  }
});

// Auto-open a file passed via command line
if (window.api.onAutoOpen) {
  window.api.onAutoOpen((filePath) => openFile(filePath));
}

// Reload when the open file is changed by another app
if (window.api.onFileChanged) {
  window.api.onFileChanged((info) => {
    if (!state.filePath) return;
    if (info && info.deleted) {
      showToast('File was deleted on disk', { kind: 'error' });
      return;
    }
    reloadFile();
  });
}

// ---- Native menu handlers ----
if (window.api.onMenu) {
  window.api.onMenu((action, arg) => {
    switch (action) {
      case 'open': openFile(null); break;
      case 'open-folder': openExplorerFolder(null); break;
      case 'trace-sources': openTraceSourcesMenu(); break;
      case 'close-folder': closeExplorerFolder(); break;
      case 'close-file': if (state.filePath) closeFile(state.filePath); break;
      case 'toggle-explorer': toggleExplorer(); break;
      case 'open-file': openFile(arg); break;
      case 'save': saveFile(); break;
      case 'save-as': saveAsFile(); break;
      case 'copy-json': copySelectedRow('json'); break;
      case 'copy-raw': copySelectedRow('raw'); break;
      case 'view': setView(arg); break;
      case 'theme': setTheme(arg); break;
      case 'cycle-theme': toggleTheme(); break;
      case 'zoom-in': changeZoom(1); break;
      case 'zoom-out': changeZoom(-1); break;
      case 'zoom-reset': setZoom(1); break;
      case 'clear-recent':
        state.recent = [];
        persistRecent();
        showToast('Recent history cleared');
        break;
    }
  });
}

function copySelectedRow(kind) {
  if (state.selectedIndex === null) {
    showToast('No row selected', { kind: 'error' });
    return;
  }
  const l = findLine(state.selectedIndex);
  if (!l) return;
  if (kind === 'json') {
    if (l.parseError) { showToast('Cannot copy JSON — parse error', { kind: 'error' }); return; }
    copyText(JSON.stringify(l.value, null, 2));
  } else {
    copyText((l.raw || '').replace(/\r?\n/g, ''));
  }
  showToast('Copied');
}

function setView(v) {
  if (v !== 'table' && v !== 'tree' && v !== 'raw' && v !== 'trace') return;
  if (v === 'trace') {
    recomputeTrace();
    if (!state.trace) return;
  }
  state.view = v;
  const radio = document.querySelector(`input[name="view"][value="${v}"]`);
  if (radio) radio.checked = true;
  render();
  scrollSelectedIntoView();
}

// Initial render
if (window.api && window.api.updateRecent) window.api.updateRecent(state.recent);
render();
console.log('[jsonl-viewer] renderer ready, view=' + state.view);
