const fs = require('node:fs');

function patchMainWrapper() {
  const file = 'electron/main-wrapper.js';
  if (!fs.existsSync(file)) return console.warn('[hard-delete-runtime] missing', file);
  let s = fs.readFileSync(file, 'utf8');
  const before = s;
  const anchor = "    await import('./download-to-path-override.js');\n    console.log('[main-wrapper] download override import finished');";
  const replacement = `${anchor}\n    await import('./hard-delete-override.js');\n    console.log('[main-wrapper] hard delete override import finished');`;
  if (!s.includes("./hard-delete-override.js")) s = s.replace(anchor, replacement);
  if (s !== before) {
    fs.writeFileSync(file, s, 'utf8');
    console.log('[hard-delete-runtime] patched main-wrapper import');
  } else {
    console.log('[hard-delete-runtime] main-wrapper already patched');
  }
}

function patchTransportDeleteMessage() {
  const file = 'electron/p2p-transport.js';
  if (!fs.existsSync(file)) return console.warn('[hard-delete-runtime] missing', file);
  let s = fs.readFileSync(file, 'utf8');
  const before = s;

  if (!s.includes('deleteLocalChunk(chunkHash)')) {
    const anchor = "  getLocalChunk(chunkHash) { const memoryChunk = this.localChunks.get(chunkHash); if (memoryChunk) return memoryChunk; const filePath = this.chunkPath(chunkHash); if (!filePath || !fs.existsSync(filePath)) return null; try { const chunk = JSON.parse(fs.readFileSync(filePath, 'utf8')); if (chunk?.hash) { this.localChunks.set(chunk.hash, chunk); return chunk; } } catch {} return null; }";
    const insert = `${anchor}\n  deleteLocalChunk(chunkHash) { if (!chunkHash) return false; this.localChunks.delete(chunkHash); this.chunkReplicas.delete(chunkHash); const filePath = this.chunkPath(chunkHash); if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); this.refreshStorageSummary(); return true; }`;
    s = s.replace(anchor, insert);
  }

  if (!s.includes("message.type === 'chunk:delete'")) {
    const anchor = "if (message.type === 'chunk:get') {";
    const insert = `if (message.type === 'chunk:delete') { const chunkHash = message.payload?.chunkHash; try { const deleted = this.deleteLocalChunk(chunkHash); this.send(socket, { id: crypto.randomUUID(), type: 'chunk:deleted', fromPeerId: this.peerId, toPeerId: message.fromPeerId, createdAt: Date.now(), payload: { chunkHash, deleted } }); this.broadcastToUi({ type: 'chunk:deleted', chunkHash, fromPeerId: message.fromPeerId, deleted }); } catch (error) { this.send(socket, { id: crypto.randomUUID(), type: 'chunk:error', fromPeerId: this.peerId, toPeerId: message.fromPeerId, createdAt: Date.now(), payload: { chunkHash }, error: error?.message || String(error) }); } return; } ${anchor}`;
    s = s.replace(anchor, insert);
  }

  if (s !== before) {
    fs.writeFileSync(file, s, 'utf8');
    console.log('[hard-delete-runtime] patched p2p transport chunk delete');
  } else {
    console.log('[hard-delete-runtime] p2p transport already patched');
  }
}

patchMainWrapper();
patchTransportDeleteMessage();
