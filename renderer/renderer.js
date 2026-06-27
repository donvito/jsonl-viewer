const state = {
  filePath: null,
  fileName: null,
  totalLines: 0,
  sizeBytes: 0,
  parsedLines: [],
  errors: [],
  truncated: false,
  maxLines: 5000,
  view: 'table',
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

const $ = (sel) => document.querySelector(sel);

const els = {
  loadMoreBtn: $('#loadMoreBtn'),
  themeBtn: $('#themeBtn'),
  themeLabel: $('#themeLabel'),
  themeMenu: $('#themeMenu'),
  editToggle: $('#editToggle'),
  saveBtn: $('#saveBtn'),
  fileInfo: $('#fileInfo'),
  controls: $('#controls'),
  search: $('#search'),
  stat: $('#stat'),
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
  dropOverlay: $('#dropOverlay'),
  ctxMenu: $('#ctxMenu')
};

const COL_DEFAULTS = { line: 60, actions: 44, __value: 220 };
const COL_MIN = 50;

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
    return;
  }

  els.emptyState.hidden = true;
  els.controls.hidden = false;
  els.colToggle.hidden = state.view !== 'table';
  els.treeExpandAll.hidden = state.view !== 'tree';
  els.treeCollapseAll.hidden = state.view !== 'tree';

  const filtered = applyFilter(state.parsedLines);

  if (state.view === 'table') {
    renderTable(filtered);
  } else if (state.view === 'tree') {
    renderTree(filtered);
  } else {
    renderRaw(filtered);
  }

  renderSidebar();

  const shown = filtered.length;
  els.stat.textContent = `Showing ${shown} of ${state.parsedLines.length} loaded · ${state.totalLines} total in file${state.errors.length ? ` · ${state.errors.length} parse errors` : ''}`;
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
async function openFile(filePath) {
  if (!filePath) {
    filePath = await window.api.openFile();
    if (!filePath) return;
  }
  setFileInfo('Loading…');
  try {
    const data = await window.api.readFile(filePath, state.maxLines);
    state.filePath = data.path;
    state.fileName = data.name;
    state.totalLines = data.totalLines;
    state.sizeBytes = data.sizeBytes;
    state.parsedLines = data.parsedLines;
    state.errors = data.errors;
    state.truncated = data.truncated;
    state.expanded = new Set();
    state.treeExpanded = new Set();
    state.selectedIndex = null;
    state.filter = '';
    recomputeAllKeys();
    els.search.value = '';
    els.sidebar.hidden = true;
    setFileInfo(`${data.name} · ${formatBytes(data.sizeBytes)} · ${data.totalLines} lines`);
    addRecent(data.path);
    render();
    console.log(`[jsonl-viewer] loaded ${data.name}: ${data.parsedLines.length} parsed, ${data.errors.length} errors, ${data.totalLines} total`);
  } catch (err) {
    setFileInfo('Error: ' + err.message);
  }
}

async function loadMore() {
  if (!state.filePath) return;
  const start = state.parsedLines.length;
  const count = 5000;
  const data = await window.api.readRange(state.filePath, start, count);
  state.parsedLines.push(...data.lines);
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

// ---- Events ----
els.loadMoreBtn.addEventListener('click', loadMore);
els.themeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleThemeMenu();
});
els.editToggle.addEventListener('click', () => setEditMode(!state.editMode));
els.saveBtn.addEventListener('click', saveFile);
els.treeExpandAll.addEventListener('click', expandAllTree);
els.treeCollapseAll.addEventListener('click', collapseAllTree);

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
window.addEventListener('dragover', (e) => e.preventDefault());
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
  const file = e.dataTransfer.files[0];
  if (file && file.path) openFile(file.path);
});

// Auto-open a file passed via command line
if (window.api.onAutoOpen) {
  window.api.onAutoOpen((filePath) => openFile(filePath));
}

// ---- Native menu handlers ----
if (window.api.onMenu) {
  window.api.onMenu((action, arg) => {
    switch (action) {
      case 'open': openFile(null); break;
      case 'open-file': openFile(arg); break;
      case 'save': saveFile(); break;
      case 'save-as': saveAsFile(); break;
      case 'copy-json': copySelectedRow('json'); break;
      case 'copy-raw': copySelectedRow('raw'); break;
      case 'view': setView(arg); break;
      case 'theme': setTheme(arg); break;
      case 'cycle-theme': toggleTheme(); break;
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
  if (v !== 'table' && v !== 'tree' && v !== 'raw') return;
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
