# JSONL Viewer

[![Release](https://img.shields.io/github/v/release/donvito/jsonl-viewer?style=flat-square&color=89b4fa&labelColor=1e1e2e)](https://github.com/donvito/jsonl-viewer/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/donvito/jsonl-viewer/total?style=flat-square&color=a6e3a1&labelColor=1e1e2e)](https://github.com/donvito/jsonl-viewer/releases)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-cba6f7?style=flat-square&labelColor=1e1e2e)
[![License](https://img.shields.io/badge/license-Apache%202.0-f9e2af?style=flat-square&labelColor=1e1e2e)](./LICENSE)

A small desktop Electron app for viewing and inspecting `.jsonl` / `.ndjson` (JSON Lines) files.

![JSONL Viewer](./images/jsonl-editor-v2.png)

## Download

Installers for macOS, Windows and Linux are on the
[latest release](https://github.com/donvito/jsonl-viewer/releases/latest).

The builds are unsigned, so macOS shows an unidentified-developer prompt on
first open — right-click the app and choose *Open* — and Windows SmartScreen
shows an unknown-publisher prompt.

## Run from source

```bash
npm install
npm start
```

For development with detached DevTools:

```bash
npm run dev
```

Then click **Open File** (or drag a file in) and pick `test/sample.jsonl` from this repo, or any of your own `.jsonl` / `.ndjson` / `.json` / `.log` / `.txt` files. Hugging Face session traces from STS, Pi, Codex, Claude Code, and Hermes are detected automatically and open in the Traces view. The toolbar's **Traces** menu also finds recent sessions in the standard Codex, Claude Code, Pi, and Hermes locations.

## More

- [Features](./FEATURES.md)
- [Building installers](./BUILDING.md)
