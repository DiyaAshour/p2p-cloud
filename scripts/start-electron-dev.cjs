const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const process = require('node:process');

const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';
const baseEnv = { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' };

function runNode(script) {
  const result = spawnSync(process.execPath, [script], {
    stdio: 'inherit',
    env: baseEnv,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkUrl(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForVite() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60000) {
    if (await checkUrl(DEV_SERVER_URL)) {
      console.log('[electron-dev] Vite is ready: ' + DEV_SERVER_URL);
      return;
    }
    await sleep(500);
  }
  throw new Error('[electron-dev] Vite did not become ready at ' + DEV_SERVER_URL);
}

function resolveElectronBin() {
  if (process.platform === 'win32') {
    const electronExe = path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe');
    if (fs.existsSync(electronExe)) return electronExe;
  }

  const localBin = process.platform === 'win32'
    ? path.join(process.cwd(), 'node_modules', '.bin', 'electron.cmd')
    : path.join(process.cwd(), 'node_modules', '.bin', 'electron');

  return fs.existsSync(localBin) ? localBin : 'electron';
}

async function main() {
  runNode('scripts/fix-native-p2p-jsx.cjs');
  runNode('scripts/patch-download-memory.cjs');
  runNode('scripts/patch-drive-download-ui.cjs');
  runNode('scripts/patch-native-upload-streaming.cjs');
  runNode('scripts/patch-upload-ram-final.cjs');
  runNode('scripts/patch-native-upload-ui.cjs');
  runNode('scripts/patch-main-stable-upload-cancel.cjs');
  runNode('scripts/fix-generated-jsx-syntax.cjs');
  runNode('scripts/patch-electron-window-show.cjs');
  runNode('scripts/patch-window-visible-only.cjs');
  runNode('scripts/patch-main-wrapper-defer-import.cjs');
  runNode('scripts/verify-runtime-safety.cjs');
  runNode('scripts/repair-encrypted-manifests.js');
  runNode('scripts/remove-bad-encrypted-manifests.js');

  await waitForVite();

  const electronBin = resolveElectronBin();
  console.log('[electron-dev] launching Electron: ' + electronBin);

  const child = spawn(electronBin, ['--js-flags=--max-old-space-size=8192', '.'], {
    stdio: 'inherit',
    env: { ...baseEnv, ELECTRON_RENDERER_URL: DEV_SERVER_URL },
    shell: false,
  });

  child.on('error', (error) => {
    console.error('[electron-dev] failed to launch Electron:', error && error.message ? error.message : error);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    console.log('[electron-dev] Electron exited code=' + (code ?? 'null') + ' signal=' + (signal ?? 'null'));
    process.exit(code || 0);
  });
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
