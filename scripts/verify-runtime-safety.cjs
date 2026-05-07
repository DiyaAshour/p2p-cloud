const fs = require('node:fs');

const checks = [
  {
    file: 'electron/main.js',
    forbidden: ['Array.from(plain)', 'Buffer.concat(buffers)'],
    required: ['chunknet-downloads', 'dialog.showSaveDialog', 'fs.appendFileSync(tempPath, buffer)'],
    scopeStart: "ipcMain.handle('p2p:download'",
    scopeEndCandidates: ["\nipcMain.handle('p2p:delete'", "\nipcMain.handle('p2p:repair'", "\nipcMain.handle('p2p:prepareProof'"],
  },
  {
    file: 'electron/main.js',
    forbidden: ['chunk.data.toString', 'chunkMetas.push({ index, size: data.length, data, hash })'],
    required: ['uploadFilePathStreaming', 'chunknet-uploads', 'fs.createReadStream(filePath', 'fs.readSync(fd, data, 0, chunk.size, chunk.offset)'],
    scopeStart: 'async function uploadFilePathStreaming',
    scopeEndCandidates: ["\nipcMain.handle('p2p:uploadFiles'"],
  },
  {
    file: 'electron/main.js',
    forbidden: [],
    required: ['p2p:uploadFiles', 'uploadFilePathStreaming'],
    scopeStart: "ipcMain.handle('p2p:uploadFiles'",
    scopeEndCandidates: ["\nipcMain.handle('p2p:download'", "\nipcMain.handle('p2p:delete'"],
  },
  {
    file: 'electron/preload.cjs',
    required: ["'p2p:uploadFiles'"],
  },
  {
    file: 'client/src/DriveP2PAppPassword.tsx',
    forbidden: ['new Uint8Array(r.bytes)', 'bytes: number[]', 'await file.arrayBuffer()', 'bytes: await'],
    required: ['savedPath', 'Download complete', 'p2p:uploadFiles'],
  },
  {
    file: 'package.json',
    forbidden: ['powershell -NoProfile -Command Start-Sleep'],
    required: ['node scripts/start-electron-dev.cjs', 'patch-drive-download-ui.cjs', 'patch-download-memory.cjs', 'patch-native-upload-streaming.cjs', 'patch-upload-ram-final.cjs', 'patch-native-upload-ui.cjs', 'verify-runtime-safety.cjs'],
  },
];

function scopedContent(content, check) {
  if (!check.scopeStart) return content;
  const start = content.indexOf(check.scopeStart);
  if (start === -1) throw new Error(`${check.file}: missing scope ${check.scopeStart}`);
  let end = -1;
  for (const candidate of check.scopeEndCandidates || []) {
    const idx = content.indexOf(candidate, start);
    if (idx !== -1 && (end === -1 || idx < end)) end = idx;
  }
  if (end === -1) end = content.length;
  return content.slice(start, end);
}

for (const check of checks) {
  if (!fs.existsSync(check.file)) throw new Error(`Missing required file: ${check.file}`);
  const content = fs.readFileSync(check.file, 'utf8');
  const scope = scopedContent(content, check);
  for (const token of check.forbidden || []) {
    if (scope.includes(token)) throw new Error(`${check.file}: forbidden runtime token still present: ${token}`);
  }
  for (const token of check.required || []) {
    if (!scope.includes(token)) throw new Error(`${check.file}: required runtime token missing: ${token}`);
  }
}

console.log('[verify-runtime-safety] upload/download streaming runtime checks passed');
