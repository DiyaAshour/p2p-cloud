const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const process = require('node:process');

const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' },
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkUrl(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForVite() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    if (await checkUrl(DEV_SERVER_URL)) {
      console.log(`[electron-dev] Vite is ready: ${DEV_SERVER_URL}`);
      return;
    }
    await sleep(500);
  }
  throw new Error(`[electron-dev] Vite did not become ready at ${DEV_SERVER_URL}`);
}

function resolveElectronBin() {
  const localBin = process.platform === 'win32'
    ? path.join(process.cwd(), 'node_modules', '.bin', 'electron.cmd')
    : path.join(process.cwd(), 'node_modules', '.bin', 'electron');

  if (fs.existsSync(localBin)) return localBin;
  return process.platform === 'win32' ? 'electron.cmd' : 'electron';
}

async function main() {
  run('node', ['scripts/fix-native-p2p-jsx.cjs']);
  run('node', ['scripts/patch-download-memory.cjs']);
  run('node', ['scripts/patch-drive-download-ui.cjs']);
  run('node', ['scripts/patch-native-upload-streaming.cjs']);
  run('node', ['scripts/patch-upload-ram-final.cjs']);
  run('node', ['scripts/patch-native-upload-ui.cjs']);
  run('node', ['scripts/patch-main-stable-upload-cancel.cjs']);
  run('node', ['scripts/fix-generated-jsx-syntax.cjs']);
  run('node', ['scripts/verify-runtime-safety.cjs']);
  run('node', ['scripts/repair-encrypted-manifests.js']);
  run('node', ['scripts/remove-bad-encrypted-manifests.js']);

  await waitForVite();

  const electronBin = resolveElectronBin();
  console.log(`[electron-dev] launching Electron: ${electronBin}`);

  const child = spawn(electronBin, ['--js-flags=--max-old-space-size=8192', '.'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      NODE_OPTIONS: '--max-old-space-size=8192',
      ELECTRON_RENDERER_URL: DEV_SERVER_URL,
    },
  });

  child.on('error', (error) => {
    console.error('[electron-dev] failed to launch Electron:', error?.message || error);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    console.log(`[electron-dev] Electron exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    process.exit(code || 0);
  });
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
