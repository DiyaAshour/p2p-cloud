const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const mainStablePath = path.join(root, 'electron', 'main-stable.js');
const mainWrapperPath = path.join(root, 'electron', 'main-wrapper.js');

function patchMainStable() {
  if (!fs.existsSync(mainStablePath)) {
    console.warn('[main-stable-startup] electron/main-stable.js not found; skipping');
    return;
  }

  let source = fs.readFileSync(mainStablePath, 'utf8');
  const before = source;

  source = source.replace("import './seed-auth-cooldown-ipc.js';\n", '');
  source = source.replace("import './seed-auth-cooldown-ipc.js';\r\n", '');

  const blockingReady = "app.whenReady().then(async () => { app.setName(APP_TITLE); ensureDataDir(); loadWallet(); loadManifests(); ensureTransport({}); if (walletState.connected && walletState.verified) { await syncPull(); startAutoRepairLoop(); } createMainWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); }); }).catch((error) => { console.error('Electron failed:', error); app.exit(1); });";
  const nonBlockingReady = "app.whenReady().then(async () => { app.setName(APP_TITLE); ensureDataDir(); loadWallet(); loadManifests(); createMainWindow(); setTimeout(() => { try { ensureTransport({}); if (walletState.connected && walletState.verified) { syncPull().catch((error) => console.warn('[startup] background syncPull failed:', error?.message || error)); startAutoRepairLoop(); } } catch (error) { console.warn('[startup] background P2P startup failed:', error?.message || error); } }, Number(process.env.P2P_STARTUP_BACKGROUND_DELAY_MS || 1500)); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); }); }).catch((error) => { console.error('Electron failed:', error); app.exit(1); });";

  if (source.includes(blockingReady)) {
    source = source.replace(blockingReady, nonBlockingReady);
  }

  const blockingP2pStart = "ipcMain.handle('p2p:start', async (_event, options = {}) => { ensureDataDir(); loadWallet(); loadManifests(); ensureTransport(options); if (walletState.connected && walletState.verified) { await syncPull(); startAutoRepairLoop(); } return networkSummary(); });";
  const nonBlockingP2pStart = "ipcMain.handle('p2p:start', async (_event, options = {}) => { ensureDataDir(); loadWallet(); loadManifests(); ensureTransport(options); if (walletState.connected && walletState.verified) { syncPull().catch((error) => console.warn('[p2p:start] background syncPull failed:', error?.message || error)); startAutoRepairLoop(); } return networkSummary(); });";

  if (source.includes(blockingP2pStart)) {
    source = source.replace(blockingP2pStart, nonBlockingP2pStart);
  }

  const blockingSummary = "ipcMain.handle('p2p:networkSummary', async () => {\n  loadWallet();\n  loadManifests();\n\n  if (walletState.connected && walletState.verified) {\n    await syncPull();\n    startAutoRepairLoop();\n  }\n\n  return networkSummary();\n});";
  const nonBlockingSummary = "ipcMain.handle('p2p:networkSummary', async () => {\n  loadWallet();\n  loadManifests();\n\n  if (walletState.connected && walletState.verified) {\n    syncPull().catch((error) => console.warn('[p2p:networkSummary] background syncPull failed:', error?.message || error));\n    startAutoRepairLoop();\n  }\n\n  return networkSummary();\n});";

  if (source.includes(blockingSummary)) {
    source = source.replace(blockingSummary, nonBlockingSummary);
  }

  if (source !== before) {
    fs.writeFileSync(mainStablePath, source, 'utf8');
    console.log('[main-stable-startup] patched non-blocking app startup and background sync');
  } else {
    console.log('[main-stable-startup] main-stable.js startup already non-blocking');
  }
}

function patchMainWrapperLazySeed() {
  if (!fs.existsSync(mainWrapperPath)) {
    console.warn('[main-stable-startup] electron/main-wrapper.js not found; skipping lazy seed patch');
    return;
  }

  let source = fs.readFileSync(mainWrapperPath, 'utf8');

  if (!source.includes("import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain } from 'electron';")) {
    source = source.replace("import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';", "import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain } from 'electron';");
  }

  if (!source.includes('let lazySeedInstalled = false;')) {
    source = source.replace('let mainImportStarted = false;', 'let mainImportStarted = false;\nlet lazySeedInstalled = false;');
  }

  if (!source.includes('function installLazySeedIpc()')) {
    const helper = "function installLazySeedIpc() { if (lazySeedInstalled) return; lazySeedInstalled = true; for (const ch of ['seed:create', 'seed:login', 'seed:recover']) { try { ipcMain.removeHandler(ch); } catch {} } const call = async (name, payload) => { const mod = await import('./seed-auth-cooldown-ipc.js'); if (name === 'seed:create') return mod.seedCreate(payload); if (name === 'seed:login') return mod.seedLogin(payload); return mod.seedRecover(payload); }; ipcMain.handle('seed:create', async (_e, payload = {}) => call('seed:create', payload)); ipcMain.handle('seed:login', async (_e, payload = {}) => call('seed:login', payload)); ipcMain.handle('seed:recover', async (_e, payload = {}) => call('seed:recover', payload)); console.log('[main-wrapper] lazy seed IPC handlers registered'); }\n";
    source = source.replace('function isVirtualInterfaceName', `${helper}function isVirtualInterfaceName`);
  }

  if (!source.includes('try { installLazySeedIpc(); await import')) {
    source = source.replace('try { await import', 'try { installLazySeedIpc(); await import');
  }

  source = source.replace(" await import('./seed-auth-cooldown-ipc.js'); console.log('[main-wrapper] seed auth cooldown IPC import finished');", " console.log('[main-wrapper] seed auth cooldown IPC deferred until first seed action');");
  source = source.replace("await import('./seed-auth-cooldown-ipc.js'); console.log('[main-wrapper] seed auth cooldown IPC import finished');", "console.log('[main-wrapper] seed auth cooldown IPC deferred until first seed action');");

  fs.writeFileSync(mainWrapperPath, source, 'utf8');
  console.log('[main-stable-startup] ensured lazy seed IPC in main-wrapper.js');
}

patchMainStable();
patchMainWrapperLazySeed();
