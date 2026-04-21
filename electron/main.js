import { app, shell } from 'electron';

const APP_URL = process.env.P2P_CLOUD_URL || 'http://127.0.0.1:3000';

async function openAppInBrowser() {
  const parsed = new URL(APP_URL);

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked unsupported protocol: ${parsed.protocol}`);
  }

  console.log(`Opening browser: ${parsed.toString()}`);
  await shell.openExternal(parsed.toString());
}

app.whenReady().then(async () => {
  try {
    await openAppInBrowser();
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
