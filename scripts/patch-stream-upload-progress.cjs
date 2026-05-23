const fs = require('node:fs');

const file = 'electron/stream-upload-override.js';
if (!fs.existsSync(file)) throw new Error(`${file} not found`);

let src = fs.readFileSync(file, 'utf8');
let changed = false;

function patchText(find, replacement, label) {
  if (!src.includes(find)) {
    console.log(`[patch-stream-upload-progress] marker not found: ${label}`);
    return false;
  }
  src = src.replace(find, replacement);
  changed = true;
  console.log(`[patch-stream-upload-progress] patched ${label}`);
  return true;
}

function patchRegex(regex, replacement, label) {
  if (!regex.test(src)) {
    console.log(`[patch-stream-upload-progress] regex not found: ${label}`);
    return false;
  }
  src = src.replace(regex, replacement);
  changed = true;
  console.log(`[patch-stream-upload-progress] patched ${label}`);
  return true;
}

if (!src.includes("./transfer-progress-state.js")) {
  patchText(
    "import { putChunkToSafetyPeer, SAFETY_PEER_REPLICA_ID } from './safety-peer.js';",
    "import { putChunkToSafetyPeer, SAFETY_PEER_REPLICA_ID } from './safety-peer.js';\nimport { startTransfer, updateTransfer, finishTransfer, failTransfer, throwIfTransferCancelled } from './transfer-progress-state.js';",
    'transfer-progress-state import'
  );
} else if (!src.includes('throwIfTransferCancelled')) {
  src = src.replace(
    "import { startTransfer, updateTransfer, finishTransfer, failTransfer } from './transfer-progress-state.js';",
    "import { startTransfer, updateTransfer, finishTransfer, failTransfer, throwIfTransferCancelled } from './transfer-progress-state.js';"
  );
  changed = true;
}

if (!src.includes('deleteChunkFromSafetyPeer')) {
  src = src.replace(
    "import { putChunkToSafetyPeer, SAFETY_PEER_REPLICA_ID } from './safety-peer.js';",
    "import { putChunkToSafetyPeer, deleteChunkFromSafetyPeer, SAFETY_PEER_REPLICA_ID } from './safety-peer.js';"
  );
  changed = true;
}

if (!src.includes("./transfer-progress-network-summary-override.js")) {
  if (src.includes("await import('./stream-folder-upload-override.js');")) {
    patchText(
      "await import('./stream-folder-upload-override.js');",
      "await import('./transfer-progress-network-summary-override.js');\nawait import('./transfer-cancel-ipc.js');\nawait import('./stream-folder-upload-override.js');",
      'network summary and cancel import before folder override'
    );
  } else {
    src += "\nawait import('./transfer-progress-network-summary-override.js');\nawait import('./transfer-cancel-ipc.js');\n";
    changed = true;
    console.log('[patch-stream-upload-progress] appended network summary and cancel imports');
  }
} else if (!src.includes("./transfer-cancel-ipc.js")) {
  if (src.includes("await import('./transfer-progress-network-summary-override.js');")) {
    src = src.replace(
      "await import('./transfer-progress-network-summary-override.js');",
      "await import('./transfer-progress-network-summary-override.js');\nawait import('./transfer-cancel-ipc.js');"
    );
    changed = true;
  } else {
    src += "\nawait import('./transfer-cancel-ipc.js');\n";
    changed = true;
  }
}

if (!src.includes('async function rollbackUploadedChunks')) {
  const helper = `
async function rollbackUploadedChunks(uploadedChunks = [], ownerWallet = '', reason = 'upload-cancelled') {
  const n = node();
  for (const entry of uploadedChunks) {
    const hash = entry?.hash;
    if (!hash) continue;
    try {
      dropMemoryChunk(hash);
      const filePath = chunkPath(hash);
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (error) {
      console.warn('[stream-upload] rollback local chunk failed:', hash, error?.message || error);
    }

    for (const peerId of unique(entry.replicas || [])) {
      if (!peerId || peerId === n?.peerId) continue;
      if (peerId === SAFETY_PEER_REPLICA_ID) {
        try { await deleteChunkFromSafetyPeer(hash, n?.peerId || 'desktop-client'); } catch (error) { console.warn('[stream-upload] rollback safety chunk failed:', hash, error?.message || error); }
        continue;
      }
      try {
        const socket = n?.peerSockets?.get?.(peerId);
        n?.send?.(socket, {
          id: crypto.randomUUID(),
          type: 'chunk:delete',
          fromPeerId: n.peerId,
          toPeerId: peerId,
          createdAt: Date.now(),
          payload: { chunkHash: hash, ownerWallet, reason },
        });
      } catch (error) {
        console.warn('[stream-upload] rollback peer chunk delete failed:', hash, peerId, error?.message || error);
      }
    }
  }
}
`;
  patchText(
    "async function replicate(chunk) {",
    helper + "\nasync function replicate(chunk) {",
    'rollback helper'
  );
}

if (!src.includes('let uploadPlainBytes = 0;')) {
  patchText(
    "  if (walletBytes(ownerWallet) + stat.size > quotaBytes(w.planId)) throw new Error('Storage quota exceeded.');",
    "  if (walletBytes(ownerWallet) + stat.size > quotaBytes(w.planId)) throw new Error('Storage quota exceeded.');\n\n  let uploadPlainBytes = 0;\n  let uploadProgressChunksDone = 0;\n  const uploadedChunksForRollback = [];\n  const uploadTotalChunks = Math.max(1, Math.ceil(stat.size / CHUNK_SIZE_BYTES));\n  startTransfer('upload', {\n    fileName: path.basename(filePath),\n    totalBytes: stat.size,\n    totalChunks: uploadTotalChunks,\n    concurrency: 1,\n  });",
    'startTransfer block'
  );
} else if (!src.includes('uploadedChunksForRollback')) {
  src = src.replace(
    '  let uploadProgressChunksDone = 0;\n',
    '  let uploadProgressChunksDone = 0;\n  const uploadedChunksForRollback = [];\n'
  );
  changed = true;
}

if (!src.includes('throwIfTransferCancelled(\'upload\');')) {
  patchRegex(
    /(for await \(const part of fs\.createReadStream\(filePath, \{ highWaterMark: CHUNK_SIZE_BYTES \}\)\) \{\s*)/m,
    "$1\n    throwIfTransferCancelled('upload');\n",
    'cancel check in read loop'
  );
}

if (!src.includes('uploadPlainBytes += plain.length;')) {
  patchRegex(
    /(for await \(const part of fs\.createReadStream\(filePath, \{ highWaterMark: CHUNK_SIZE_BYTES \}\)\) \{\s*(?:throwIfTransferCancelled\('upload'\);\s*)?const plain = Buffer\.from\(part\);\s*)/m,
    "$1\n    uploadPlainBytes += plain.length;\n    updateTransfer('upload', {\n      transferredBytes: Math.min(stat.size, uploadPlainBytes),\n      chunksDone: Math.min(uploadTotalChunks, uploadProgressChunksDone),\n      totalChunks: uploadTotalChunks,\n    });\n",
    'read loop updateTransfer'
  );
}

if (!src.includes('uploadedChunksForRollback.push')) {
  patchRegex(
    /(\n\s*const replicas = await replicate\(chunk\);\s*\n\s*replicas\.forEach\(\(peerId\) => fileReplicas\.add\(peerId\)\);)/m,
    "$1\n    uploadedChunksForRollback.push({ hash, replicas });\n    throwIfTransferCancelled('upload');",
    'rollback tracking after replicate'
  );
}

if (!src.includes('uploadProgressChunksDone += 1;')) {
  patchRegex(
    /(\n\s*dropMemoryChunk\(hash\);\s*\n\s*)index \+= 1;\s*\n\s*}/m,
    "$1uploadProgressChunksDone += 1;\n    updateTransfer('upload', {\n      chunksDone: Math.min(uploadTotalChunks, uploadProgressChunksDone),\n      totalChunks: uploadTotalChunks,\n      transferredBytes: Math.min(stat.size, uploadPlainBytes),\n    });\n    index += 1;\n  }",
    'flush updateTransfer'
  );
}

if (!src.includes("finishTransfer('upload'")) {
  patchRegex(
    /(\n\s*}\s*catch \(syncErr\) \{\s*\n\s*console\.warn\('\[stream-upload\] manifest sync push failed \(non-fatal, will retry on next pull\):', syncErr\?\.message \|\| syncErr\);\s*\n\s*}\s*\n\s*)return manifest;/m,
    "$1finishTransfer('upload', {\n    transferredBytes: stat.size,\n    chunksDone: uploadTotalChunks,\n    totalChunks: uploadTotalChunks,\n  });\n  return manifest;",
    'finishTransfer block'
  );
}

if (!src.includes("rollbackUploadedChunks(uploadedChunksForRollback")) {
  src = src.replace(
    "  if (privateFile) await consume(cipher.final());\n  if (carry.length || chunks.length === 0) await flush(carry);",
    "  try {\n    if (privateFile) await consume(cipher.final());\n    if (carry.length || chunks.length === 0) await flush(carry);\n  } catch (error) {\n    await rollbackUploadedChunks(uploadedChunksForRollback, ownerWallet, error?.code === 'TRANSFER_CANCELLED' ? 'upload-cancelled' : 'upload-failed');\n    throw error;\n  }"
  );
  changed = true;
}

if (!src.includes("failTransfer('upload'")) {
  if (src.includes("ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => uploadFiles(payload));")) {
    src = src.replace(
      "ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => uploadFiles(payload));",
      "ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => {\n  try {\n    return await uploadFiles(payload);\n  } catch (error) {\n    failTransfer('upload', error);\n    throw error;\n  }\n});"
    );
    changed = true;
  }
  if (src.includes("ipcMain.handle('p2p:uploadPath', async (_event, payload = {}) => uploadOne(String(payload.filePath || payload.path || ''), payload));")) {
    src = src.replace(
      "ipcMain.handle('p2p:uploadPath', async (_event, payload = {}) => uploadOne(String(payload.filePath || payload.path || ''), payload));",
      "ipcMain.handle('p2p:uploadPath', async (_event, payload = {}) => {\n  try {\n    return await uploadOne(String(payload.filePath || payload.path || ''), payload);\n  } catch (error) {\n    failTransfer('upload', error);\n    throw error;\n  }\n});"
    );
    changed = true;
  }
}

fs.writeFileSync(file, src, 'utf8');

const checks = {
  start: src.includes("startTransfer('upload'"),
  update: src.includes("updateTransfer('upload'"),
  finish: src.includes("finishTransfer('upload'"),
  bridge: src.includes("transfer-progress-network-summary-override"),
  cancel: src.includes("throwIfTransferCancelled('upload'"),
  rollback: src.includes('rollbackUploadedChunks(uploadedChunksForRollback'),
};
console.log('[patch-stream-upload-progress] checks', checks);

if (!checks.start || !checks.update || !checks.finish || !checks.bridge || !checks.cancel || !checks.rollback) {
  console.warn('[patch-stream-upload-progress] warning: progress/cancel patch incomplete', checks);
} else if (changed) {
  console.log('[patch-stream-upload-progress] patched stream upload progress and cancel rollback');
} else {
  console.log('[patch-stream-upload-progress] already patched');
}
