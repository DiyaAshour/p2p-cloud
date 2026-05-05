import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 12000;
const LOCAL_SYNC_URL = 'http://127.0.0.1:8790';
const HOSTED_SYNC_URL = process.env.P2P_ALLOW_INSECURE_HOSTED_SYNC === '1' ? 'http://54.166.171.208:8790' : '';

function configuredSyncUrl() {
  return process.env.P2P_MANIFEST_SYNC_URL || process.env.VITE_P2P_MANIFEST_SYNC_URL || '';
}

function candidateSyncUrls() {
  const configured = configuredSyncUrl();
  return [...new Set([configured, LOCAL_SYNC_URL, HOSTED_SYNC_URL].filter(Boolean))];
}

function normalizeWallet(address = '') {
  return String(address || '').trim().toLowerCase();
}

function sha256Hex(value = '') {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function authHeaders(auth = {}, body = '') {
  const wallet = normalizeWallet(auth.wallet);
  if (!wallet || !auth.message || !auth.signature) throw new Error('Manifest sync requires wallet login signature');
  return {
    'x-p2p-wallet': wallet,
    'x-p2p-auth-message': String(auth.message),
    'x-p2p-auth-signature': String(auth.signature),
    'x-p2p-body-sha256': sha256Hex(body),
  };
}

function sanitizeManifest(manifest) {
  return {
    id: manifest.id,
    name: manifest.name,
    size: manifest.size,
    storedSize: manifest.storedSize,
    hash: manifest.hash,
    rootHash: manifest.rootHash,
    uploadedAt: manifest.uploadedAt,
    isEncrypted: Boolean(manifest.isEncrypted),
    encryption: manifest.encryption || null,
    mimeType: manifest.mimeType || 'application/octet-stream',
    chunkSize: manifest.chunkSize,
    totalChunks: manifest.totalChunks,
    ownerNodeId: manifest.ownerNodeId,
    ownerWallet: normalizeWallet(manifest.ownerWallet),
    planId: manifest.planId || 'free',
    replicas: Array.isArray(manifest.replicas) ? manifest.replicas : [],
    chunks: Array.isArray(manifest.chunks) ? manifest.chunks : [],
  };
}

async function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = options.body || '';
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method || 'GET',
      timeout: DEFAULT_TIMEOUT_MS,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(options.headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
          reject(new Error(`Manifest sync failed: ${res.statusCode} ${res.statusMessage || ''} ${raw}`.trim()));
          return;
        }
        try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Manifest sync returned invalid JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Manifest sync request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function requestFirstAvailable(path, options = {}) {
  const errors = [];
  for (const baseUrl of candidateSyncUrls()) {
    const url = `${baseUrl.replace(/\/$/, '')}${path}`;
    try {
      const data = await requestJson(url, options);
      return { data, baseUrl };
    } catch (error) {
      errors.push(`${baseUrl}: ${error?.message || error}`);
    }
  }
  throw new Error(errors.join(' | ') || 'No manifest sync endpoint available');
}

export function manifestSyncUrl() { return candidateSyncUrls()[0] || ''; }
export function isManifestSyncEnabled() { return candidateSyncUrls().length > 0; }

export async function pullWalletManifests(ownerWallet, auth = {}) {
  const wallet = normalizeWallet(ownerWallet);
  if (!wallet) return [];
  const path = `/wallet/${encodeURIComponent(wallet)}/manifests`;
  const { data, baseUrl } = await requestFirstAvailable(path, { method: 'GET', headers: authHeaders(auth, '') });
  console.log('[manifest-sync] pull ok from', baseUrl);
  return Array.isArray(data?.manifests) ? data.manifests.map(sanitizeManifest) : [];
}

export async function pushWalletManifest(manifest, auth = {}) {
  const clean = sanitizeManifest(manifest);
  const path = `/wallet/${encodeURIComponent(clean.ownerWallet)}/manifests`;
  const body = JSON.stringify({ manifest: clean });
  const { data, baseUrl } = await requestFirstAvailable(path, { method: 'POST', body, headers: authHeaders(auth, body) });
  console.log('[manifest-sync] push ok to', baseUrl);
  return data;
}

export async function deleteWalletManifest(ownerWallet, hash, auth = {}) {
  const wallet = normalizeWallet(ownerWallet);
  const path = `/wallet/${encodeURIComponent(wallet)}/manifests/${encodeURIComponent(hash)}`;
  const { data, baseUrl } = await requestFirstAvailable(path, { method: 'DELETE', headers: authHeaders(auth, '') });
  console.log('[manifest-sync] delete ok from', baseUrl);
  return data;
}
