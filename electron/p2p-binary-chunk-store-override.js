import { P2PTransportNode } from './p2p-transport.js';
import { readChunkRecord, writeChunkRecord } from './core/chunk-store.js';

if (!P2PTransportNode.prototype.__binaryChunkStorePatched) {
  P2PTransportNode.prototype.storeLocalChunk = function storeLocalChunkBinary(chunk, { enforceCapacity = false } = {}) {
    if (!chunk?.hash) throw new Error('chunk.hash is required');
    if (enforceCapacity) {
      const decision = this.canStoreChunk(chunk);
      if (!decision.ok) throw new Error(decision.reason || 'Node storage cap reached');
    }

    this.localChunks.set(chunk.hash, chunk);
    if (this.chunkStoreDir) {
      writeChunkRecord(chunk);
      this.refreshStorageSummary();
    }
    return chunk;
  };

  P2PTransportNode.prototype.getLocalChunk = function getLocalChunkBinary(chunkHash) {
    const memoryChunk = this.localChunks.get(chunkHash);
    if (memoryChunk) return memoryChunk;

    const chunk = readChunkRecord(chunkHash);
    if (chunk?.hash) {
      this.localChunks.set(chunk.hash, chunk);
      return chunk;
    }
    return null;
  };

  P2PTransportNode.prototype.__binaryChunkStorePatched = true;
  console.log('[p2p-binary-chunk-store] patched transport local chunk store with binary-v1 compatibility');
}
