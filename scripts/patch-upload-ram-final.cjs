const fs = require('node:fs');

const p = 'electron/main.js';
let s = fs.readFileSync(p, 'utf8');
let changed = false;

function replaceAll(from, to) {
  if (s.includes(from)) {
    s = s.split(from).join(to);
    changed = true;
  }
}

replaceAll(
  'chunkMetas.push({ index, size: data.length, data, hash });',
  'chunkMetas.push({ index, offset: index * CHUNK_SIZE_BYTES, size: data.length, hash });'
);

replaceAll(
  "const chunkPayload = { hash: chunk.hash, data: chunk.data.toString('base64'), index: chunk.index, size: chunk.size, ownerWallet, encrypted: privateFile };",
  "const fd = fs.openSync(tempPath, 'r');\n      let data;\n      try {\n        data = Buffer.allocUnsafe(chunk.size);\n        fs.readSync(fd, data, 0, chunk.size, chunk.offset);\n      } finally {\n        fs.closeSync(fd);\n      }\n      const chunkPayload = { hash: chunk.hash, data: data.toString('base64'), index: chunk.index, size: chunk.size, ownerWallet, encrypted: privateFile };"
);

replaceAll('      chunk.data = null;\n', '');

const uploadStart = s.indexOf('async function uploadFilePathStreaming(filePath, payload = {}) {');
const uploadEnd = uploadStart === -1 ? -1 : s.indexOf("\nipcMain.handle('p2p:uploadFiles'", uploadStart);
const uploadScope = uploadStart === -1 ? '' : s.slice(uploadStart, uploadEnd === -1 ? s.length : uploadEnd);
if (uploadScope.includes('chunk.data.toString') || uploadScope.includes('chunkMetas.push({ index, size: data.length, data, hash })')) {
  throw new Error('[patch-upload-ram-final] upload still stores chunk data in RAM');
}

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-upload-ram-final] removed upload chunk RAM retention');
} else {
  console.log('[patch-upload-ram-final] upload chunk RAM retention already removed');
}
