import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.MANIFEST_SYNC_PORT || process.env.PORT || 8790);
const HOST = process.env.MANIFEST_SYNC_HOST || '0.0.0.0';
const DATA_DIR = process.env.MANIFEST_SYNC_DATA_DIR || path.join(__dirname, '..', 'sync-data');
const STORE_PATH = path.join(DATA_DIR, 'wallet-manifests.json');
const MAX_BODY_BYTES = Number(process.env.MANIFEST_SYNC_MAX_BODY_BYTES || 10 * 1024 * 1024);

function normalizeWallet(address = '') {
  return String(address || '').trim().toLowerCase();
}

function validWallet(address = '') {
  return /^0x[a-f0-9]{40}$/.test(normalizeWallet(address));
}

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) fs.writeFileSync(STORE_PATH, '{}', 'utf8');
}

function readStore() {
  ensureStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function sanitizeManifest(manifest = {}, wallet) {
  const hash = String(manifest.hash || '').trim();
  if (!hash) throw new Error('manifest.hash is required');
  return {
    id: String(manifest.id || `${wallet}:${hash}`),
    name: String(manifest.name || 'file'),
    size: Number(manifest.size || 0),
    hash,
    rootHash: String(manifest.rootHash || ''),
    uploadedAt: manifest.uploadedAt || new Date().toISOString(),
    isEncrypted: Boolean(manifest.isEncrypted),
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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
    const { parts } = routeParts(req.url || '/');

    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'health') {
      return send(res, 200, { ok: true, service: 'p2p-cloud-manifest-sync', wallets: Object.keys(readStore()).length });
    }

    if (parts[0] !== 'wallet' || !parts[1] || parts[2] !== 'manifests') {
      return send(res, 404, { ok: false, error: 'Not found' });
    }

    const wallet = normalizeWallet(parts[1]);
    if (!validWallet(wallet)) return send(res, 400, { ok: false, error: 'Invalid wallet address' });

    const store = readStore();
    const current = Array.isArray(store[wallet]) ? store[wallet] : [];

    if (req.method === 'GET' && parts.length === 3) {
      return send(res, 200, { ok: true, wallet, manifests: current });
    }

    if (req.method === 'POST' && parts.length === 3) {
      const body = await readBody(req);
      const manifest = sanitizeManifest(body.manifest || body, wallet);
      const next = current.filter((item) => item.hash !== manifest.hash);
      next.push(manifest);
      store[wallet] = next.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
      writeStore(store);
      return send(res, 200, { ok: true, wallet, manifest, count: store[wallet].length });
    }

    if (req.method === 'DELETE' && parts.length === 4) {
      const hash = decodeURIComponent(parts[3]);
      store[wallet] = current.filter((item) => item.hash !== hash);
      writeStore(store);
      return send(res, 200, { ok: true, wallet, hash, count: store[wallet].length });
    }

    return send(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    return send(res, 500, { ok: false, error: error?.message || 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  ensureStore();
  console.log(`[manifest-sync] listening on http://${HOST}:${PORT}`);
  console.log(`[manifest-sync] store: ${STORE_PATH}`);
});
