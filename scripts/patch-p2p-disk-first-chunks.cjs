const fs = require('node:fs');

const file = 'electron/p2p-transport.js';

if (!fs.existsSync(file)) {
  console.log('[p2p-disk-first-chunks] skip missing electron/p2p-transport.js');
  process.exit(0);
}

let s = fs.readFileSync(file, 'utf8');
const before = s;

if (!s.includes('const DEFAULT_CHUNK_MEMORY_CACHE_BYTES')) {
  s = s.replace(
    "const MAX_SEND_QUEUE_MESSAGES = Number(process.env.P2P_MAX_SEND_QUEUE_MESSAGES || 512);",
    "const MAX_SEND_QUEUE_MESSAGES = Number(process.env.P2P_MAX_SEND_QUEUE_MESSAGES || 512);\nconst DEFAULT_CHUNK_MEMORY_CACHE_BYTES = Math.max(0, Number(process.env.P2P_CHUNK_MEMORY_CACHE_BYTES || 128 * 1024 * 1024));"
  );
}

s = s.replace(
  '    this.localChunks = new Map();\n    this.chunkReplicas = new Map();',
  `    this.localChunks = new Map();
    this.localChunkBytes = 0;
    this.chunkMemoryLimitBytes = DEFAULT_CHUNK_MEMORY_CACHE_BYTES;
    this.chunkReplicas = new Map();`
);

if (!s.includes('chunkPayloadBytes(chunk = {})')) {
  s = s.replace(
    "  canStoreChunk(chunk) { const summary = this.refreshStorageSummary(); if (!summary) return { ok: true, summary: null }; const incomingBytes = estimateChunkStorageBytes(chunk); const ok = Boolean(summary.acceptingChunks && summary.remainingSharedBytes >= incomingBytes); return { ok, incomingBytes, summary, reason: ok ? null : `Node storage cap reached or disk pressure active. Mode=${summary.nodeMode}, remaining=${summary.remainingSharedBytes} bytes, incoming=${incomingBytes} bytes, reservedFree=${summary.reservedFreeBytes} bytes.` }; }",
    `  canStoreChunk(chunk) { const summary = this.refreshStorageSummary(); if (!summary) return { ok: true, summary: null }; const incomingBytes = estimateChunkStorageBytes(chunk); const ok = Boolean(summary.acceptingChunks && summary.remainingSharedBytes >= incomingBytes); return { ok, incomingBytes, summary, reason: ok ? null : \`Node storage cap reached or disk pressure active. Mode=\${summary.nodeMode}, remaining=\${summary.remainingSharedBytes} bytes, incoming=\${incomingBytes} bytes, reservedFree=\${summary.reservedFreeBytes} bytes.\` }; }
  chunkPayloadBytes(chunk = {}) { if (!chunk?.data) return 0; if (Buffer.isBuffer(chunk.data)) return chunk.data.length; return Math.ceil(String(chunk.data || '').length * 3 / 4); }
  evictChunkMemoryIfNeeded() { if (!this.chunkMemoryLimitBytes) { this.localChunks.clear(); this.localChunkBytes = 0; return; } while (this.localChunkBytes > this.chunkMemoryLimitBytes && this.localChunks.size) { const oldestKey = this.localChunks.keys().next().value; const oldest = this.localChunks.get(oldestKey); this.localChunkBytes = Math.max(0, this.localChunkBytes - this.chunkPayloadBytes(oldest)); this.localChunks.delete(oldestKey); } }
  cacheChunkInMemory(chunk) { if (!chunk?.hash) return; const bytes = this.chunkPayloadBytes(chunk); if (!this.chunkMemoryLimitBytes || bytes > this.chunkMemoryLimitBytes) return; const existing = this.localChunks.get(chunk.hash); if (existing) this.localChunkBytes = Math.max(0, this.localChunkBytes - this.chunkPayloadBytes(existing)); this.localChunks.delete(chunk.hash); this.localChunks.set(chunk.hash, chunk); this.localChunkBytes += bytes; this.evictChunkMemoryIfNeeded(); }
  dropChunkFromMemory(chunkHash) { const existing = this.localChunks.get(chunkHash); if (!existing) return; this.localChunkBytes = Math.max(0, this.localChunkBytes - this.chunkPayloadBytes(existing)); this.localChunks.delete(chunkHash); }`
  );
}

s = s.replace(
  "  storeLocalChunk(chunk, { enforceCapacity = false } = {}) { if (!chunk?.hash) throw new Error('chunk.hash is required'); if (enforceCapacity) { const decision = this.canStoreChunk(chunk); if (!decision.ok) throw new Error(decision.reason || 'Node storage cap reached'); } this.localChunks.set(chunk.hash, chunk); const filePath = this.chunkPath(chunk.hash); if (filePath) { this.ensureChunkStore(); fs.writeFileSync(filePath, JSON.stringify({ ...chunk, storedAt: new Date().toISOString() }), 'utf8'); this.refreshStorageSummary(); } return chunk; }",
  `  storeLocalChunk(chunk, { enforceCapacity = false } = {}) {
    if (!chunk?.hash) throw new Error('chunk.hash is required');

    if (enforceCapacity) {
      const decision = this.canStoreChunk(chunk);
      if (!decision.ok) throw new Error(decision.reason || 'Node storage cap reached');
    }

    const filePath = this.chunkPath(chunk.hash);

    if (filePath) {
      this.ensureChunkStore();
      fs.writeFileSync(filePath, JSON.stringify({ ...chunk, storedAt: new Date().toISOString() }), 'utf8');
      this.refreshStorageSummary();
      this.cacheChunkInMemory(chunk);
    } else {
      this.cacheChunkInMemory(chunk);
    }

    return chunk;
  }`
);

s = s.replace(
  "  getLocalChunk(chunkHash) { const memoryChunk = this.localChunks.get(chunkHash); if (memoryChunk) return memoryChunk; const filePath = this.chunkPath(chunkHash); if (!filePath || !fs.existsSync(filePath)) return null; try { const chunk = JSON.parse(fs.readFileSync(filePath, 'utf8')); if (chunk?.hash) { this.localChunks.set(chunk.hash, chunk); return chunk; } } catch {} return null; }",
  `  getLocalChunk(chunkHash) {
    const memoryChunk = this.localChunks.get(chunkHash);
    if (memoryChunk) {
      this.localChunks.delete(chunkHash);
      this.localChunks.set(chunkHash, memoryChunk);
      return memoryChunk;
    }

    const filePath = this.chunkPath(chunkHash);
    if (!filePath || !fs.existsSync(filePath)) return null;

    try {
      const chunk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (chunk?.hash) {
        this.cacheChunkInMemory(chunk);
        return chunk;
      }
    } catch {}

    return null;
  }`
);

if (s !== before) {
  fs.writeFileSync(file, s, 'utf8');
  console.log('[p2p-disk-first-chunks] applied disk-first bounded chunk memory cache');
} else {
  console.log('[p2p-disk-first-chunks] already applied');
}
