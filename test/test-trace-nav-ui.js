/*
 * End-to-end test for the trace message navigation widget.
 *
 * Launches the Electron app with a synthetic Claude-format trace
 * (test-trace-nav.jsonl: 21 user/assistant messages + 1 tool call),
 * drives it over the Chrome DevTools Protocol, and asserts that the
 * floating ▲/▼ widget, its counter, and the [ / ] shortcuts behave.
 * Also opens a short trace that fits on one screen to verify the counter
 * keeps the jumped-to index when the pane cannot scroll further.
 *
 * Run: node test/test-trace-nav-ui.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const electron = require('electron');

const PORT = 9333;
const TEST_DIR = __dirname;
// The app lives in the repo root; electron is launched from there while the
// fixtures and screenshots live alongside this script.
const APP_ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(TEST_DIR, 'test-nav-shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let ok = false;
    try { ok = await fn(); } catch (e) { ok = false; }
    if (ok) return;
    await sleep(120);
  }
  throw new Error('timed out waiting for: ' + label);
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('CDP websocket failed'));
    });
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(JSON.stringify(msg.params.exceptionDetails.exception || msg.params.exceptionDetails.text));
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async screenshot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
    console.log('  shot ->', path.join('test-nav-shots', name));
  }
  async key(ch, code, vk) {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok  -', name); }
  else { failed++; console.log('  FAIL -', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(TEST_DIR, 'test-trace-nav.jsonl');
  const child = spawn(electron, ['.', `--file=${file}`, `--remote-debugging-port=${PORT}`], {
    cwd: APP_ROOT,
    stdio: 'ignore'
  });

  let cdp = null;
  try {
    // Wait for the CDP page target
    let target = null;
    const start = Date.now();
    while (!target && Date.now() - start < 30000) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json`);
        const targets = await res.json();
        target = targets.find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
      } catch (e) {}
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('CDP page target never appeared');

    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const pos = () => cdp.eval(`document.getElementById('traceNavPos').textContent`);
    const upDisabled = () => cdp.eval(`document.getElementById('traceNavUp').disabled`);
    const downDisabled = () => cdp.eval(`document.getElementById('traceNavDown').disabled`);
    const navHidden = () => cdp.eval(`document.getElementById('traceNav').hidden`);
    const down = () => cdp.eval(`document.getElementById('traceNavDown').click()`);
    const up = () => cdp.eval(`document.getElementById('traceNavUp').click()`);

    // 1. Trace view opens automatically and the nav widget is visible
    await waitFor(async () => (await navHidden()) === false, 15000, 'trace view + nav widget visible');
    console.log('initial state');
    check('nav widget visible in trace view', (await navHidden()) === false);
    check('counter shows 1 / 21', (await pos()) === '1 / 21', await pos());
    check('up button disabled at top', (await upDisabled()) === true);
    check('down button enabled', (await downDisabled()) === false);
    await cdp.screenshot('1-initial.png');

    // 2. Down button jumps to the next message
    await down();
    const flashed = await cdp.eval(`!!document.querySelector('.trace-entry.trace-nav-flash')`);
    check('target message flashes on jump', flashed === true);
    await waitFor(async () => (await pos()) === '2 / 21', 4000, 'counter 2/21 after down');
    check('down click -> 2 / 21', (await pos()) === '2 / 21', await pos());
    await cdp.screenshot('2-after-down.png');

    // 3. Rapid successive down clicks
    await down();
    await down();
    await waitFor(async () => (await pos()) === '4 / 21', 5000, 'counter 4/21 after two more downs');
    check('two more down clicks -> 4 / 21', (await pos()) === '4 / 21', await pos());

    // 4. Up button
    await up();
    await waitFor(async () => (await pos()) === '3 / 21', 4000, 'counter 3/21 after up');
    check('up click -> 3 / 21', (await pos()) === '3 / 21', await pos());

    // 5. Keyboard shortcuts ] and [
    await cdp.key(']', 'BracketRight', 221);
    await waitFor(async () => (await pos()) === '4 / 21', 4000, 'counter 4/21 after ]');
    check('] key -> 4 / 21', (await pos()) === '4 / 21', await pos());
    await cdp.key('[', 'BracketLeft', 219);
    await waitFor(async () => (await pos()) === '3 / 21', 4000, 'counter 3/21 after [');
    check('[ key -> 3 / 21', (await pos()) === '3 / 21', await pos());

    // 6. Manual scroll to the bottom tracks the last message
    await cdp.eval(`document.getElementById('viewPane').scrollTop = 1e9`);
    await waitFor(async () => (await pos()) === '21 / 21', 4000, 'counter 21/21 at bottom');
    check('scroll to bottom -> 21 / 21', (await pos()) === '21 / 21', await pos());
    check('down button disabled at bottom', (await downDisabled()) === true);
    await cdp.screenshot('3-bottom.png');

    // 7. Manual scroll back to the top
    await cdp.eval(`document.getElementById('viewPane').scrollTop = 0`);
    await waitFor(async () => (await pos()) === '1 / 21', 4000, 'counter 1/21 at top');
    check('scroll to top -> 1 / 21', (await pos()) === '1 / 21', await pos());
    check('up button disabled at top', (await upDisabled()) === true);

    // 8. Opening the row sidebar shifts the widget left of it
    await cdp.eval(`document.querySelector('.trace-entry[data-idx]').click()`);
    await waitFor(async () => (await cdp.eval(`!document.getElementById('sidebar').hidden`)) === true, 4000, 'sidebar opens');
    const offsetOk = await cdp.eval(`(() => {
      const nav = document.getElementById('traceNav').getBoundingClientRect();
      const side = document.getElementById('sidebar').getBoundingClientRect();
      return nav.right <= side.left + 1;
    })()`);
    check('nav widget sits left of open sidebar', offsetOk === true);
    await cdp.screenshot('4-sidebar-open.png');
    await cdp.eval(`document.getElementById('sidebarClose').click()`);

    // 9. Switching to table view hides the widget; trace view restores it
    await cdp.eval(`document.querySelector('input[name="view"][value="table"]').click()`);
    await waitFor(async () => (await navHidden()) === true, 4000, 'nav hidden in table view');
    check('nav hidden in table view', (await navHidden()) === true);
    await cdp.eval(`document.querySelector('input[name="view"][value="trace"]').click()`);
    await waitFor(async () => (await navHidden()) === false, 4000, 'nav back in trace view');
    check('nav visible again in trace view', (await navHidden()) === false);

    // 10. Typing in the search box does not trigger navigation
    await cdp.eval(`(() => { const s = document.getElementById('search'); s.focus(); return true; })()`);
    await cdp.key('[', 'BracketLeft', 219);
    await sleep(300);
    const searchVal = await cdp.eval(`document.getElementById('search').value`);
    check('[ typed into search, not navigation', searchVal === '[', searchVal);
    await cdp.eval(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); return true; })()`);
    await waitFor(async () => (await navHidden()) === false, 4000, 'nav restored after clearing filter');

    // 11. Short trace that fits on one screen: jumps still advance the
    // counter even though the pane cannot scroll to the target.
    console.log('short trace (fits on one screen)');
    const shortFile = path.join(TEST_DIR, 'test-trace-nav-short.jsonl');
    await cdp.eval(`openFile(${JSON.stringify(shortFile)})`);
    await waitFor(async () => (await pos()) === '1 / 6', 8000, 'short trace counter 1/6');
    check('short trace counter shows 1 / 6', (await pos()) === '1 / 6', await pos());
    await down();
    await waitFor(async () => (await pos()) === '2 / 6', 3000, 'short trace 2/6 after down');
    check('down click -> 2 / 6 (no scroll possible)', (await pos()) === '2 / 6', await pos());
    await down();
    await waitFor(async () => (await pos()) === '3 / 6', 3000, 'short trace 3/6 after down');
    check('down click -> 3 / 6', (await pos()) === '3 / 6', await pos());
    await up();
    await waitFor(async () => (await pos()) === '2 / 6', 3000, 'short trace 2/6 after up');
    check('up click -> 2 / 6', (await pos()) === '2 / 6', await pos());
    await sleep(1000); // let the jump lock expire, then verify it sticks
    check('counter keeps jumped-to index after lock expiry', (await pos()) === '2 / 6', await pos());
    await cdp.screenshot('5-short-trace.png');

    // 12. No renderer console errors
    check('no renderer console errors', cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 3));
  } finally {
    if (cdp) cdp.close();
    child.kill('SIGTERM');
    await sleep(300);
    try { child.kill('SIGKILL'); } catch (e) {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('TEST ERROR:', err.message);
  process.exit(1);
});
