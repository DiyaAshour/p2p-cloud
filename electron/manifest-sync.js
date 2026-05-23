import crypto from 'node:crypto';

const DEFAULT_MANIFEST_SYNC_URL = 'http://54.166.171.208:8790';
const MANIFEST_SYNC_TIMEOUT_MS = Math.max(500, Number(process.env.P2P_MANIFEST_SYNC_TIMEOUT_MS || 8000));
const MANIFEST_SYNC_AUTH_VERSION = 'hmac-sha256-v1';

function normalizeBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/$/, '');
}

function normalizeIdentity(value = '') {
  return String(value || '').trim().toLowerCase();
}

function validWallet(address = '') {
  return /^0x[a-f0-9]{40}$/.test(normalizeIdentity(address));
}

function validIdentity(identity = '') {
  const value = normalizeIdentity(identity);
  return validWallet(value) || /^seed:[a-f0-9]{16,128}$/.test(value);
}

function identityPath(identity = '') {
  return encodeURIComponent(normalizeIdentity(identity));
}

function manifestSyncBaseUrl() {
  return normalizeBaseUrl(
    process.env.P2P_MANIFEST_SYNC_URL ||
    process.env.MANIFEST_SYNC_URL ||
    process.env.VITE_MANIFEST_SYNC_URL ||
    DEFAULT_MANIFEST_SYNC_URL
  );
}

function manifestSyncAuthSecret() {
  return String(
    process.env.P2P_MANIFEST_SYNC_AUTH_SECRET ||
    process.env.MANIFEST_SYNC_AUTH_SECRET ||
    ''
  ).trim();
}

function sha256Hex(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function signManifestSyncRequest({ method, path, identity, body = '' }) {
  const secret = manifestSyncAuthSecret();
  if (!secret) return {};

  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const normalizedPath = String(path || '');
  const normalizedIdentity = normalizeIdentity(identity);
  const bodySha256 = sha256Hex(body);
  const canonical = [
    MANIFEST_SYNC_AUTH_VERSION,
    normalizedMethod,
    normalizedPath,
    normalizedIdentity,
    bodySha256,
    timestamp,
    nonce,
  ].join('\n');

  const signature = crypto.createHmac('sha256', secret).update(canonical).digest('hex');

  return {
    'x-manifest-auth-version': MANIFEST_SYNC_AUTH_VERSION,
    'x-manifest-identity': normalizedIdentity,
    'x-manifest-timestamp': timestamp,
    'x-manifest-nonce': nonce,
    'x-manifest-body-sha256': bodySha256,
    'x-manifest-signature': signature,
  };
}

async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = Math.max(500, Number(options.timeoutMs || MANIFEST_SYNC_TIMEOUT_MS));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Manifest sync timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

function isDriveMetadataManifest(manifest = {}) {
  return manifest?.type === 'drive-folders-v1' || manifest?.hash === '__drive_folders_v1__';
}

function sanitizePulledManifest(manifest = {}) {
  if (!manifest || typeof manifest !== 'object') return null;
  if (isDriveMetadataManifest(manifest)) {
    if (!manifest.ownerWallet) return null;
    return {
      ...manifest,
      type: 'drive-folders-v1',
      hash: '__drive_folders_v1__',
      name: '__drive_folders_v1__',
      ownerWallet: normalizeIdentity(manifest.ownerWallet),
      isEncrypted: false,
      visibility: 'private',
      isPublic: false,
      folders: Array.isArray(manifest.folders) ? manifest.folders : [],
      fileFolders: manifest.fileFolders && typeof manifest.fileFolders === 'object' ? manifest.fileFolders : {},
    };
  }
  if (!manifest.hash || !manifest.ownerWallet) return null;
  if (isBadEncryptedManifest(manifest)) return null;
  return {
    ...manifest,
    ownerWallet: normalizeIdentity(manifest.ownerWallet),
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
  const identity = normalizeIdentity(walletAddress);
  if (!validIdentity(identity)) throw new Error('Valid wallet or seed identity required for manifest sync pull');
  const response = await fetchWithTimeout(`${manifestSyncBaseUrl()}/wallet/${identityPath(identity)}/manifests`);
  const data = await parseJsonResponse(response);
  const incoming = Array.isArray(data.manifests) ? data.manifests : [];
  const clean = [];
  let skipped = 0;
  for (const item of incoming) {
    const manifest = sanitizePulledManifest(item);
    if (manifest) clean.push(manifest);
    else skipped += 1;
  }
  if (skipped) console.warn(`[manifest-sync] skipped ${skipped} invalid manifest(s) from remote`);
  return clean;
}

export async function pushWalletManifest(manifest = {}) {
  const identity = normalizeIdentity(manifest.ownerWallet);
  if (!validIdentity(identity)) throw new Error('Valid wallet or seed identity required for manifest sync push');
  if (isBadEncryptedManifest(manifest)) {
    throw new Error('Refusing to sync encrypted manifest without encryption metadata');
  }
  const isMetadata = isDriveMetadataManifest(manifest);
  const payload = {
    manifest: isMetadata ? {
      ...manifest,
      type: 'drive-folders-v1',
      hash: '__drive_folders_v1__',
      name: '__drive_folders_v1__',
      ownerWallet: identity,
      isEncrypted: false,
      visibility: 'private',
      isPublic: false,
      size: 0,
      storedSize: 0,
      totalChunks: 0,
      chunks: [],
      updatedAt: new Date().toISOString(),
    } : {
      ...manifest,
      ownerWallet: identity,
      visibility: manifest.visibility || (manifest.isEncrypted ? 'private' : 'public'),
      isPublic: manifest.isPublic === true || manifest.visibility === 'public' || manifest.isEncrypted === false,
    },
  };

  const requestPath = `/wallet/${identityPath(identity)}/manifests`;
  const body = JSON.stringify(payload);
  const response = await fetchWithTimeout(`${manifestSyncBaseUrl()}${requestPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...signManifestSyncRequest({ method: 'POST', path: requestPath, identity, body }),
    },
    body,
  });
  return parseJsonResponse(response);
}

export async function deleteWalletManifest(walletAddress, hash) {
  const identity = normalizeIdentity(walletAddress);
  if (!validIdentity(identity)) throw new Error('Valid wallet or seed identity required for manifest sync delete');
  if (!hash) throw new Error('Manifest hash required for delete');
  const requestPath = `/wallet/${identityPath(identity)}/manifests/${encodeURIComponent(hash)}`;
  const body = '';
  const response = await fetchWithTimeout(`${manifestSyncBaseUrl()}${requestPath}`, {
    method: 'DELETE',
    headers: {
      ...signManifestSyncRequest({ method: 'DELETE', path: requestPath, identity, body }),
    },
  });
  return parseJsonResponse(response);
}

export async function searchPublicManifests(query = '') {
  const q = String(query || '').trim();
  const response = await fetchWithTimeout(`${manifestSyncBaseUrl()}/public/manifests?q=${encodeURIComponent(q)}`);
  const data = await parseJsonResponse(response);
  return Array.isArray(data.manifests) ? data.manifests : [];
}