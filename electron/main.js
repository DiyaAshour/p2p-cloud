import { app, shell, ipcMain } from 'electron';

const APP_URL = process.env.P2P_CLOUD_URL || 'http://127.0.0.1:3000';
let isQuitting = false;

async function openAppInBrowser(url = APP_URL) {
  const parsed = new URL(url);

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked unsupported protocol: ${parsed.protocol}`);
  }

  await shell.openExternal(parsed.toString());
  return { ok: true, url: parsed.toString() };
}

app.whenReady().then(() => {
  ipcMain.handle('system:open-external', async (_event, url) => {
    try {
      return await openAppInBrowser(url);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  (async () => {
    try {
      console.log(`Opening browser: ${APP_URL}`);
      await openAppInBrowser(APP_URL);
    } catch (error) {
      console.error('Failed to open external URL:', error);
    } finally {
      isQuitting = true;
      app.quit();
    }
  })();
}).catch((error) => {
  console.error('Electron app failed during startup:', error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (!isQuitting) {
    isQuitting = true;
    app.quit();
  }
});
