'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

/**
 * Ad-hoc sign the macOS .app.
 *
 * The prebuilt Electron binaries ship ad-hoc signed, but electron-builder
 * rewrites the bundle (rename, Info.plist, app resources) which invalidates
 * that signature. An arm64 .app with a broken signature is refused by dyld —
 * macOS reports it as "damaged" — so it has to be re-signed even when there
 * is no Apple Developer certificate.
 *
 * Skipped when real signing is configured (CSC_LINK / CSC_NAME), so this
 * never fights an actual Developer ID build.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.platform !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  });
  console.log(`  • ad-hoc signed  app=${appPath}`);
};
