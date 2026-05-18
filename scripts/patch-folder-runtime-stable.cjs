const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const mainPath = path.join(root, 'electron', 'main.js');
const stablePath = path.join(root, 'electron', 'main-stable.js');

function read(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
function write(file, value) { fs.writeFileSync(file, value, 'utf8'); }
function hasCoreRuntime(source) { return source.includes("ipcMain.handle('p2p:start'") && source.includes("ipcMain.handle('p2p:listFiles'") && source.includes("ipcMain.handle('p2p:updateFile'"); }
function hasNetworkFolders(source) { return source.includes("ipcMain.handle('p2p:listFolders'") && source.includes("ipcMain.handle('p2p:createFolder'") && source.includes("ipcMain.handle('p2p:moveFile'"); }
function hasDriveCompat(source) { return source.includes("ipcMain.handle('drive:getFolders'") && source.includes("ipcMain.handle('drive:saveFolders'"); }

const main = read(mainPath);
const stable = read(stablePath);

if (!main) {
  console.warn('[folder-runtime-stable] electron/main.js missing; cannot sync folder runtime');
  process.exit(0);
}
if (!hasCoreRuntime(main)) {
  console.warn('[folder-runtime-stable] main.js does not look like a complete Electron runtime; leaving main-stable unchanged');
  process.exit(0);
}
if (!hasNetworkFolders(main) && !hasDriveCompat(main)) {
  console.warn('[folder-runtime-stable] main.js has no network folder handlers yet; leaving main-stable unchanged');
  process.exit(0);
}

if (!stable || !hasCoreRuntime(stable) || !hasNetworkFolders(stable) || !hasDriveCompat(stable)) {
  write(stablePath, main);
  console.log('[folder-runtime-stable] synced network folder handlers into electron/main-stable.js');
} else {
  console.log('[folder-runtime-stable] main-stable already has network folder handlers');
}
