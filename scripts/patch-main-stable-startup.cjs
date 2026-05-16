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
  if (source !== before) {
    fs.writeFileSync(mainStablePath, source, 'utf8');
    console.log('[main-stable-startup] removed early seed-auth import from main-stable.js');
  } else {
    console.log('[main-stable-startup] main-stable.js startup import order already safe');
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
  fs.writeFileSync(mainWrapperPath, source, 'utf8');
  console.log('[main-stable-startup] ensured lazy seed IPC in main-wrapper.js');
}

patchMainStable();
patchMainWrapperLazySeed();
