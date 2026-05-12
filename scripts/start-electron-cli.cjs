const { spawn } = require('node:child_process');
const http = require('node:http');
const process = require('node:process');

const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';

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
      console.log('[electron-cli] Vite is ready: ' + DEV_SERVER_URL);
      return;
    }
    await sleep(500);
  }
  throw new Error('[electron-cli] Vite did not become ready at ' + DEV_SERVER_URL);
}

async function main() {
  await waitForVite();

  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const args = ['exec', 'electron', '.', '--js-flags=--max-old-space-size=8192'];
  console.log('[electron-cli] launching:', command + ' ' + args.join(' '));

  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: DEV_SERVER_URL,
      NODE_OPTIONS: '--max-old-space-size=8192',
    },
  });

  child.on('error', (error) => {
    console.error('[electron-cli] launch failed:', error?.message || error);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    console.log('[electron-cli] exited code=' + (code ?? 'null') + ' signal=' + (signal ?? 'null'));
    process.exit(code || 0);
  });
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
