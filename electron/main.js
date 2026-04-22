import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const APP_URL = process.env.P2P_CLOUD_URL || 'http://127.0.0.1:3000';

async function openInBrowser(url = APP_URL) {
  const target = new URL(url).toString();

  if (process.platform === 'win32') {
    try {
      await execFileAsync('cmd', ['/c', 'start', 'chrome', '', target]);
      return { ok: true, browser: 'chrome' };
    } catch {
      await execFileAsync('cmd', ['/c', 'start', '', target]);
      return { ok: true, browser: 'default' };
    }
  }

  if (process.platform === 'darwin') {
    try {
      await execFileAsync('open', ['-a', 'Google Chrome', target]);
      return { ok: true, browser: 'chrome' };
    } catch {
      await execFileAsync('open', [target]);
      return { ok: true, browser: 'default' };
    }
  }

  try {
    await execFileAsync('google-chrome', [target]);
    return { ok: true, browser: 'chrome' };
  } catch {
    await execFileAsync('xdg-open', [target]);
    return { ok: true, browser: 'default' };
  }
}

app.whenReady().then(async () => {
  try {
    await openInBrowser(APP_URL);
  } catch (error) {
    console.error('Failed to open browser:', error);
    app.exit(1);
    return;
  }

  app.quit();
}).catch((error) => {
  console.error('Electron startup failed:', error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  app.quit();
});
