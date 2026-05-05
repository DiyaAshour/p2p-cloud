const DEFAULT_MANIFEST_SYNC_URL = 'http://54.166.171.208:8790';

function normalizeBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/$/, '');
}

function normalizeWallet(address = '') {
  return String(address || '').trim().toLowerCase();
}

function validWallet(address = '') {
  return /^0x[a-f0-9]{40}$/.test(normalizeWallet(address));
}

function manifestSyncBaseUrl() {
  return normalizeBaseUrl(
    process.env.P2P_MANIFEST_SYNC_URL ||
    process.env.MANIFEST_SYNC_URL ||
    process.env.VITE_MANIFEST_SYNC_URL ||
    DEFAULT_MANIFEST_SYNC_URL
  );
}

export function isManifestSyncEnabled() {
  const disabled = String(process.env.P2P_MANIFEST_SYNC_DISABLED || '').toLowerCase();
  return disabled !== '1' && disabled !== 'true' && Boolean(manifestSyncBaseUrl());
}

function hasEncryptionMetadata(manifest = {}) {
  return Boolean(
    manifest.encryption &&
    manifest.encryption.algorithm &&
    manifest.encryption.keySource &&
    manifest.encryption.salt &&
    manifest.encryption.iv &&
    manifest.encryption.authTag
  );
}

function isBadEncryptedManifest(manifest = {}) {
  return manifest?.isEncrypted === true && !hasEncryptionMetadata(manifest);
}

function sanitizePulledManifest(manifest = {}) {
  if (!manifest || typeof manifest !== 'object') return null;
  if (!manifest.hash || !manifest.ownerWallet) return null;
  if (isBadEncryptedManifest(manifest)) return null;
  return {
    ...manifest,
    ownerWallet: normalizeWallet(manifest.ownerWallet),
    visibility: manifest.visibility || (manifest.isEncrypted ? 'private' : 'public'),
    isPublic: manifest.isPublic === true || manifest.visibility === 'public' || manifest.isEncrypted === false,
  };
}

async function parseJsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

export async function pullWalletManifests(walletAddress) {
  const wallet = normalizeWallet(walletAddress);
  if (!validWallet(wallet)) throw new Error('Valid wallet required for manifest sync pull');
  const response = await fetch(`${manifestSyncBaseUrl()}/wallet/${wallet}/manifests`);
  const data = await parseJsonResponse(response);
  const incoming = Array.isArray(data.manifests) ? data.manifests : [];
  const clean = [];
  let skipped = 0;
  for (const item of incoming) {
    const manifest = sanitizePulledManifest(item);
    if (manifest) clean.push(manifest);
    else skipped += 1;
  }
  if (skipped) console.warn(`[manifest-sync] skipped ${skipped} invalid encrypted manifest(s) from remote`);
  return clean;
}

export async function pushWalletManifest(manifest = {}) {
  const wallet = normalizeWallet(manifest.ownerWallet);
  if (!validWallet(wallet)) throw new Error('Valid wallet required for manifest sync push');
  if (isBadEncryptedManifest(manifest)) {
    throw new Error('Refusing to sync encrypted manifest without encryption metadata');
  }
  const payload = {
    manifest: {
      ...manifest,
      ownerWallet: wallet,
      visibility: manifest.visibility || (manifest.isEncrypted ? 'private' : 'public'),
      isPublic: manifest.isPublic === true || manifest.visibility === 'public' || manifest.isEncrypted === false,
    },
  };
  const response = await fetch(`${manifestSyncBaseUrl()}/wallet/${wallet}/manifests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJsonResponse(response);
}

export async function deleteWalletManifest(walletAddress, hash) {
  const wallet = normalizeWallet(walletAddress);
  if (!validWallet(wallet)) throw new Error('Valid wallet required for manifest sync delete');
  if (!hash) throw new Error('Manifest hash required for delete');
  const response = await fetch(`${manifestSyncBaseUrl()}/wallet/${wallet}/manifests/${encodeURIComponent(hash)}`, {
    method: 'DELETE',
  });
  return parseJsonResponse(response);
}

export async function searchPublicManifests(query = '') {
  const q = String(query || '').trim();
  const response = await fetch(`${manifestSyncBaseUrl()}/public/manifests?q=${encodeURIComponent(q)}`);
  const data = await parseJsonResponse(response);
  return Array.isArray(data.manifests) ? data.manifests : [];
}
