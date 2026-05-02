import fs from "fs";
import path from "path";
import crypto from "node:crypto";

export type ChunkInfo = {
  index: number;
  hash: string;
  size: number;
  replicas: string[];
};

export type ChunkManifest = {
  fileHash: string;
  fileName: string;
  fileSize: number;
  chunkSize: number;
  chunks: ChunkInfo[];
};

export function hashBuffer(buffer: Buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function hashFile(filePath: string) {
  return hashBuffer(fs.readFileSync(filePath));
}

export function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function getChunkPath(chunksDir: string, chunkHash: string) {
  return path.join(chunksDir, chunkHash);
}

export function splitFileIntoChunks(options: {
  filePath: string;
  fileName: string;
  fileSize: number;
  chunkSize: number;
  chunksDir: string;
  localNodeId: string;
}): ChunkManifest {
  ensureDir(options.chunksDir);

  const fileBuffer = fs.readFileSync(options.filePath);
  const fileHash = hashBuffer(fileBuffer);
  const chunks: ChunkInfo[] = [];

  for (let offset = 0, index = 0; offset < fileBuffer.length; offset += options.chunkSize, index += 1) {
    const chunkBuffer = fileBuffer.subarray(offset, Math.min(offset + options.chunkSize, fileBuffer.length));
    const chunkHash = hashBuffer(chunkBuffer);
    const chunkPath = getChunkPath(options.chunksDir, chunkHash);

    if (!fs.existsSync(chunkPath)) {
      fs.writeFileSync(chunkPath, chunkBuffer);
    }

    chunks.push({
      index,
      hash: chunkHash,
      size: chunkBuffer.length,
      replicas: [options.localNodeId],
    });
  }

  return {
    fileHash,
    fileName: options.fileName,
    fileSize: options.fileSize,
    chunkSize: options.chunkSize,
    chunks,
  };
}

export function rebuildFileFromLocalChunks(options: {
  chunksDir: string;
  chunks: ChunkInfo[];
}): Buffer | null {
  const buffers: Buffer[] = [];
  const orderedChunks = [...options.chunks].sort((a, b) => a.index - b.index);

  for (const chunk of orderedChunks) {
    const chunkPath = getChunkPath(options.chunksDir, chunk.hash);
    if (!fs.existsSync(chunkPath)) return null;

    const buffer = fs.readFileSync(chunkPath);
    if (hashBuffer(buffer) !== chunk.hash) return null;

    buffers.push(buffer);
  }

  return Buffer.concat(buffers);
}
