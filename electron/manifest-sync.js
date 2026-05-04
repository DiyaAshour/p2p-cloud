const DEFAULT_TIMEOUT_MS = 8000;
const LOCAL_SYNC_URL = 'http://127.0.0.1:8790';
const HOSTED_SYNC_URL = 'http://54.166.171.208:8790';

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

export function manifestSyncUrl() {
  return candidateSyncUrls()[0] || '';
}

export function isManifestSyncEnabled() {
  return candidateSyncUrls().length > 0;
}

export async function pullWalletManifests(ownerWallet) {
  const wallet = normalizeWallet(ownerWallet);
  if (!wallet) return [];
  const path = `/wallet/${encodeURIComponent(wallet)}/manifests`;
  const { data, baseUrl } = await requestFirstAvailable(path, { method: 'GET' });
  console.log('[manifest-sync] pull ok from', baseUrl);
  return Array.isArray(data?.manifests) ? data.manifests.map(sanitizeManifest) : [];
}

export async function pushWalletManifest(manifest) {
  const clean = sanitizeManifest(manifest);
  const path = `/wallet/${encodeURIComponent(clean.ownerWallet)}/manifests`;
  const { data, baseUrl } = await requestFirstAvailable(path, {
    method: 'POST',
    body: JSON.stringify({ manifest: clean }),
  });
  console.log('[manifest-sync] push ok to', baseUrl);
  return data;
}

export async function deleteWalletManifest(ownerWallet, hash) {
  const wallet = normalizeWallet(ownerWallet);
  const path = `/wallet/${encodeURIComponent(wallet)}/manifests/${encodeURIComponent(hash)}`;
  const { data, baseUrl } = await requestFirstAvailable(path, { method: 'DELETE' });
  console.log('[manifest-sync] delete ok from', baseUrl);
  return data;
}
