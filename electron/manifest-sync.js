const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_SYNC_URL = 'http://54.166.171.208:8790';

function getSyncUrl() {
  return process.env.P2P_MANIFEST_SYNC_URL || process.env.VITE_P2P_MANIFEST_SYNC_URL || DEFAULT_SYNC_URL;
}

function normalizeWallet(address = '') {
  return String(address || '').trim().toLowerCase();
}

function sanitizeManifest(manifest) {
  return {
    id: manifest.id,
    name: manifest.name,
    size: manifest.size,
    hash: manifest.hash,
    rootHash: manifest.rootHash,
    uploadedAt: manifest.uploadedAt,
    isEncrypted: Boolean(manifest.isEncrypted),
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`Manifest sync failed: ${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function manifestSyncUrl() {
  return getSyncUrl();
}

export function isManifestSyncEnabled() {
  return Boolean(getSyncUrl());
}

export async function pullWalletManifests(ownerWallet) {
  const baseUrl = getSyncUrl();
  if (!baseUrl) return [];
  const wallet = normalizeWallet(ownerWallet);
  if (!wallet) return [];
  const url = `${baseUrl.replace(/\/$/, '')}/wallet/${encodeURIComponent(wallet)}/manifests`;
  const data = await requestJson(url, { method: 'GET' });
  return Array.isArray(data?.manifests) ? data.manifests.map(sanitizeManifest) : [];
}

export async function pushWalletManifest(manifest) {
  const baseUrl = getSyncUrl();
  if (!baseUrl) return { ok: false, skipped: true };
  const clean = sanitizeManifest(manifest);
  const url = `${baseUrl.replace(/\/$/, '')}/wallet/${encodeURIComponent(clean.ownerWallet)}/manifests`;
  return await requestJson(url, {
    method: 'POST',
    body: JSON.stringify({ manifest: clean }),
  });
}

export async function deleteWalletManifest(ownerWallet, hash) {
  const baseUrl = getSyncUrl();
  if (!baseUrl) return { ok: false, skipped: true };
  const wallet = normalizeWallet(ownerWallet);
  const url = `${baseUrl.replace(/\/$/, '')}/wallet/${encodeURIComponent(wallet)}/manifests/${encodeURIComponent(hash)}`;
  return await requestJson(url, { method: 'DELETE' });
}
