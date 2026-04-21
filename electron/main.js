import { app, shell, ipcMain } from 'electron';

const APP_URL = process.env.P2P_CLOUD_URL || 'http://127.0.0.1:3000';

async function openExternalUrl(url = APP_URL) {
  const parsed = new URL(url);

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked unsupported protocol: ${parsed.protocol}`);
  }

  console.log(`Opening browser: ${parsed.toString()}`);
  await shell.openExternal(parsed.toString());
  return { ok: true, url: parsed.toString() };
}

ipcMain.handle('system:open-external', async (_event, url) => {
  try {
    return await openExternalUrl(url);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

app.whenReady().then(async () => {
  try {
    await openExternalUrl(APP_URL);
  } catch (error) {
    console.error('Failed to open app in external browser:', error);
    app.exit(1);
    return;
  }

  app.quit();
}).catch((error) => {
  console.error('Electron app failed during startup:', error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  app.quit();
});
