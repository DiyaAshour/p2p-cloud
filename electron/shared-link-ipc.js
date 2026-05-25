import { ipcMain } from 'electron';
import { activeIdentity, assertVerifiedIdentity, normalizeIdentity } from './core/identity.js';
import { readWallet, readManifests, writeManifests } from './core/storage-json.js';

function base64UrlDecodeJson(value = '') {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function parseSharedFileLink(link = '') {
  const raw = String(link || '').trim();
  if (!raw) throw new Error('Shared link is required.');

  let rootHash = '';
  let manifest = null;

  if (/^[a-f0-9]{64}$/i.test(raw)) {
    rootHash = raw.toLowerCase();
  } else if (raw.startsWith('chunknet://file/')) {
    const parsed = new URL(raw);
    rootHash = parsed.pathname.replace(/^\//, '').trim().toLowerCase();
    const encodedManifest = parsed.searchParams.get('manifest') || parsed.searchParams.get('m');
    if (encodedManifest) manifest = base64UrlDecodeJson(encodedManifest);
  } else if (raw.startsWith('chunknet://')) {
    const parsed = new URL(raw);
    rootHash = (parsed.hostname || parsed.pathname.replace(/^\//, '')).trim().toLowerCase();
    const encodedManifest = parsed.searchParams.get('manifest') || parsed.searchParams.get('m');
    if (encodedManifest) manifest = base64UrlDecodeJson(encodedManifest);
  } else {
    throw new Error('Invalid Chunknet shared link.');
  }

  rootHash = String(rootHash || manifest?.rootHash || manifest?.hash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(rootHash)) {
    throw new Error('Shared link is missing a valid root hash.');
  }

  return { rootHash, manifest };
}

function sanitizeSharedManifest(manifest, rootHash, ownerWallet) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Shared link does not include a file manifest yet. Ask the sender to copy a fresh share link.');
  }

  const actualRoot = String(manifest.rootHash || manifest.hash || '').toLowerCase();
  if (actualRoot !== rootHash) {
    throw new Error('Shared link manifest does not match the root hash.');
  }

  if (manifest.isEncrypted) {
    throw new Error('This is an encrypted private file. Share Key support is the next step.');
  }

  if (!Array.isArray(manifest.chunks) || !manifest.chunks.length) {
    throw new Error('Shared manifest has no chunks.');
  }

  return {
    ...manifest,
    id: `${ownerWallet}:${manifest.hash || rootHash}:shared`,
    rootHash,
    hash: String(manifest.hash || rootHash).toLowerCase(),
    ownerWallet,
    originalOwnerWallet: manifest.ownerWallet || '',
    importedFromSharedLink: true,
    importedAt: new Date().toISOString(),
    visibility: 'shared',
    isPublic: true,
    isEncrypted: false,
  };
}

async function networkSummarySafe() {
  try {
    const handler = ipcMain._invokeHandlers?.get?.('p2p:networkSummary');
    return handler ? await handler({}, {}) : null;
  } catch {
    return null;
  }
}

async function importSharedLinkToMyDrive(link = '') {
  const wallet = readWallet();
  assertVerifiedIdentity(wallet);
  const ownerWallet = activeIdentity(wallet);

  const { rootHash, manifest } = parseSharedFileLink(link);
  const current = readManifests();
  const source = manifest || current.find((item) => item.rootHash === rootHash || item.hash === rootHash);
  const imported = sanitizeSharedManifest(source, rootHash, ownerWallet);

  const next = current.filter((item) => {
    const sameOwner = normalizeIdentity(item.ownerWallet) === ownerWallet;
    const sameFile = item.rootHash === imported.rootHash || item.hash === imported.hash;
    return !(sameOwner && sameFile);
  });

  next.push(imported);
  writeManifests(next);

  return {
    ok: true,
    file: imported,
    summary: await networkSummarySafe(),
  };
}

try { ipcMain.removeHandler('p2p:importSharedLink'); } catch {}
ipcMain.handle('p2p:importSharedLink', async (_event, payload = {}) => {
  return importSharedLinkToMyDrive(payload.link);
});

console.log('[shared-link] shared link IPC installed');
