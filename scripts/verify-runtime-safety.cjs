const fs = require('node:fs');

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing required file: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

function mustContain(file, content, tokens) {
  for (const token of tokens) {
    if (!content.includes(token)) throw new Error(`${file}: required token missing: ${token}`);
  }
}

function mustNotContain(file, content, tokens) {
  for (const token of tokens) {
    if (content.includes(token)) throw new Error(`${file}: forbidden token present: ${token}`);
  }
}

function scoped(content, startToken, endTokens = []) {
  const start = content.indexOf(startToken);
  if (start === -1) throw new Error(`missing scope ${startToken}`);
  let end = content.length;
  for (const token of endTokens) {
    const i = content.indexOf(token, start + startToken.length);
    if (i !== -1 && i < end) end = i;
  }
  return content.slice(start, end);
}

const main = read('electron/main.js');
const stable = read('electron/main-stable.js');
const preload = read('electron/preload.cjs');
const live = read('client/src/NativeP2PAppLive.tsx');
const downloadOverride = read('electron/download-to-path-override.js');

for (const [file, content] of [['electron/main.js', main], ['electron/main-stable.js', stable]]) {
  mustContain(file, content, [
    "ipcMain.handle('p2p:start'",
    "ipcMain.handle('p2p:networkSummary'",
    "ipcMain.handle('p2p:uploadFiles'",
    "ipcMain.handle('p2p:updateFile'",
    'async function uploadFilePathStreaming',
    'fs.createReadStream(filePath',
    'dialog.showOpenDialog',
    'chunknet-uploads',
    'folder,',
    'await syncPush(manifest)',
  ]);

  const uploadScope = scoped(content, 'async function uploadFilePathStreaming', ["\nipcMain.handle('p2p:download'", "\nipcMain.handle('p2p:delete'"]);
  mustContain(file, uploadScope, ['folder', 'payload.folderPath']);
  mustNotContain(file, uploadScope, ['await file.arrayBuffer()', 'Buffer.concat(buffers)', 'Array.from(plain)']);
}

mustContain('electron/download-to-path-override.js', downloadOverride, [
  'downloadManifestToPath',
  "'p2p:downloadToPath'",
  'ipcMain.handle(channel',
  'dialog.showSaveDialog',
  'createWriteStream',
]);
mustNotContain('electron/download-to-path-override.js', downloadOverride, ['bytes: Array.from', 'Array.from(outputBuffer)', 'Buffer.concat(buffers)']);

mustContain('electron/preload.cjs', preload, ["'p2p:uploadFiles'", "'p2p:downloadToPath'", "'p2p:updateFile'", "'seed:create'", "'wallet:connect'"]);
mustContain('client/src/NativeP2PAppLive.tsx', live, ['p2p:uploadFiles', 'p2p:downloadToPath', 'p2p:updateFile', 'file.folder']);
mustNotContain('client/src/NativeP2PAppLive.tsx', live, ['file.arrayBuffer()', 'bytes: await']);

console.log('[verify-runtime-safety] Electron runtime safety checks passed');
