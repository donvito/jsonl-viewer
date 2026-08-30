# Building

## Installers

Packaging is handled by [electron-builder](https://www.electron.build); all
settings live in `electron-builder.yml`. Output lands in `dist/`.

```bash
npm install
npm run dist:mac      # .dmg + .zip   (arm64, x64)
npm run dist:win      # NSIS .exe installer + portable .exe (x64, arm64)
npm run dist:linux    # .AppImage + .deb + .tar.gz (x64, arm64)
npm run dist          # every target for the current OS
npm run pack          # unpacked app only, for a quick smoke test
```

macOS can cross-build all three platforms; Windows and Linux can only build
their own (and Linux). The `.github/workflows/build-installers.yml` workflow
builds each platform on its native runner — push a `v*` tag to publish the
installers to a GitHub release, or run it manually to just download them as
workflow artifacts.

Installing registers `.jsonl` and `.ndjson` with the app, so double-clicking
one of those files opens it directly.

## Code signing

The builds are **unsigned**. The macOS bundle is ad-hoc signed by
`build/afterPack.js` so it launches on Apple Silicon, but Gatekeeper will
still warn on first open — right-click the app and choose *Open*, or run
`xattr -dr com.apple.quarantine "/Applications/JSONL Viewer.app"`. Windows
SmartScreen shows a similar "unknown publisher" prompt.

To sign for distribution later: on macOS, remove `identity: null` from
`electron-builder.yml`, set `CSC_LINK` / `CSC_KEY_PASSWORD`, and turn
`notarize` on (the `hardenedRuntime` and entitlements settings are already in
place); on Windows, set `CSC_LINK` / `CSC_KEY_PASSWORD` to a code-signing
certificate.

## App icon

`build/icon.svg` is the source; `build/icon.png` (1024×1024) is what
electron-builder consumes and converts to `.icns` / `.ico` / Linux icon sizes.
Regenerate it after editing the SVG:

```bash
npm run icon    # needs librsvg: brew install librsvg
```

## Project layout

```
jsonl-viewer/
├─ package.json
├─ electron-builder.yml   # packaging targets for macOS / Windows / Linux
├─ build/                 # packaging resources (icon, entitlements, hooks)
│  ├─ icon.svg / icon.png
│  ├─ entitlements.mac.plist
│  └─ afterPack.js        # ad-hoc signs the macOS bundle
├─ src/
│  ├─ main.js        # Electron main process: window, dialog, streamed file reading
│  └─ preload.js     # contextBridge API exposed to the renderer
└─ renderer/
   ├─ index.html
   ├─ themes.css     # theme palettes (CSS variables per data-theme)
   ├─ styles.css     # layout / components, consumes theme variables
   └─ renderer.js    # UI logic: table/raw views, filter, expand, drag-drop, themes
```
