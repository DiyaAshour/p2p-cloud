const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function exists(file) {
  return fs.existsSync(path.join(root, file));
}

function assertFile(file) {
  if (!exists(file)) throw new Error(`Missing required file: ${file}`);
  return read(file);
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`Runtime verification failed: missing ${label || needle}`);
}

const wrapper = assertFile('electron/main-wrapper.js');
const stable = assertFile('electron/main-stable.js');
const main = assertFile('electron/main.js');
const preload = assertFile('electron/preload.cjs');

for (const file of [
  'electron/list-files-normalize-ipc.js',
  'electron/network-summary-normalize-ipc.js',
  'electron/shared-link-ipc.js',
  'electron/file-update-ipc.js',
  'electron/folder-item-ipc.js',
  'electron/folder-crud-ipc.js',
  'electron/ui-prefs-ipc.js',
  'electron/stream-upload-override.js',
  'electron/download-to-path-override.js',
  'electron/hard-delete-override.js',
]) {
  assertFile(file);
}

assertIncludes(wrapper, 'function mainStableHasP2PHandlers()', 'main-stable fallback guard');
assertIncludes(wrapper, "await import('./main.js')", 'main.js fallback import');
assertIncludes(wrapper, "await import('./list-files-normalize-ipc.js')", 'list files normalization import');
assertIncludes(wrapper, "await import('./network-summary-normalize-ipc.js')", 'network summary normalization import');
assertIncludes(wrapper, "await import('./folder-crud-ipc.js')", 'folder CRUD import');
assertIncludes(wrapper, "await import('./folder-item-ipc.js')", 'folder item import');
assertIncludes(wrapper, 'installLazySeedIpc();', 'lazy seed IPC setup');

for (const channel of [
  'p2p:start',
  'p2p:networkSummary',
  'p2p:listFiles',
  'p2p:uploadFiles',
  'p2p:downloadToPath',
  'p2p:delete',
  'p2p:updateFile',
  'p2p:listFolders',
  'p2p:createFolder',
  'p2p:renameItem',
  'p2p:moveItem',
  'p2p:deleteItem',
  'p2p:getUiPrefs',
  'p2p:setUiPrefs',
]) {
  assertIncludes(preload, `'${channel}'`, `preload allowlist ${channel}`);
}

function hasCoreHandlers(source) {
  return (
    source.includes("ipcMain.handle('p2p:start'") &&
    source.includes("ipcMain.handle('p2p:networkSummary'") &&
    source.includes("ipcMain.handle('p2p:uploadFiles'")
  );
}

if (!hasCoreHandlers(stable) && !hasCoreHandlers(main)) {
  throw new Error('Runtime verification failed: neither main-stable.js nor main.js has the core P2P handlers.');
}

console.log('[verify-runtime] ok: no patching required before startup');
console.log('[verify-runtime] source modules verified:', {
  wrapperFallback: true,
  folderModules: true,
  transferModules: true,
  preloadAllowlist: true,
});
