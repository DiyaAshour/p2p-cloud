import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyMessage } from 'viem';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PORT = Number(process.env.MANIFEST_SYNC_PORT || process.env.PORT || 8790);
const DEFAULT_HOST = process.env.MANIFEST_SYNC_HOST || '0.0.0.0';
const DEFAULT_DATA_DIR = process.env.MANIFEST_SYNC_DATA_DIR || path.join(__dirname, '..', 'sync-data');
const MAX_BODY_BYTES = Number(process.env.MANIFEST_SYNC_MAX_BODY_BYTES || 10 * 1024 * 1024);
const MAX_AUTH_AGE_MS = Number(process.env.MANIFEST_SYNC_AUTH_MAX_AGE_MS || 10 * 60 * 1000);
const MAX_AUTH_FUTURE_MS = Number(process.env.MANIFEST_SYNC_AUTH_MAX_FUTURE_MS || 2 * 60 * 1000);
const ALLOWED_ORIGIN = process.env.MANIFEST_SYNC_ALLOWED_ORIGIN || '';
const ALLOWED_ENCRYPTION_KEYS = new Set(['version', 'algorithm', 'keySource', 'kdf', 'kdfIterations', 'salt', 'iv', 'authTag', 'originalHash', 'originalSize']);

function normalizeWallet(address = '') { return String(address || '').trim().toLowerCase(); }
function validWallet(address = '') { return /^0x[a-f0-9]{40}$/.test(normalizeWallet(address)); }
function sha256Hex(value = '') { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeHeader(value = '') { return String(value || '').replace(/[\r\n]/g, ' ').trim(); }

function parseSignedTime(message = '') {
  const match = String(message).match(/^Time:\s*(.+)$/im);
  if (!match) throw new Error('Auth message missing timestamp');
  const signedAt = new Date(match[1]);
  if (Number.isNaN(signedAt.getTime())) throw new Error('Auth timestamp invalid');
  const age = Date.now() - signedAt.getTime();
  if (age > MAX_AUTH_AGE_MS) throw new Error('Auth signature expired');
  if (age < -MAX_AUTH_FUTURE_MS) throw new Error('Auth timestamp too far in the future');
  return signedAt;
}

async function assertWalletAuth(req, wallet, rawBody = '') {
  const headerWallet = normalizeWallet(req.headers['x-p2p-wallet']);
  const message = safeHeader(req.headers['x-p2p-auth-message']);
  const signature = safeHeader(req.headers['x-p2p-auth-signature']);
  const bodyHash = safeHeader(req.headers['x-p2p-body-sha256']);
  if (!headerWallet || !message || !signature || !bodyHash) throw new Error('Missing manifest auth headers');
  if (headerWallet !== wallet) throw new Error('Auth wallet mismatch');
  if (!message.startsWith('p2p.cloud login\n')) throw new Error('Unsupported auth message');
  if (!message.toLowerCase().includes(`wallet: ${wallet}`)) throw new Error('Auth message wallet mismatch');
  if (bodyHash !== sha256Hex(rawBody)) throw new Error('Body hash mismatch');
  parseSignedTime(message);
  const valid = await verifyMessage({ address: wallet, message, signature });
  if (!valid) throw new Error('Wallet signature verification failed');
}

function sanitizeEncryptionMetadata(encryption) {
  if (!encryption || typeof encryption !== 'object') return null;
  const clean = {};
  for (const key of ALLOWED_ENCRYPTION_KEYS) if (encryption[key] !== undefined && encryption[key] !== null) clean[key] = encryption[key];
  return Object.keys(clean).length ? clean : null;
}

function createStore(dataDir) {
  const storePath = path.join(dataDir, 'wallet-manifests.json');
  function ensureStore() { fs.mkdirSync(dataDir, { recursive: true }); if (!fs.existsSync(storePath)) fs.writeFileSync(storePath, '{}', 'utf8'); }
  function readStore() { ensureStore(); try { const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; } }
  function writeStore(store) { ensureStore(); fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8'); }
  return { storePath, ensureStore, readStore, writeStore };
}

function sanitizeManifest(manifest = {}, wallet) {
  const hash = String(manifest.hash || '').trim();
  if (!hash) throw new Error('manifest.hash is required');
  return {
    id: String(manifest.id || `${wallet}:${hash}`),
    name: String(manifest.name || 'file'),
    size: Number(manifest.size || 0),
    storedSize: Number(manifest.storedSize || manifest.size || 0),
    hash,
    rootHash: String(manifest.rootHash || ''),
    uploadedAt: manifest.uploadedAt || new Date().toISOString(),
    isEncrypted: Boolean(manifest.isEncrypted),
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

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-p2p-wallet,x-p2p-auth-message,x-p2p-auth-signature,x-p2p-body-sha256',
  };
  if (ALLOWED_ORIGIN) headers['access-control-allow-origin'] = ALLOWED_ORIGIN;
  res.writeHead(status, headers);
  res.end(body);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonBody(raw = '') {
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('Invalid JSON body'); }
}

function routeParts(reqUrl) {
  const url = new URL(reqUrl, 'http://localhost');
  return { url, parts: url.pathname.split('/').filter(Boolean) };
}

export function createManifestSyncServer({ dataDir = DEFAULT_DATA_DIR } = {}) {
  const store = createStore(dataDir);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
      const { parts } = routeParts(req.url || '/');
      if (req.method === 'GET' && parts.length === 1 && parts[0] === 'health') {
        return send(res, 200, { ok: true, service: 'p2p-cloud-manifest-sync', wallets: Object.keys(store.readStore()).length, auth: 'wallet-signature-required' });
      }
      if (parts[0] !== 'wallet' || !parts[1] || parts[2] !== 'manifests') return send(res, 404, { ok: false, error: 'Not found' });
      const wallet = normalizeWallet(parts[1]);
      if (!validWallet(wallet)) return send(res, 400, { ok: false, error: 'Invalid wallet address' });

      const rawBody = req.method === 'POST' ? await readRawBody(req) : '';
      await assertWalletAuth(req, wallet, rawBody);

      const db = store.readStore();
      const current = Array.isArray(db[wallet]) ? db[wallet] : [];

      if (req.method === 'GET' && parts.length === 3) return send(res, 200, { ok: true, wallet, manifests: current });
      if (req.method === 'POST' && parts.length === 3) {
        const body = parseJsonBody(rawBody);
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
      const message = error?.message || 'Server error';
      const status = /auth|signature|wallet|hash/i.test(message) ? 401 : 500;
      return send(res, status, { ok: false, error: message });
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
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) startManifestSyncServer();
