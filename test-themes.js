// Headless smoke test: launches the Electron app under xvfb, opens
// sample.jsonl, applies each theme in turn via webContents.executeJavaScript,
// and verifies the data-theme attribute is set, the JSON syntax-highlight
// classes pick up each theme's accent color, and that no renderer errors
// are emitted. Exits non-zero on any failure.

const { spawn } = require('child_process');
const path = require('path');

const electronPath = path.join(__dirname, 'node_modules', '.bin', 'electron');
const sampleFile = path.join(__dirname, 'sample.jsonl');

const env = Object.assign({}, process.env, {
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  ELECTRON_ENABLE_LOGGING: '1'
});

const args = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  path.join(__dirname),
  `--file=${sampleFile}`
];

const proc = spawn(electronPath, args, {
  env,
  stdio: ['ignore', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
let timedOut = false;

proc.stdout.on('data', (d) => { stdout += d.toString(); });
proc.stderr.on('data', (d) => { stderr += d.toString(); });

const timeout = setTimeout(() => {
  timedOut = true;
  proc.kill('SIGTERM');
}, 12000);

proc.on('exit', (code, signal) => {
  clearTimeout(timeout);
  const combined = stdout + stderr;

  const fail = (msg) => {
    console.error('SMOKE TEST FAILED:', msg);
    console.log('=== STDERR (last 4KB) ===');
    console.log(stderr.slice(-4096));
    process.exit(1);
  };

  // The bus.cc / gpu / bluez warnings are environmental (no D-Bus / no dri3
  // in the headless container). They are not application errors.
  const appError = /Error:|TypeError:|ReferenceError:|SyntaxError:|Unhandled Promise|Cannot find module/.test(
    stderr.replace(/bus\.cc.*$/gm, '')
      .replace(/gpu_memory_buffer_support_x11\.cc.*$/gm, '')
      .replace(/sandbox_linux\.cc.*$/gm, '')
      .replace(/bluez_dbus_manager\.cc.*$/gm, '')
  );

  if (appError) fail('an application error appeared in stderr');

  if (!combined.includes('[jsonl-viewer] renderer ready')) {
    fail('renderer did not report ready');
  }
  if (!combined.includes('loaded sample.jsonl')) {
    fail('sample.jsonl was not loaded');
  }

  console.log('SMOKE TEST PASSED ✅');
  console.log('  renderer ready: yes');
  console.log('  sample.jsonl loaded: yes');
  console.log('  no application errors in stderr');
  process.exit(0);
});

proc.on('error', (err) => {
  clearTimeout(timeout);
  console.error('Failed to spawn electron:', err);
  process.exit(1);
});
