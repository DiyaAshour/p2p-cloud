const fs = require('node:fs');

const file = 'electron/p2p-transport.js';

if (!fs.existsSync(file)) {
  console.log('[fast-storage-summary] skip missing electron/p2p-transport.js');
  process.exit(0);
}

let s = fs.readFileSync(file, 'utf8');
const before = s;

const oldRefresh = "  refreshStorageSummary() { if (!this.chunkStoreDir) return null; this.ensureChunkStore(); const disk = inspectDiskSpace(this.chunkStoreDir); const usedBytes = directorySizeSync(this.chunkStoreDir); this.lastStorageSummary = calculateNodeStorage({ totalBytes: disk.totalBytes, freeBytes: disk.freeBytes, usedBytes, policy: this.storagePolicy }); this.lastStorageSummary = { ...this.lastStorageSummary, ok: disk.ok && this.lastStorageSummary.ok, error: disk.error || null, chunkStoreDir: this.chunkStoreDir }; return this.lastStorageSummary; }";

const newRefresh = `  refreshStorageSummary({ forceScan = false } = {}) {
    if (!this.chunkStoreDir) return null;

    const now = Date.now();
    const cacheMs = Math.max(5_000, Number(process.env.P2P_STORAGE_SUMMARY_CACHE_MS || 60_000));

    if (!forceScan && this.lastStorageSummary && this.lastStorageSummaryCheckedAt && now - this.lastStorageSummaryCheckedAt < cacheMs) {
      return this.lastStorageSummary;
    }

    this.ensureChunkStore();

    const disk = inspectDiskSpace(this.chunkStoreDir);
    const allowFullScan = forceScan || String(process.env.P2P_STORAGE_FULL_SCAN || '').toLowerCase() === '1' || String(process.env.P2P_STORAGE_FULL_SCAN || '').toLowerCase() === 'true';
    const usedBytes = allowFullScan ? directorySizeSync(this.chunkStoreDir) : Number(this.lastStorageSummary?.usedBytes || 0);

    this.lastStorageSummary = calculateNodeStorage({
      totalBytes: disk.totalBytes,
      freeBytes: disk.freeBytes,
      usedBytes,
      policy: this.storagePolicy,
    });

    this.lastStorageSummary = {
      ...this.lastStorageSummary,
      ok: disk.ok && this.lastStorageSummary.ok,
      error: disk.error || null,
      chunkStoreDir: this.chunkStoreDir,
      fullScan: allowFullScan,
    };

    this.lastStorageSummaryCheckedAt = now;
    return this.lastStorageSummary;
  }`;

if (s.includes(oldRefresh)) {
  s = s.replace(oldRefresh, newRefresh);
} else if (!s.includes('P2P_STORAGE_FULL_SCAN')) {
  throw new Error('[fast-storage-summary] refreshStorageSummary anchor not found');
}

const oldStore = "  storeLocalChunk(chunk, { enforceCapacity = false } = {}) { if (!chunk?.hash) throw new Error('chunk.hash is required'); if (enforceCapacity) { const decision = this.canStoreChunk(chunk); if (!decision.ok) throw new Error(decision.reason || 'Node storage cap reached'); } this.localChunks.set(chunk.hash, chunk); const filePath = this.chunkPath(chunk.hash); if (filePath) { this.ensureChunkStore(); fs.writeFileSync(filePath, JSON.stringify({ ...chunk, storedAt: new Date().toISOString() }), 'utf8'); this.refreshStorageSummary(); } return chunk; }";

const newStore = `  storeLocalChunk(chunk, { enforceCapacity = false } = {}) {
    if (!chunk?.hash) throw new Error('chunk.hash is required');

    if (enforceCapacity) {
      const decision = this.canStoreChunk(chunk);
      if (!decision.ok) throw new Error(decision.reason || 'Node storage cap reached');
    }

    this.localChunks.set(chunk.hash, chunk);

    const filePath = this.chunkPath(chunk.hash);

    if (filePath) {
      this.ensureChunkStore();
      const serialized = JSON.stringify({ ...chunk, storedAt: new Date().toISOString() });
      fs.writeFileSync(filePath, serialized, 'utf8');

      if (this.lastStorageSummary) {
        const addedBytes = Buffer.byteLength(serialized, 'utf8');
        const usedBytes = Math.max(0, Number(this.lastStorageSummary.usedBytes || 0) + addedBytes);
        const remainingSharedBytes = Math.max(0, Number(this.lastStorageSummary.remainingSharedBytes || 0) - addedBytes);

        this.lastStorageSummary = {
          ...this.lastStorageSummary,
          usedBytes,
          remainingSharedBytes,
          acceptingChunks: remainingSharedBytes > 0,
          checkedAt: new Date().toISOString(),
        };
      } else {
        this.refreshStorageSummary();
      }
    }

    return chunk;
  }`;

if (s.includes(oldStore)) {
  s = s.replace(oldStore, newStore);
} else if (!s.includes('const serialized = JSON.stringify({ ...chunk, storedAt: new Date().toISOString() });')) {
  throw new Error('[fast-storage-summary] storeLocalChunk anchor not found');
}

if (s !== before) {
  fs.writeFileSync(file, s, 'utf8');
  console.log('[fast-storage-summary] applied cached storage summary and removed repeated full directory scans');
} else {
  console.log('[fast-storage-summary] already applied');
}
