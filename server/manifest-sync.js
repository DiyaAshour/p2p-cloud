import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PORT = Number(process.env.MANIFEST_SYNC_PORT || process.env.PORT || 8790);
const DEFAULT_HOST = process.env.MANIFEST_SYNC_HOST || '0.0.0.0';
const DEFAULT_DATA_DIR = process.env.MANIFEST_SYNC_DATA_DIR || path.join(__dirname, '..', 'sync-data');
const MAX_BODY_BYTES = Number(process.env.MANIFEST_SYNC_MAX_BODY_BYTES || 10 * 1024 * 1024);
const PUBLIC_SEARCH_LIMIT = Number(process.env.MANIFEST_SYNC_PUBLIC_SEARCH_LIMIT || 100);
const ALLOWED_ENCRYPTION_KEYS = new Set([
  'version',
  'algorithm',
  'keySource',
  'kdf',
  'kdfIterations',
  'salt',
  'iv',
  'authTag',
  'originalHash',
  'originalSize',
]);

function normalizeWallet(address = '') {
  return String(address || '').trim().toLowerCase();
}

function validWallet(address = '') {
  return /^0x[a-f0-9]{40}$/.test(normalizeWallet(address));
}

function sanitizeVisibility(value, isEncrypted) {
  if (!isEncrypted && String(value || 'public').toLowerCase() === 'private') return 'private';
  if (!isEncrypted) return 'public';
  return String(value || 'private').toLowerCase() === 'public' ? 'public' : 'private';
}

function isPublicManifest(manifest = {}) {
  return manifest.visibility === 'public' || manifest.isPublic === true || manifest.isEncrypted === false;
}

function sanitizeEncryptionMetadata(encryption) {
  if (!encryption || typeof encryption !== 'object') return null;
  const clean = {};
  for (const key of ALLOWED_ENCRYPTION_KEYS) {
    if (encryption[key] !== undefined && encryption[key] !== null) clean[key] = encryption[key];
  }
  return Object.keys(clean).length ? clean : null;
}

function createStore(dataDir) {
  const storePath = path.join(dataDir, 'wallet-manifests.json');
  function ensureStore() {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(storePath)) fs.writeFileSync(storePath, '{}', 'utf8');
  }
  function readStore() {
    ensureStore();
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  function writeStore(store) {
    ensureStore();
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
  }
  return { storePath, ensureStore, readStore, writeStore };
}

function sanitizeManifest(manifest = {}, wallet) {
  const hash = String(manifest.hash || '').trim();
  if (!hash) throw new Error('manifest.hash is required');
  const isEncrypted = Boolean(manifest.isEncrypted);
  const visibility = sanitizeVisibility(manifest.visibility, isEncrypted);
  return {
    id: String(manifest.id || `${wallet}:${hash}`),
    name: String(manifest.name || 'file'),
    size: Number(manifest.size || 0),
    storedSize: Number(manifest.storedSize || manifest.size || 0),
    hash,
    rootHash: String(manifest.rootHash || ''),
    uploadedAt: manifest.uploadedAt || new Date().toISOString(),
    isEncrypted,
    visibility,
    isPublic: visibility === 'public',
    encryption: sanitizeEncryptionMetadata(manifest.encryption),
    mimeType: manifest.mimeType || 'application/octet-stream',
    chunkSize: Number(manifest.chunkSize || 0),
    totalChunks: Number(manifest.totalChunks || 0),
    ownerNodeId: String(manifest.ownerNodeId || ''),
    ownerWallet: wallet,
    planId: manifest.planId || 'free',
    replicas: Array.isArray(manifest.replicas) ? manifest.replicas : [],
    chunks: Array.isArray(manifest.chunks) ? manifest.chunks : [],
    syncedAt: new Date().toISOString(),
  };
}

function publicProjection(manifest = {}) {
  return {
    id: manifest.id,
    name: manifest.name,
    size: manifest.size,
    storedSize: manifest.storedSize,
    hash: manifest.hash,
    rootHash: manifest.rootHash,
    uploadedAt: manifest.uploadedAt,
    isEncrypted: false,
    visibility: 'public',
    isPublic: true,
    mimeType: manifest.mimeType,
    chunkSize: manifest.chunkSize,
    totalChunks: manifest.totalChunks,
    ownerNodeId: manifest.ownerNodeId,
    ownerWallet: manifest.ownerWallet,
    replicas: manifest.replicas || [],
    chunks: manifest.chunks || [],
    syncedAt: manifest.syncedAt,
  };
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function routeParts(reqUrl) {
  const url = new URL(reqUrl, 'http://localhost');
  return { url, parts: url.pathname.split('/').filter(Boolean) };
}

function searchPublicStore(db, query = '') {
  const q = String(query || '').trim().toLowerCase();
  const all = Object.values(db)
    .flatMap((items) => (Array.isArray(items) ? items : []))
    .filter(isPublicManifest)
    .map(publicProjection);
  const filtered = q
    ? all.filter((item) => [item.name, item.mimeType, item.ownerWallet, item.hash, item.rootHash]
      .some((value) => String(value || '').toLowerCase().includes(q)))
    : all;
  return filtered
    .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')))
    .slice(0, PUBLIC_SEARCH_LIMIT);
}

export function createManifestSyncServer({ dataDir = DEFAULT_DATA_DIR } = {}) {
  const store = createStore(dataDir);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
      const { url, parts } = routeParts(req.url || '/');

      if (req.method === 'GET' && parts.length === 1 && parts[0] === 'health') {
        const db = store.readStore();
        return send(res, 200, { ok: true, service: 'p2p-cloud-manifest-sync', wallets: Object.keys(db).length, publicFiles: searchPublicStore(db).length });
      }

      if (req.method === 'GET' && parts.length === 2 && parts[0] === 'public' && parts[1] === 'manifests') {
        const manifests = searchPublicStore(store.readStore(), url.searchParams.get('q') || '');
        return send(res, 200, { ok: true, public: true, count: manifests.length, manifests });
      }

      if (parts[0] !== 'wallet' || !parts[1] || parts[2] !== 'manifests') {
        return send(res, 404, { ok: false, error: 'Not found' });
      }

      const wallet = normalizeWallet(parts[1]);
      if (!validWallet(wallet)) return send(res, 400, { ok: false, error: 'Invalid wallet address' });

      const db = store.readStore();
      const current = Array.isArray(db[wallet]) ? db[wallet] : [];

      if (req.method === 'GET' && parts.length === 3) {
        return send(res, 200, { ok: true, wallet, manifests: current });
      }

      if (req.method === 'POST' && parts.length === 3) {
        const body = await readBody(req);
        const manifest = sanitizeManifest(body.manifest || body, wallet);
        const next = current.filter((item) => item.hash !== manifest.hash);
        next.push(manifest);
        db[wallet] = next.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
        store.writeStore(db);
        return send(res, 200, { ok: true, wallet, manifest, count: db[wallet].length });
      }

      if (req.method === 'DELETE' && parts.length === 4) {
        const hash = decodeURIComponent(parts[3]);
        db[wallet] = current.filter((item) => item.hash !== hash);
        store.writeStore(db);
        return send(res, 200, { ok: true, wallet, hash, count: db[wallet].length });
      }

      return send(res, 405, { ok: false, error: 'Method not allowed' });
    } catch (error) {
      return send(res, 500, { ok: false, error: error?.message || 'Server error' });
    }
  });
  server.storePath = store.storePath;
  server.ensureStore = store.ensureStore;
  return server;
}

export function startManifestSyncServer({ port = DEFAULT_PORT, host = DEFAULT_HOST, dataDir = DEFAULT_DATA_DIR } = {}) {
  const server = createManifestSyncServer({ dataDir });
  server.ensureStore();
  server.listen(port, host, () => {
    console.log(`[manifest-sync] listening on http://${host}:${port}`);
    console.log(`[manifest-sync] store: ${server.storePath}`);
    console.log('[manifest-sync] public search: GET /public/manifests?q=term');
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startManifestSyncServer();
}
