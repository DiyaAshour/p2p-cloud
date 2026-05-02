import CryptoJS from 'crypto-js';

export interface ChunkRecord {
  index: number;
  hash: string;
  size: number;
  encryptedData: string;
  peers: string[];
}

export interface FileManifest {
  version: 1;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileHash: string;
  chunkSize: number;
  encrypted: boolean;
  createdAt: number;
  ownerPeerId: string;
  chunks: Array<{
    index: number;
    hash: string;
    size: number;
    peers: string[];
  }>;
}

const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const DEFAULT_KEY_PREFIX = 'p2p-cloud-local-key';

class P2PChunkService {
  async createManifestFromFile(
    file: File,
    ownerPeerId: string,
    encryptionKey = DEFAULT_KEY_PREFIX,
    chunkSize = DEFAULT_CHUNK_SIZE
  ): Promise<{ manifest: FileManifest; chunks: ChunkRecord[]; fileBuffer: ArrayBuffer }> {
    const fileBuffer = await file.arrayBuffer();
    const fileHash = await this.hashBuffer(fileBuffer);
    const chunks: ChunkRecord[] = [];

    for (let offset = 0, index = 0; offset < fileBuffer.byteLength; offset += chunkSize, index++) {
      const rawChunk = fileBuffer.slice(offset, Math.min(offset + chunkSize, fileBuffer.byteLength));
      const chunkHash = await this.hashBuffer(rawChunk);
      const encryptedData = this.encryptBuffer(rawChunk, this.deriveChunkKey(encryptionKey, fileHash, index));

      chunks.push({
        index,
        hash: chunkHash,
        size: rawChunk.byteLength,
        encryptedData,
        peers: [ownerPeerId],
      });
    }

    const manifest: FileManifest = {
      version: 1,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      fileSize: file.size,
      fileHash,
      chunkSize,
      encrypted: true,
      createdAt: Date.now(),
      ownerPeerId,
      chunks: chunks.map(({ index, hash, size, peers }) => ({ index, hash, size, peers })),
    };

    return { manifest, chunks, fileBuffer };
  }

  async reconstructFile(
    manifest: FileManifest,
    chunks: ChunkRecord[],
    encryptionKey = DEFAULT_KEY_PREFIX
  ): Promise<File> {
    const orderedChunks = [...chunks].sort((a, b) => a.index - b.index);

    if (orderedChunks.length !== manifest.chunks.length) {
      throw new Error(`Missing chunks. Have ${orderedChunks.length}, need ${manifest.chunks.length}`);
    }

    const decryptedParts: Uint8Array[] = [];

    for (const chunk of orderedChunks) {
      const expected = manifest.chunks[chunk.index];
      if (!expected || expected.hash !== chunk.hash) {
        throw new Error(`Chunk manifest mismatch at index ${chunk.index}`);
      }

      const decrypted = this.decryptToBuffer(chunk.encryptedData, this.deriveChunkKey(encryptionKey, manifest.fileHash, chunk.index));
      const hash = await this.hashBuffer(decrypted);

      if (hash !== chunk.hash) {
        throw new Error(`Chunk integrity check failed at index ${chunk.index}`);
      }

      decryptedParts.push(new Uint8Array(decrypted));
    }

    const combined = this.concatUint8Arrays(decryptedParts);
    const rebuiltHash = await this.hashBuffer(combined.buffer);

    if (rebuiltHash !== manifest.fileHash) {
      throw new Error('File integrity check failed after reconstruction');
    }

    const blob = new Blob([combined], { type: manifest.mimeType });
    return new File([blob], manifest.fileName, { type: manifest.mimeType });
  }

  private encryptBuffer(buffer: ArrayBuffer, key: string): string {
    const wordArray = this.arrayBufferToWordArray(buffer);
    return CryptoJS.AES.encrypt(wordArray.toString(CryptoJS.enc.Base64), key).toString();
  }

  private decryptToBuffer(encryptedData: string, key: string): ArrayBuffer {
    const decrypted = CryptoJS.AES.decrypt(encryptedData, key).toString(CryptoJS.enc.Utf8);
    if (!decrypted) {
      throw new Error('Failed to decrypt chunk');
    }

    return this.base64ToArrayBuffer(decrypted);
  }

  private deriveChunkKey(baseKey: string, fileHash: string, index: number): string {
    return CryptoJS.SHA256(`${baseKey}:${fileHash}:${index}`).toString();
  }

  async hashBuffer(buffer: ArrayBuffer): Promise<string> {
    if (crypto?.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    }

    return CryptoJS.SHA256(this.arrayBufferToWordArray(buffer)).toString();
  }

  private arrayBufferToWordArray(buffer: ArrayBuffer): CryptoJS.lib.WordArray {
    const bytes = new Uint8Array(buffer);
    const words: number[] = [];

    for (let i = 0; i < bytes.length; i++) {
      words[i >>> 2] |= bytes[i] << (24 - (i % 4) * 8);
    }

    return CryptoJS.lib.WordArray.create(words, bytes.length);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes.buffer;
  }

  private concatUint8Arrays(parts: Uint8Array[]): Uint8Array {
    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;

    for (const part of parts) {
      combined.set(part, offset);
      offset += part.length;
    }

    return combined;
  }
}

export const p2pChunkService = new P2PChunkService();
