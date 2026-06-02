import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chunkBinaryPath, chunkMetaPath, chunkPath, dataDir } from './storage-paths.js';
import { readJson, writeJson } from './storage-json.js';

const require = createRequire(import.meta.url);

let sqliteDb = null;
let sqliteChecked = false;
let warnedAboutSqlite = false;

function nowIso() {
  return new Date().toISOString();
}

function safeHash(hash = '') {
  return String(hash || '').replace(/[^a-fA-F0-9]/g, '');
}

function indexDbPath() {
  return path.join(dataDir(), 'chunk-index.sqlite');
}

function fallbackIndexPath() {
  return path.join(dataDir(), 'chunk-index.json');
}

function loadBetterSqlite3() {
  try {
    const loaded = require('better-sqlite3');
    return loaded?.default || loaded;
  } catch (error) {
    if (!warnedAboutSqlite) {
      warnedAboutSqlite = true;
      console.warn('[chunk-index] SQLite backend unavailable, using JSON fallback. Install/rebuild better-sqlite3 to enable SQLite.', error?.message || error);
    }
    return null;
  }
}

function initSqlite() {
  if (sqliteDb || sqliteChecked) return sqliteDb;
  sqliteChecked = true;

  const Database = loadBetterSqlite3();
  if (!Database) return null;

  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    sqliteDb = new Database(indexDbPath());
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('synchronous = NORMAL');
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS local_chunks (
        hash TEXT PRIMARY KEY,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        owner_wallet TEXT NOT NULL DEFAULT '',
        file_id TEXT NOT NULL DEFAULT '',
        encrypted INTEGER NOT NULL DEFAULT 0,
        format TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'present',
        binary_path TEXT NOT NULL DEFAULT '',
        meta_path TEXT NOT NULL DEFAULT '',
        legacy_path TEXT NOT NULL DEFAULT '',
        stored_at TEXT NOT NULL DEFAULT '',
        last_verified_at TEXT,
        updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_local_chunks_owner_wallet ON local_chunks(owner_wallet);
      CREATE INDEX IF NOT EXISTS idx_local_chunks_status ON local_chunks(status);
      CREATE INDEX IF NOT EXISTS idx_local_chunks_last_verified_at ON local_chunks(last_verified_at);
    `);
    return sqliteDb;
  } catch (error) {
    console.warn('[chunk-index] failed to initialize SQLite backend, using JSON fallback.', error?.message || error);
    sqliteDb = null;
    return null;
  }
}

function normalizeRecord(record = {}) {
  const hash = safeHash(record.hash);
  if (!hash) return null;

  const updatedAt = nowIso();
  return {
    hash,
    chunkIndex: Number(record.chunkIndex ?? record.index ?? 0),
    size: Number(record.size || 0),
    ownerWallet: String(record.ownerWallet || record.owner_wallet || '').toLowerCase(),
    fileId: String(record.fileId || record.file_id || ''),
    encrypted: Boolean(record.encrypted),
    format: String(record.format || ''),
    status: String(record.status || 'present'),
    binaryPath: String(record.binaryPath || record.binary_path || chunkBinaryPath(hash)),
    metaPath: String(record.metaPath || record.meta_path || chunkMetaPath(hash)),
    legacyPath: String(record.legacyPath || record.legacy_path || chunkPath(hash)),
    storedAt: String(record.storedAt || record.stored_at || updatedAt),
    lastVerifiedAt: record.lastVerifiedAt || record.last_verified_at || null,
    updatedAt,
  };
}

function readFallbackIndex() {
  const value = readJson(fallbackIndexPath(), {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function writeFallbackIndex(value = {}) {
  writeJson(fallbackIndexPath(), value && typeof value === 'object' ? value : {});
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    hash: row.hash,
    index: Number(row.chunk_index || 0),
    chunkIndex: Number(row.chunk_index || 0),
    size: Number(row.size || 0),
    ownerWallet: row.owner_wallet || '',
    fileId: row.file_id || '',
    encrypted: Boolean(row.encrypted),
    format: row.format || '',
    status: row.status || 'present',
    binaryPath: row.binary_path || '',
    metaPath: row.meta_path || '',
    legacyPath: row.legacy_path || '',
    storedAt: row.stored_at || '',
    lastVerifiedAt: row.last_verified_at || null,
    updatedAt: row.updated_at || '',
  };
}

export function chunkIndexBackend() {
  return initSqlite() ? 'sqlite' : 'json';
}

export function upsertChunkIndex(record = {}) {
  const normalized = normalizeRecord(record);
  if (!normalized) return null;

  const db = initSqlite();
  if (db) {
    db.prepare(`
      INSERT INTO local_chunks (
        hash, chunk_index, size, owner_wallet, file_id, encrypted, format, status,
        binary_path, meta_path, legacy_path, stored_at, last_verified_at, updated_at
      ) VALUES (
        @hash, @chunkIndex, @size, @ownerWallet, @fileId, @encrypted, @format, @status,
        @binaryPath, @metaPath, @legacyPath, @storedAt, @lastVerifiedAt, @updatedAt
      )
      ON CONFLICT(hash) DO UPDATE SET
        chunk_index = excluded.chunk_index,
        size = excluded.size,
        owner_wallet = excluded.owner_wallet,
        file_id = excluded.file_id,
        encrypted = excluded.encrypted,
        format = excluded.format,
        status = excluded.status,
        binary_path = excluded.binary_path,
        meta_path = excluded.meta_path,
        legacy_path = excluded.legacy_path,
        stored_at = CASE WHEN local_chunks.stored_at = '' THEN excluded.stored_at ELSE local_chunks.stored_at END,
        last_verified_at = COALESCE(excluded.last_verified_at, local_chunks.last_verified_at),
        updated_at = excluded.updated_at
    `).run({
      ...normalized,
      encrypted: normalized.encrypted ? 1 : 0,
    });
    return normalized;
  }

  const index = readFallbackIndex();
  index[normalized.hash] = normalized;
  writeFallbackIndex(index);
  return normalized;
}

export function getChunkIndex(hash = '') {
  const safe = safeHash(hash);
  if (!safe) return null;

  const db = initSqlite();
  if (db) {
    return rowToRecord(db.prepare('SELECT * FROM local_chunks WHERE hash = ? LIMIT 1').get(safe));
  }

  return readFallbackIndex()[safe] || null;
}

export function markChunkVerified(hash = '') {
  const current = getChunkIndex(hash);
  if (!current) return null;
  return upsertChunkIndex({ ...current, status: 'present', lastVerifiedAt: nowIso() });
}

export function markChunkDeleted(hash = '') {
  const current = getChunkIndex(hash) || { hash };
  return upsertChunkIndex({ ...current, status: 'deleted', updatedAt: nowIso() });
}

export function removeChunkIndex(hash = '') {
  const safe = safeHash(hash);
  if (!safe) return false;

  const db = initSqlite();
  if (db) {
    db.prepare('DELETE FROM local_chunks WHERE hash = ?').run(safe);
    return true;
  }

  const index = readFallbackIndex();
  if (!index[safe]) return false;
  delete index[safe];
  writeFallbackIndex(index);
  return true;
}

export function listChunkIndex({ ownerWallet = '', status = '', limit = 500, offset = 0 } = {}) {
  const maxLimit = Math.max(1, Math.min(5000, Number(limit || 500)));
  const safeOffset = Math.max(0, Number(offset || 0));
  const wallet = String(ownerWallet || '').toLowerCase();
  const wantedStatus = String(status || '');

  const db = initSqlite();
  if (db) {
    const where = [];
    const params = {};
    if (wallet) { where.push('owner_wallet = @wallet'); params.wallet = wallet; }
    if (wantedStatus) { where.push('status = @status'); params.status = wantedStatus; }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM local_chunks ${clause} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: maxLimit, offset: safeOffset })
      .map(rowToRecord);
  }

  return Object.values(readFallbackIndex())
    .filter((item) => !wallet || item.ownerWallet === wallet)
    .filter((item) => !wantedStatus || item.status === wantedStatus)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(safeOffset, safeOffset + maxLimit);
}

export function chunkIndexStats() {
  const db = initSqlite();
  if (db) {
    const rows = db.prepare('SELECT status, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM local_chunks GROUP BY status').all();
    return { backend: 'sqlite', rows };
  }

  const rowsByStatus = new Map();
  for (const item of Object.values(readFallbackIndex())) {
    const status = item.status || 'present';
    const current = rowsByStatus.get(status) || { status, count: 0, bytes: 0 };
    current.count += 1;
    current.bytes += Number(item.size || 0);
    rowsByStatus.set(status, current);
  }
  return { backend: 'json', rows: Array.from(rowsByStatus.values()) };
}
