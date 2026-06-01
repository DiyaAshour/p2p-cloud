import fs from 'node:fs';
import path from 'node:path';
import { chunkBinaryPath, chunkMetaPath, chunkPath, chunkStoreDir } from './storage-paths.js';
import { readJson, writeJson } from './storage-json.js';

function ensureChunkDirs(hash = '') {
  fs.mkdirSync(chunkStoreDir(), { recursive: true });
  fs.mkdirSync(path.dirname(chunkBinaryPath(hash)), { recursive: true });
  fs.mkdirSync(path.dirname(chunkMetaPath(hash)), { recursive: true });
}

function bufferFromChunk(chunk = {}) {
  if (Buffer.isBuffer(chunk.data)) return chunk.data;
  if (typeof chunk.data === 'string') return Buffer.from(chunk.data, 'base64');
  return Buffer.alloc(0);
}

export function writeChunkRecord(chunk = {}) {
  if (!chunk?.hash) throw new Error('chunk.hash is required');
  const data = bufferFromChunk(chunk);
  if (!data.length) throw new Error('chunk.data is required');
  ensureChunkDirs(chunk.hash);

  const meta = {
    hash: chunk.hash,
    index: Number(chunk.index || 0),
    size: Number(chunk.size || data.length),
    ownerWallet: String(chunk.ownerWallet || '').toLowerCase(),
    encrypted: Boolean(chunk.encrypted),
    storedAt: new Date().toISOString(),
    format: 'binary-v1',
  };

  fs.writeFileSync(chunkBinaryPath(chunk.hash), data);
  writeJson(chunkMetaPath(chunk.hash), meta);
  return { ...meta, data: data.toString('base64') };
}

export function readChunkRecord(hash = '') {
  const binaryFile = chunkBinaryPath(hash);
  const metaFile = chunkMetaPath(hash);
  if (fs.existsSync(binaryFile)) {
    const data = fs.readFileSync(binaryFile);
    const meta = readJson(metaFile, {});
    return {
      ...meta,
      hash: meta.hash || hash,
      size: Number(meta.size || data.length),
      data: data.toString('base64'),
      format: meta.format || 'binary-v1',
    };
  }

  const legacyFile = chunkPath(hash);
  if (fs.existsSync(legacyFile)) return readJson(legacyFile, null);
  return null;
}

export function readChunkBuffer(hash = '') {
  const binaryFile = chunkBinaryPath(hash);
  if (fs.existsSync(binaryFile)) return fs.readFileSync(binaryFile);
  const legacy = readChunkRecord(hash);
  if (!legacy?.data) return null;
  return Buffer.from(legacy.data, 'base64');
}
