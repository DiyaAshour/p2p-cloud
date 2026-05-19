const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const file = path.join(root, 'server', 'storage-peer.js');

if (!fs.existsSync(file)) {
  throw new Error(`storage-peer.js not found: ${file}`);
}

let src = fs.readFileSync(file, 'utf8');

function replaceOnce(find, replacement, label) {
  if (!src.includes(find)) {
    console.log(`[patch-storage-peer-safety-delete] ${label} already patched or anchor missing`);
    return false;
  }
  src = src.replace(find, replacement);
  console.log(`[patch-storage-peer-safety-delete] patched ${label}`);
  return true;
}

replaceOnce(
  "const MAX_GETS_PER_MINUTE = Number(process.env.STORAGE_PEER_MAX_GETS_PER_MINUTE || 600);\nconst PUBLIC_DISPLAY_URL = 'Network route';",
  "const MAX_GETS_PER_MINUTE = Number(process.env.STORAGE_PEER_MAX_GETS_PER_MINUTE || 600);\nconst MAX_DELETES_PER_MINUTE = Number(process.env.STORAGE_PEER_MAX_DELETES_PER_MINUTE || 240);\nconst STORAGE_PEER_DELETE_TOKEN = String(process.env.STORAGE_PEER_DELETE_TOKEN || process.env.P2P_SAFETY_PEER_DELETE_TOKEN || '').trim();\nconst PUBLIC_DISPLAY_URL = 'Network route';",
  'delete env config'
);

replaceOnce(
  "function chunkPath(hash) {\n  const clean = String(hash || '').replace(/[^a-fA-F0-9]/g, '');\n  if (!/^[a-fA-F0-9]{64}$/.test(clean)) throw new Error('Invalid chunk hash');\n  return path.join(CHUNKS_DIR, `${clean}.json`);\n}",
  "function normalizeChunkHash(hash) {\n  const clean = String(hash || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();\n  if (!/^[a-f0-9]{64}$/.test(clean)) throw new Error('Invalid chunk hash');\n  return clean;\n}\n\nfunction chunkPath(hash) {\n  const clean = normalizeChunkHash(hash);\n  return path.join(CHUNKS_DIR, `${clean}.json`);\n}",
  'chunk hash normalizer'
);

replaceOnce(
  "  const key = type === 'get' ? 'getRate' : 'putRate';\n  const limit = type === 'get' ? MAX_GETS_PER_MINUTE : MAX_PUTS_PER_MINUTE;",
  "  const key = type === 'get' ? 'getRate' : type === 'delete' ? 'deleteRate' : 'putRate';\n  const limit = type === 'get' ? MAX_GETS_PER_MINUTE : type === 'delete' ? MAX_DELETES_PER_MINUTE : MAX_PUTS_PER_MINUTE;",
  'delete rate limit'
);

replaceOnce(
  "  const hash = String(chunk.hash).toLowerCase();\n  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid chunk hash');",
  "  const hash = normalizeChunkHash(chunk.hash);",
  'validate hash normalizer'
);

replaceOnce(
  "function loadChunk(hash) {\n  const file = chunkPath(hash);\n  if (!fs.existsSync(file)) return null;\n  try {\n    const chunk = JSON.parse(fs.readFileSync(file, 'utf8'));\n    validateChunk(chunk);\n    return chunk;\n  } catch {\n    return null;\n  }\n}\n\nfunction send(socket, message) {",
  "function loadChunk(hash) {\n  const file = chunkPath(hash);\n  if (!fs.existsSync(file)) return null;\n  try {\n    const chunk = JSON.parse(fs.readFileSync(file, 'utf8'));\n    validateChunk(chunk);\n    return chunk;\n  } catch {\n    return null;\n  }\n}\n\nfunction removeSafetyChunk(hash) {\n  const clean = normalizeChunkHash(hash);\n  const file = chunkPath(clean);\n  const existed = fs.existsSync(file);\n  if (existed) fs.unlinkSync(file);\n  const index = readIndex();\n  if (index[clean]) {\n    delete index[clean];\n    writeIndex(index);\n  }\n  return { hash: clean, existed };\n}\n\nfunction assertSafetyDeleteAllowed(payload = {}) {\n  if (!STORAGE_PEER_DELETE_TOKEN) return;\n  const token = String(payload.deleteToken || payload.adminToken || '').trim();\n  if (token !== STORAGE_PEER_DELETE_TOKEN) throw new Error('Invalid safety peer delete token');\n}\n\nfunction send(socket, message) {",
  'remove safety chunk helper'
);

replaceOnce(
  "  if (message.type === 'chunk:get') {\n    try {\n      peerBucket(socket, 'get');\n      const chunkHash = String(message.payload?.chunkHash || '').toLowerCase();\n      if (!/^[a-f0-9]{64}$/.test(chunkHash)) throw new Error('Invalid chunk hash');",
  "  if (message.type === 'chunk:get') {\n    try {\n      peerBucket(socket, 'get');\n      const chunkHash = normalizeChunkHash(message.payload?.chunkHash || '');",
  'get hash normalizer'
);

replaceOnce(
  "  }\n}\n\nfunction registerWithBootstrap() {",
  "  }\n\n  if (message.type === 'chunk:delete') {\n    try {\n      peerBucket(socket, 'delete');\n      assertSafetyDeleteAllowed(message.payload || {});\n      const removed = removeSafetyChunk(message.payload?.chunkHash || '');\n      send(socket, {\n        id: crypto.randomUUID(),\n        type: removed.existed ? 'chunk:deleted' : 'chunk:not-found',\n        fromPeerId: PEER_ID,\n        toPeerId: message.fromPeerId,\n        createdAt: Date.now(),\n        payload: { chunkHash: removed.hash },\n      });\n      console.log('[storage-peer]', removed.existed ? 'deleted safety chunk' : 'safety chunk already missing', removed.hash);\n    } catch (error) {\n      send(socket, {\n        id: crypto.randomUUID(),\n        type: 'chunk:error',\n        fromPeerId: PEER_ID,\n        toPeerId: message.fromPeerId,\n        createdAt: Date.now(),\n        error: error?.message || 'Failed to delete safety chunk',\n      });\n    }\n    return;\n  }\n}\n\nfunction registerWithBootstrap() {",
  'chunk delete handler'
);

replaceOnce(
  "console.log(`[storage-peer] max chunk bytes: ${MAX_CHUNK_BYTES}`);",
  "console.log(`[storage-peer] max chunk bytes: ${MAX_CHUNK_BYTES}`);\nconsole.log(`[storage-peer] safety delete: ${STORAGE_PEER_DELETE_TOKEN ? 'token-required' : 'token-not-set'}`);",
  'delete status log'
);

fs.writeFileSync(file, src, 'utf8');
console.log('[patch-storage-peer-safety-delete] done');
