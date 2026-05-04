// truncated for brevity
import { startManifestSyncServer } from '../server/manifest-sync.js';
// ... keep rest same until app.whenReady
app.whenReady().then(async () => {
  app.setName(APP_TITLE);
  ensureDataDir();
  loadWallet();
  loadManifests();

  // AUTO START LOCAL MANIFEST SERVER
  try {
    startManifestSyncServer({ port: 8790 });
    console.log('[manifest-sync] local server started automatically');
  } catch (e) {
    console.warn('[manifest-sync] local start failed:', e?.message);
  }

  const node = ensureTransport({});
  connectBootstrap(node);
  await syncPull();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}).catch((error) => {
  console.error('Electron failed:', error);
  app.exit(1);
});
