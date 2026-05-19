import fs from 'node:fs';
import { P2PTransportNode } from './p2p-transport.js';

const CACHE_IN_MEMORY = /^(1|true|yes)$/i.test(String(process.env.P2P_CACHE_CHUNKS_IN_MEMORY || ''));
const MAX_MEMORY_CHUNKS = Math.max(0, Number(process.env.P2P_MAX_MEMORY_CHUNKS || 16));

function rememberChunk(node, chunk) {
  if (!CACHE_IN_MEMORY || !chunk?.hash || MAX_MEMORY_CHUNKS <= 0) {
    try { node.localChunks?.delete?.(chunk?.hash); } catch {}
    return;
  }

  node.localChunks.set(chunk.hash, chunk);

  while (node.localChunks.size > MAX_MEMORY_CHUNKS) {
    const oldest = node.localChunks.keys().next().value;
    if (!oldest) break;
    node.localChunks.delete(oldest);
  }
}

if (!P2PTransportNode.prototype.__chunknetDiskFirstCachePatched) {
  P2PTransportNode.prototype.storeLocalChunk = function storeLocalChunkDiskFirst(chunk, { enforceCapacity = false } = {}) {
    if (!chunk?.hash) throw new Error('chunk.hash is required');

    if (enforceCapacity) {
      const decision = this.canStoreChunk(chunk);
      if (!decision.ok) throw new Error(decision.reason || 'Node storage cap reached');
    }

    const filePath = this.chunkPath(chunk.hash);
    if (filePath) {
      this.ensureChunkStore();
      fs.writeFileSync(filePath, JSON.stringify({ ...chunk, storedAt: new Date().toISOString() }), 'utf8');
      try { this.refreshStorageSummary(); } catch {}
    }

    rememberChunk(this, chunk);
    return chunk;
  };

  P2PTransportNode.prototype.getLocalChunk = function getLocalChunkDiskFirst(chunkHash) {
    if (CACHE_IN_MEMORY) {
      const memoryChunk = this.localChunks.get(chunkHash);
      if (memoryChunk) return memoryChunk;
    }

    const filePath = this.chunkPath(chunkHash);
    if (!filePath || !fs.existsSync(filePath)) return null;

    try {
      const chunk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!chunk?.hash) return null;
      rememberChunk(this, chunk);
      return chunk;
    } catch {
      return null;
    }
  };

  Object.defineProperty(P2PTransportNode.prototype, '__chunknetDiskFirstCachePatched', {
    value: true,
    enumerable: false,
    configurable: false,
  });

  console.log('[p2p-transport] disk-first chunk cache installed', {
    cacheInMemory: CACHE_IN_MEMORY,
    maxMemoryChunks: CACHE_IN_MEMORY ? MAX_MEMORY_CHUNKS : 0,
  });
}
