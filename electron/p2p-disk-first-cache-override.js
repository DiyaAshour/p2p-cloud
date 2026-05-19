import fs from 'node:fs';
import path from 'node:path';
import { P2PTransportNode } from './p2p-transport.js';
import { calculateNodeStorage, defaultNodeStoragePolicy, estimateChunkStorageBytes, inspectDiskSpace } from './storage-capacity.js';

const CACHE_IN_MEMORY = /^(1|true|yes)$/i.test(String(process.env.P2P_CACHE_CHUNKS_IN_MEMORY || ''));
const MAX_MEMORY_CHUNKS = Math.max(0, Number(process.env.P2P_MAX_MEMORY_CHUNKS || 16));
const FAST_STORAGE_ESTIMATE = !/^(0|false|no)$/i.test(String(process.env.P2P_FAST_STORAGE_ESTIMATE || '1'));
const STORAGE_CACHE_MAX_AGE_MS = Math.max(5000, Number(process.env.P2P_STORAGE_CACHE_MAX_AGE_MS || 60_000));

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

function storageCachePath(node) {
  if (!node?.chunkStoreDir) return null;
  return path.join(path.dirname(node.chunkStoreDir), 'storage-usage-cache.json');
}

function readStorageCache(node) {
  try {
    const file = storageCachePath(node);
    if (!file || !fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || Date.now() - Number(parsed.checkedAtMs || 0) > STORAGE_CACHE_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStorageCache(node, usedBytes) {
  try {
    const file = storageCachePath(node);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ usedBytes: Math.max(0, Number(usedBytes || 0)), checkedAtMs: Date.now() }, null, 2), 'utf8');
  } catch {}
}

function addStorageUsage(node, deltaBytes) {
  const cached = readStorageCache(node) || { usedBytes: node?.lastStorageSummary?.usedBytes || 0 };
  writeStorageCache(node, Number(cached.usedBytes || 0) + Number(deltaBytes || 0));
}

function fastRefreshStorageSummary(node) {
  if (!node?.chunkStoreDir) return null;
  node.ensureChunkStore?.();
  const disk = inspectDiskSpace(node.chunkStoreDir);
  const cached = readStorageCache(node);
  const usedBytes = cached ? Number(cached.usedBytes || 0) : Number(node.lastStorageSummary?.usedBytes || 0);
  node.lastStorageSummary = calculateNodeStorage({
    totalBytes: disk.totalBytes,
    freeBytes: disk.freeBytes,
    usedBytes,
    policy: node.storagePolicy || defaultNodeStoragePolicy(),
  });
  node.lastStorageSummary = { ...node.lastStorageSummary, ok: disk.ok && node.lastStorageSummary.ok, error: disk.error || null, chunkStoreDir: node.chunkStoreDir, estimated: true };
  return node.lastStorageSummary;
}

if (!P2PTransportNode.prototype.__chunknetDiskFirstCachePatched) {
  if (FAST_STORAGE_ESTIMATE) {
    P2PTransportNode.prototype.refreshStorageSummary = function refreshStorageSummaryFast() {
      return fastRefreshStorageSummary(this);
    };
  }

  P2PTransportNode.prototype.storeLocalChunk = function storeLocalChunkDiskFirst(chunk, { enforceCapacity = false } = {}) {
    if (!chunk?.hash) throw new Error('chunk.hash is required');

    if (enforceCapacity) {
      const decision = this.canStoreChunk(chunk);
      if (!decision.ok) throw new Error(decision.reason || 'Node storage cap reached');
    }

    const filePath = this.chunkPath(chunk.hash);
    if (filePath) {
      this.ensureChunkStore();
      const existed = fs.existsSync(filePath);
      fs.writeFileSync(filePath, JSON.stringify({ ...chunk, storedAt: new Date().toISOString() }), 'utf8');
      if (!existed) addStorageUsage(this, estimateChunkStorageBytes(chunk));
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
    fastStorageEstimate: FAST_STORAGE_ESTIMATE,
  });
}
