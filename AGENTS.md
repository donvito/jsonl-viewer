# JSONL Viewer

A desktop Electron app for viewing/inspecting `.jsonl` / `.ndjson` files. See `README.md` for features, run commands, and project layout.

## Cursor Cloud specific instructions

This is a single Electron desktop app. There is no separate backend/frontend split and no lint config in the repo.

- **Headless display required.** The VM has no attached monitor for shell commands, so Electron must run under a virtual/remote X display:
  - For automated tests, wrap the command in `xvfb-run -a --server-args="-screen 0 1280x800x24"`.
  - For GUI/manual testing (and for the computerUse subagent), a TigerVNC display is available at `DISPLAY=:1`; launch with `DISPLAY=:1 ./node_modules/.bin/electron . --no-sandbox ...`.
- **`--no-sandbox` is mandatory** when launching Electron in this container (the Chromium sandbox cannot initialize here). Tests already pass it.
- **Expected, ignorable stderr noise:** `bus.cc ... Failed to connect to the bus`, GPU/`viz_main_impl`/`command_buffer_proxy` errors, and DevTools `Autofill.enable` warnings are environmental (no D-Bus / no real GPU) and are NOT application errors. The smoke test deliberately filters these out.
- **Tests** (no test runner; they are standalone Node/Electron scripts):
  - `node test-parse.js` — pure Node, no display needed; validates the JSONL parsing logic.
  - `xvfb-run -a --server-args="-screen 0 1280x800x24" node test-themes.js` — launches the real app headless and smoke-tests loading `sample.jsonl`.
  - `xvfb-run -a ./node_modules/.bin/electron --no-sandbox --disable-gpu test-themes-functional.js` — verifies theme switching / syntax-highlight colors.
- **Auto-open a file** on launch with `--file=<path>` (e.g. `--file=sample.jsonl`); `sample.jsonl` in the repo is the canonical demo input.
