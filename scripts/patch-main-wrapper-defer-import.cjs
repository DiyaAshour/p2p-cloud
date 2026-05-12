const fs = require('node:fs');

const file = 'electron/main-wrapper.js';
if (!fs.existsSync(file)) {
  console.log('[patch-main-wrapper-defer-import] main-wrapper.js not found; skipping');
  process.exit(0);
}

let s = fs.readFileSync(file, 'utf8');
const before = s;

if (!s.includes("BrowserWindow") && s.includes("import { app, Menu, Tray, nativeImage } from 'electron';")) {
  s = s.replace(
    "import { app, Menu, Tray, nativeImage } from 'electron';",
    "import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';"
  );
}

if (!s.includes('[main-wrapper] fallback window created')) {
  const marker = "function createTray() {";
  const helper = `
function createFallbackWindow(reason = 'main window did not appear') {
  if (globalThis.__p2pCloudMainWindow && !globalThis.__p2pCloudMainWindow.isDestroyed()) return;
  console.warn('[main-wrapper] fallback window created:', reason);
  const win = new BrowserWindow({
    title: APP_TITLE,
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    show: true,
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  globalThis.__p2pCloudMainWindow = win;
  const url = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';
  win.loadURL(url).catch((error) => {
    console.error('[main-wrapper] fallback loadURL failed:', error?.message || error);
  });
  win.show();
  win.focus();
}

async function importMainWhenReady() {
  if (globalThis.__chunknetMainImportStarted) return;
  globalThis.__chunknetMainImportStarted = true;
  console.log('[main-wrapper] importing main.js after app ready');
  try {
    applyRuntimeSafetyPatches();
    await import('./main.js');
    console.log('[main-wrapper] main.js import finished');
    setTimeout(() => createFallbackWindow('main.js imported but no BrowserWindow appeared'), 3000);
  } catch (error) {
    console.error('[main-wrapper] main.js import failed:', error?.stack || error?.message || error);
    createFallbackWindow(error?.message || 'main.js import failed');
  }
}

`;
  if (s.includes(marker)) s = s.replace(marker, helper + marker);
}

const oldBottom = `if (gotSingleInstanceLock) {
  console.log('[main-wrapper] importing main.js');
  applyRuntimeSafetyPatches();
  await import('./main.js');
}
`;
const newBottom = `if (gotSingleInstanceLock) {
  console.log('[main-wrapper] scheduling main.js import after app ready');
  app.whenReady().then(importMainWhenReady).catch((error) => {
    console.error('[main-wrapper] app.whenReady failed:', error?.stack || error?.message || error);
    createFallbackWindow(error?.message || 'app.whenReady failed');
  });
}
`;

if (s.includes(oldBottom)) {
  s = s.replace(oldBottom, newBottom);
}

if (s !== before) {
  fs.writeFileSync(file, s, 'utf8');
  console.log('[patch-main-wrapper-defer-import] patched electron/main-wrapper.js');
} else {
  console.log('[patch-main-wrapper-defer-import] already patched or pattern not found');
}
