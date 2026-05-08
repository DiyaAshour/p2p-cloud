const fs = require('node:fs');

function patch(file, fn) {
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8');
    console.log(`[fix-startup-memory-oom] patched ${file}`);
  } else {
    console.log(`[fix-startup-memory-oom] ok ${file}`);
  }
}

patch('electron/p2p-transport.js', (source) => {
  let s = source;

  if (!s.includes('hasLocalChunk(chunkHash)')) {
    s = s.replace(
      /\n  getLocalChunk\(chunkHash\) \{/,
      `
  hasLocalChunk(chunkHash) {
    if (!chunkHash) return false;
    if (this.localChunks.has(chunkHash)) return true;
    const filePath = this.chunkPath(chunkHash);
    return Boolean(filePath && fs.existsSync(filePath));
  }

  getLocalChunk(chunkHash) {`
    );
  }

  s = s.replace(
    /  storeLocalChunk\(chunk\) \{\n    if \(!chunk\?\.hash\) throw new Error\('chunk.hash is required'\);\n    this\.localChunks\.set\(chunk\.hash, chunk\);\n    const filePath = this\.chunkPath\(chunk\.hash\);\n    if \(filePath\) \{\n      this\.ensureChunkStore\(\);\n      fs\.writeFileSync\(filePath, JSON\.stringify\(\{ \.\.\.chunk, storedAt: new Date\(\)\.toISOString\(\) \}\), 'utf8'\);\n    \}\n    return chunk;\n  \}/,
    `  storeLocalChunk(chunk) {
    if (!chunk?.hash) throw new Error('chunk.hash is required');
    const filePath = this.chunkPath(chunk.hash);
    if (filePath) {
      this.ensureChunkStore();
      fs.writeFileSync(filePath, JSON.stringify({ ...chunk, storedAt: new Date().toISOString() }), 'utf8');
    }
    // Do not keep large chunk payloads in JS heap. Keeping every chunk in memory
    // makes the app crash on startup/large uploads. The disk chunk store is the source of truth.
    const dataSize = typeof chunk.data === 'string' ? chunk.data.length : Buffer.isBuffer(chunk.data) ? chunk.data.length : 0;
    if (dataSize <= Number(process.env.P2P_MEMORY_CHUNK_CACHE_MAX_BYTES || 262144)) {
      this.localChunks.set(chunk.hash, chunk);
    } else {
      this.localChunks.delete(chunk.hash);
    }
    return chunk;
  }`
  );

  s = s.replace(
    /      if \(chunk\?\.hash\) \{\n        this\.localChunks\.set\(chunk\.hash, chunk\);\n        return chunk;\n      \}/,
    `      if (chunk?.hash) {
        const dataSize = typeof chunk.data === 'string' ? chunk.data.length : Buffer.isBuffer(chunk.data) ? chunk.data.length : 0;
        if (dataSize <= Number(process.env.P2P_MEMORY_CHUNK_CACHE_MAX_BYTES || 262144)) this.localChunks.set(chunk.hash, chunk);
        return chunk;
      }`
  );

  return s;
});

patch('electron/replication-engine.js', (source) => {
  let s = source;
  s = s.replace(
    "  if (node?.getLocalChunk?.(chunkHash)) replicas.add(node.peerId);",
    "  if (node?.hasLocalChunk?.(chunkHash) || node?.getLocalChunk?.(chunkHash)) replicas.add(node.peerId);"
  );
  return s;
});

console.log('[fix-startup-memory-oom] complete');
