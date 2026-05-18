const fs = require('node:fs');

const file = 'electron/p2p-transport.js';

if (!fs.existsSync(file)) {
  console.log('[fast-storage-summary] skip missing electron/p2p-transport.js');
  process.exit(0);
}

let s = fs.readFileSync(file, 'utf8');
const before = s;

const newRefresh = `  refreshStorageSummary({ forceScan = false } = {}) {
    if (!this.chunkStoreDir) return null;

    const now = Date.now();
    const cacheMs = Math.max(5_000, Number(process.env.P2P_STORAGE_SUMMARY_CACHE_MS || 60_000));

    if (!forceScan && this.lastStorageSummary && this.lastStorageSummaryCheckedAt && now - this.lastStorageSummaryCheckedAt < cacheMs) {
      return this.lastStorageSummary;
    }

    this.ensureChunkStore();

    const disk = inspectDiskSpace(this.chunkStoreDir);
    const fullScanValue = String(process.env.P2P_STORAGE_FULL_SCAN || '').toLowerCase();
    const allowFullScan = forceScan || fullScanValue === '1' || fullScanValue === 'true';
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

if (!s.includes('P2P_STORAGE_FULL_SCAN')) {
  const refreshPattern = /  refreshStorageSummary\([^)]*\) \{[\s\S]*?\n  canStoreChunk\(/;
  if (refreshPattern.test(s)) {
    s = s.replace(refreshPattern, `${newRefresh}\n  canStoreChunk(`);
    console.log('[fast-storage-summary] patched refreshStorageSummary');
  } else {
    console.warn('[fast-storage-summary] refreshStorageSummary anchor not found; skipping refresh patch');
  }
} else {
  console.log('[fast-storage-summary] refreshStorageSummary already patched');
}

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
        const previousFileBytes = fs.existsSync(filePath) ? 0 : 0;
        const addedBytes = Buffer.byteLength(serialized, 'utf8') - previousFileBytes;
        const usedBytes = Math.max(0, Number(this.lastStorageSummary.usedBytes || 0) + Math.max(0, addedBytes));
        const remainingSharedBytes = Math.max(0, Number(this.lastStorageSummary.remainingSharedBytes || 0) - Math.max(0, addedBytes));

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

if (!s.includes('const serialized = JSON.stringify({ ...chunk, storedAt: new Date().toISOString() });')) {
  const storePattern = /  storeLocalChunk\(chunk, \{ enforceCapacity = false \} = \{\}\) \{[\s\S]*?\n  getLocalChunk\(/;
  if (storePattern.test(s)) {
    s = s.replace(storePattern, `${newStore}\n  getLocalChunk(`);
    console.log('[fast-storage-summary] patched storeLocalChunk');
  } else {
    console.warn('[fast-storage-summary] storeLocalChunk anchor not found; skipping store patch');
  }
} else {
  console.log('[fast-storage-summary] storeLocalChunk already patched');
}

if (s !== before) {
  fs.writeFileSync(file, s, 'utf8');
  console.log('[fast-storage-summary] complete');
} else {
  console.log('[fast-storage-summary] already applied or skipped safely');
}
