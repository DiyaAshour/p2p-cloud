const fs = require('node:fs');

const file = 'electron/stream-upload-override.js';
if (!fs.existsSync(file)) throw new Error(`${file} not found`);

let src = fs.readFileSync(file, 'utf8');
let changed = false;

if (!src.includes("./transfer-progress-state.js")) {
  src = src.replace(
    "import { putChunkToSafetyPeer, SAFETY_PEER_REPLICA_ID } from './safety-peer.js';",
    "import { putChunkToSafetyPeer, SAFETY_PEER_REPLICA_ID } from './safety-peer.js';\nimport { startTransfer, updateTransfer, finishTransfer, failTransfer } from './transfer-progress-state.js';"
  );
  changed = true;
}

if (!src.includes('let uploadPlainBytes = 0;')) {
  src = src.replace(
    "  if (walletBytes(ownerWallet) + stat.size > quotaBytes(w.planId)) throw new Error('Storage quota exceeded.');",
    "  if (walletBytes(ownerWallet) + stat.size > quotaBytes(w.planId)) throw new Error('Storage quota exceeded.');\n\n  let uploadPlainBytes = 0;\n  let uploadProgressChunksDone = 0;\n  const uploadTotalChunks = Math.max(1, Math.ceil(stat.size / CHUNK_SIZE_BYTES));\n  startTransfer('upload', {\n    fileName: path.basename(filePath),\n    totalBytes: stat.size,\n    totalChunks: uploadTotalChunks,\n    concurrency: 1,\n  });"
  );
  changed = true;
}

if (!src.includes('uploadProgressChunksDone += 1;')) {
  src = src.replace(
    "    index += 1;\n  }",
    "    uploadProgressChunksDone += 1;\n    updateTransfer('upload', {\n      chunksDone: Math.min(uploadTotalChunks, uploadProgressChunksDone),\n      totalChunks: uploadTotalChunks,\n      transferredBytes: Math.min(stat.size, uploadPlainBytes),\n    });\n    index += 1;\n  }"
  );
  changed = true;
}

if (!src.includes('uploadPlainBytes += plain.length;')) {
  src = src.replace(
    "    const plain = Buffer.from(part);\n    originalHasher.update(plain);",
    "    const plain = Buffer.from(part);\n    uploadPlainBytes += plain.length;\n    updateTransfer('upload', {\n      transferredBytes: Math.min(stat.size, uploadPlainBytes),\n      chunksDone: Math.min(uploadTotalChunks, uploadProgressChunksDone),\n      totalChunks: uploadTotalChunks,\n    });\n    originalHasher.update(plain);"
  );
  changed = true;
}

if (!src.includes("finishTransfer('upload'")) {
  src = src.replace(
    "  return manifest;\n}",
    "  finishTransfer('upload', { transferredBytes: stat.size, chunksDone: uploadTotalChunks, totalChunks: uploadTotalChunks });\n  return manifest;\n}"
  );
  changed = true;
}

if (!src.includes("failTransfer('upload'")) {
  src = src.replace(
    "ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => uploadFiles(payload));",
    "ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => {\n  try {\n    return await uploadFiles(payload);\n  } catch (error) {\n    failTransfer('upload', error);\n    throw error;\n  }\n});"
  );
  src = src.replace(
    "ipcMain.handle('p2p:uploadPath', async (_event, payload = {}) => uploadOne(String(payload.filePath || payload.path || ''), payload));",
    "ipcMain.handle('p2p:uploadPath', async (_event, payload = {}) => {\n  try {\n    return await uploadOne(String(payload.filePath || payload.path || ''), payload);\n  } catch (error) {\n    failTransfer('upload', error);\n    throw error;\n  }\n});"
  );
  changed = true;
}

if (changed) {
  fs.writeFileSync(file, src, 'utf8');
  console.log('[patch-stream-upload-progress] patched stream upload progress');
} else {
  console.log('[patch-stream-upload-progress] already patched');
}
