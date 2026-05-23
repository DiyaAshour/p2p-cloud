const fs = require('node:fs');

const file = 'electron/stream-upload-override.js';
if (!fs.existsSync(file)) throw new Error(`${file} not found`);

let src = fs.readFileSync(file, 'utf8');
let changed = false;

function add(find, replacement, label) {
  if (!src.includes(find)) {
    console.log(`[patch-stream-upload-progress] marker not found: ${label}`);
    return false;
  }
  src = src.replace(find, replacement);
  changed = true;
  return true;
}

if (!src.includes("./transfer-progress-state.js")) {
  add(
    "import { putChunkToSafetyPeer, SAFETY_PEER_REPLICA_ID } from './safety-peer.js';",
    "import { putChunkToSafetyPeer, SAFETY_PEER_REPLICA_ID } from './safety-peer.js';\nimport { startTransfer, updateTransfer, finishTransfer, failTransfer } from './transfer-progress-state.js';",
    'transfer-progress-state import'
  );
}

if (!src.includes("./transfer-progress-network-summary-override.js")) {
  if (src.includes("await import('./stream-folder-upload-override.js');")) {
    add(
      "await import('./stream-folder-upload-override.js');",
      "await import('./transfer-progress-network-summary-override.js');\nawait import('./stream-folder-upload-override.js');",
      'network summary import before folder override'
    );
  } else {
    src += "\nawait import('./transfer-progress-network-summary-override.js');\n";
    changed = true;
  }
}

if (!src.includes('let uploadPlainBytes = 0;')) {
  add(
    "  if (walletBytes(ownerWallet) + stat.size > quotaBytes(w.planId)) throw new Error('Storage quota exceeded.');",
    "  if (walletBytes(ownerWallet) + stat.size > quotaBytes(w.planId)) throw new Error('Storage quota exceeded.');\n\n  let uploadPlainBytes = 0;\n  let uploadProgressChunksDone = 0;\n  const uploadTotalChunks = Math.max(1, Math.ceil(stat.size / CHUNK_SIZE_BYTES));\n  startTransfer('upload', {\n    fileName: path.basename(filePath),\n    totalBytes: stat.size,\n    totalChunks: uploadTotalChunks,\n    concurrency: 1,\n  });",
    'startTransfer block'
  );
}

if (!src.includes('uploadPlainBytes += plain.length;')) {
  add(
    "  for await (const part of fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES })) {\n    const plain = Buffer.from(part);\n    originalHasher.update(plain);",
    "  for await (const part of fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES })) {\n    const plain = Buffer.from(part);\n    uploadPlainBytes += plain.length;\n    updateTransfer('upload', {\n      transferredBytes: Math.min(stat.size, uploadPlainBytes),\n      chunksDone: Math.min(uploadTotalChunks, uploadProgressChunksDone),\n      totalChunks: uploadTotalChunks,\n    });\n    originalHasher.update(plain);",
    'read loop progress update'
  );
}

if (!src.includes('uploadProgressChunksDone += 1;')) {
  add(
    "    dropMemoryChunk(hash);\n    index += 1;\n  }",
    "    dropMemoryChunk(hash);\n    uploadProgressChunksDone += 1;\n    updateTransfer('upload', {\n      chunksDone: Math.min(uploadTotalChunks, uploadProgressChunksDone),\n      totalChunks: uploadTotalChunks,\n      transferredBytes: Math.min(stat.size, uploadPlainBytes),\n    });\n    index += 1;\n  }",
    'flush progress update'
  );
}

if (!src.includes("finishTransfer('upload'")) {
  add(
    "  try {\n    await pushWalletManifest(manifest);\n  } catch (syncErr) {\n    console.warn('[stream-upload] manifest sync push failed (non-fatal, will retry on next pull):', syncErr?.message || syncErr);\n  }\n  return manifest;",
    "  try {\n    await pushWalletManifest(manifest);\n  } catch (syncErr) {\n    console.warn('[stream-upload] manifest sync push failed (non-fatal, will retry on next pull):', syncErr?.message || syncErr);\n  }\n  finishTransfer('upload', {\n    transferredBytes: stat.size,\n    chunksDone: uploadTotalChunks,\n    totalChunks: uploadTotalChunks,\n  });\n  return manifest;",
    'finishTransfer block'
  );
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
