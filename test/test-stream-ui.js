/*
 * End-to-end test for live trace streaming.
 *
 * Launches the Electron app on a Claude-format session file that this script
 * keeps appending to — the shape of what Codex, Claude Code or Pi write while
 * they work — and asserts that the trace view grows in place, marks itself
 * LIVE, follows the newest entry, pauses following when the reader scrolls
 * away, and reorders when "Newest first" is picked.
 *
 * Run: node test/test-stream-ui.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const PORT = 9335;
const APP_ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(__dirname, 'test-nav-shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try { last = await fn(); } catch (e) { last = undefined; }
    if (last) return;
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
  close() { try { this.ws.close(); } catch (e) {} }
}

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok  -', name); }
  else { failed++; console.log('  FAIL -', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}

const line = (obj) => JSON.stringify(obj) + '\n';
// Entries are padded so the timeline overflows the pane on any display size;
// following and the pill only mean anything when there is somewhere to scroll.
const pad = (text) => text + '\n\n' + Array.from({ length: 12 }, (_, i) => `Detail line ${i + 1} for ${text}`).join('\n');
let uuid = 0;
const userLine = (text) => line({
  type: 'user', uuid: 'u' + ++uuid, sessionId: 'live-1', cwd: '/tmp/live',
  message: { role: 'user', content: [{ type: 'text', text }] }
});
const assistantLine = (text) => line({
  type: 'assistant', uuid: 'a' + ++uuid, sessionId: 'live-1', cwd: '/tmp/live',
  message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: pad(text) }] }
});

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-live-'));
  const file = path.join(dir, 'live-session.jsonl');
  fs.writeFileSync(file, userLine('Kick off the run') + assistantLine('Starting work.'));

  const child = spawn(electron, ['.', `--file=${file}`, `--remote-debugging-port=${PORT}`], {
    cwd: APP_ROOT,
    stdio: 'ignore'
  });

  let cdp = null;
  try {
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

    const entryCount = () => cdp.eval(`document.querySelectorAll('.trace-entry').length`);
    // First paragraph only: the bodies are padded to make the timeline scroll.
    const entryTexts = () => cdp.eval(
      `Array.from(document.querySelectorAll('.trace-entry .trace-text')).map((e) => (e.querySelector('p') || e).textContent.trim())`
    );
    const liveBadge = () => cdp.eval(`!!document.querySelector('.trace-live-badge')`);
    const followHidden = () => cdp.eval(`document.getElementById('traceFollow').hidden`);
    const followText = () => cdp.eval(`document.getElementById('traceFollow').textContent`);
    const atBottom = () => cdp.eval(`(() => {
      const p = document.getElementById('viewPane');
      return p.scrollHeight - p.clientHeight - p.scrollTop <= 24;
    })()`);

    await waitFor(async () => (await entryCount()) === 2, 15000, 'initial trace entries');
    // Order is remembered between runs, so start from a known one.
    await cdp.eval(`document.querySelector('[data-trace-order="oldest"]').click()`);
    console.log('initial state');
    check('opens in trace view with 2 entries', (await entryCount()) === 2);
    check('no live badge before the file grows', (await liveBadge()) === false);
    check('follow pill hidden while idle', (await followHidden()) === true);

    // 1. An appended entry streams in and marks the session live.
    console.log('appending while open');
    // Tag the first entry so we can prove it survives the update rather than
    // being re-created by a full re-render.
    await cdp.eval(`document.querySelector('.trace-entry').dataset.probe = 'kept'`);
    fs.appendFileSync(file, assistantLine('Step one done.'));
    await waitFor(async () => (await entryCount()) === 3, 8000, 'third entry streams in');
    check('appended entry appears without reopening', (await entryCount()) === 3);
    check('session is marked LIVE', (await liveBadge()) === true);
    const probeKept = await cdp.eval(`document.querySelector('.trace-entry').dataset.probe === 'kept'`);
    check('existing entries are patched, not rebuilt', probeKept === true);

    // 2. Several appends in a row keep arriving in order.
    for (let i = 2; i <= 6; i++) {
      fs.appendFileSync(file, assistantLine('Step ' + i + ' done.'));
      await sleep(120);
    }
    await waitFor(async () => (await entryCount()) === 8, 10000, 'all appended entries arrive');
    const texts = await entryTexts();
    check('entries arrive in order', texts[texts.length - 1] === 'Step 6 done.', texts.slice(-2));
    check('view follows the newest entry', (await atBottom()) === true);
    await cdp.screenshot('6-live-following.png');

    // 3. Scrolling away pauses following and counts what arrived.
    console.log('scrolling away from the newest entry');
    await cdp.eval(`document.getElementById('viewPane').scrollTop = 0`);
    await waitFor(async () => (await followHidden()) === false, 4000, 'follow pill appears');
    check('follow pill appears when scrolled away', (await followHidden()) === false);
    fs.appendFileSync(file, assistantLine('Arrived while reading back.'));
    await waitFor(async () => (await entryCount()) === 9, 8000, 'entry arrives while paused');
    check('scroll position is kept while paused', (await cdp.eval(`document.getElementById('viewPane').scrollTop`)) < 40);
    check('pill counts new entries', /1 new entry/.test(await followText()), await followText());
    await cdp.screenshot('7-live-paused.png');

    // 4. The pill resumes following and jumps to the newest entry.
    await cdp.eval(`document.getElementById('traceFollow').click()`);
    await waitFor(async () => await atBottom(), 5000, 'pill scrolls back to newest');
    check('pill resumes following', (await atBottom()) === true);
    check('pill hides once following again', (await followHidden()) === true);

    // 5. Newest first flips the timeline and follows the top instead.
    console.log('newest first');
    await cdp.eval(`document.querySelector('[data-trace-order="newest"]').click()`);
    await waitFor(async () => {
      const t = await entryTexts();
      return t[0] === 'Arrived while reading back.';
    }, 5000, 'newest entry moves to the top');
    check('newest entry is first', (await entryTexts())[0] === 'Arrived while reading back.');
    fs.appendFileSync(file, assistantLine('Newest of all.'));
    await waitFor(async () => (await entryTexts())[0] === 'Newest of all.', 8000, 'new entry lands on top');
    check('new entries land at the top in newest-first order', (await entryTexts())[0] === 'Newest of all.');
    check('view follows the top', (await cdp.eval(`document.getElementById('viewPane').scrollTop`)) < 24);
    await cdp.screenshot('8-newest-first.png');
    await cdp.eval(`document.querySelector('[data-trace-order="oldest"]').click()`);

    // 6. A half-written line is replaced, not duplicated, once complete.
    console.log('partial line')
    const base = await entryCount();
    const partial = '{"type":"assistant","uuid":"a99","sessionId":"live-1","message":{"role":"assistant","model":"claude-test","content":[{"type":"text","text":"Half writ';
    fs.appendFileSync(file, partial);
    await sleep(900);
    check('a half-written line adds no trace entry', (await entryCount()) === base, {
      base, now: await entryCount()
    });
    fs.appendFileSync(file, 'ten line."}]}}\n');
    await waitFor(async () => {
      const t = await entryTexts();
      return t[t.length - 1] === 'Half written line.';
    }, 8000, 'completed line appears');
    check('completed line adds exactly one entry', (await entryCount()) === base + 1, {
      base, now: await entryCount()
    });
    const noDuplicateLines = await cdp.eval(
      `new Set(state.parsedLines.map((l) => l.index)).size === state.parsedLines.length`
    );
    check('no duplicated source lines after the replacement', noDuplicateLines === true);
    const lineCountMatches = await cdp.eval(`state.parsedLines.length === state.totalLines`);
    check('line count matches the file', lineCountMatches === true);

    check('no renderer console errors', cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 3));

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  } catch (err) {
    console.error('TEST ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
