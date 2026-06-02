import fs from 'node:fs';
import path from 'node:path';
import { chunkBinaryPath, chunkMetaPath, chunkPath, chunkStoreDir } from './storage-paths.js';
import { readJson, writeJson } from './storage-json.js';
import { getChunkIndex, markChunkVerified, upsertChunkIndex } from './chunk-index.js';

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

function indexRecordForChunk(chunk = {}, meta = {}) {
  const hash = String(meta.hash || chunk.hash || '');
  return {
    hash,
    index: Number(meta.index ?? chunk.index ?? 0),
    size: Number(meta.size || chunk.size || 0),
    ownerWallet: String(meta.ownerWallet || chunk.ownerWallet || '').toLowerCase(),
    fileId: String(meta.fileId || chunk.fileId || ''),
    encrypted: Boolean(meta.encrypted ?? chunk.encrypted),
    format: String(meta.format || chunk.format || 'binary-v1'),
    status: 'present',
    binaryPath: chunkBinaryPath(hash),
    metaPath: chunkMetaPath(hash),
    legacyPath: chunkPath(hash),
    storedAt: meta.storedAt || new Date().toISOString(),
  };
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
    fileId: String(chunk.fileId || ''),
    encrypted: Boolean(chunk.encrypted),
    storedAt: new Date().toISOString(),
    format: 'binary-v1',
  };

  fs.writeFileSync(chunkBinaryPath(chunk.hash), data);
  writeJson(chunkMetaPath(chunk.hash), meta);
  upsertChunkIndex(indexRecordForChunk(chunk, meta));
  return { ...meta, data: data.toString('base64') };
}

export function readChunkRecord(hash = '') {
  const indexed = getChunkIndex(hash);
  const binaryFile = indexed?.binaryPath || chunkBinaryPath(hash);
  const metaFile = indexed?.metaPath || chunkMetaPath(hash);

  if (fs.existsSync(binaryFile)) {
    const data = fs.readFileSync(binaryFile);
    const meta = readJson(metaFile, {});
    const record = {
      ...meta,
      hash: meta.hash || indexed?.hash || hash,
      size: Number(meta.size || indexed?.size || data.length),
      data: data.toString('base64'),
      format: meta.format || indexed?.format || 'binary-v1',
    };
    markChunkVerified(record.hash);
    return record;
  }

  const legacyFile = indexed?.legacyPath || chunkPath(hash);
  if (fs.existsSync(legacyFile)) {
    const legacy = readJson(legacyFile, null);
    if (legacy?.hash) upsertChunkIndex(indexRecordForChunk(legacy, { ...legacy, format: legacy.format || 'legacy-json' }));
    return legacy;
  }

  return null;
}

export function readChunkBuffer(hash = '') {
  const indexed = getChunkIndex(hash);
  const binaryFile = indexed?.binaryPath || chunkBinaryPath(hash);
  if (fs.existsSync(binaryFile)) {
    markChunkVerified(hash);
    return fs.readFileSync(binaryFile);
  }
  const legacy = readChunkRecord(hash);
  if (!legacy?.data) return null;
  return Buffer.from(legacy.data, 'base64');
}
