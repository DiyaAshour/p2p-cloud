import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MANIFEST_SYNC_URL = (process.env.MANIFEST_SYNC_URL || process.env.P2P_MANIFEST_SYNC_URL || 'http://54.166.171.208:8790').replace(/\/$/, '');
const AUTO_MODE = process.env.P2P_AUTO_REPAIR_MANIFESTS !== '0';

function candidateManifestPaths() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    process.env.P2P_MANIFESTS_PATH,
    path.join(appData, 'p2p.cloud', 'native-p2p-storage', 'manifests.json'),
    path.join(appData, 'p2p-cloud', 'native-p2p-storage', 'manifests.json'),
    path.join(xdg, 'p2p.cloud', 'native-p2p-storage', 'manifests.json'),
    path.join(xdg, 'p2p-cloud', 'native-p2p-storage', 'manifests.json'),
  ].filter(Boolean);
}

function loadLocalManifestsFile() {
  for (const file of candidateManifestPaths()) {
    if (!file || !fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) return { file, manifests: parsed };
  }
  return { file: null, manifests: [] };
}

function normalizeWallet(address = '') {
  return String(address || '').trim().toLowerCase();
}

function hasEncryptionMetadata(manifest) {
  return Boolean(
    manifest?.encryption &&
    manifest.encryption.algorithm &&
    manifest.encryption.salt &&
    manifest.encryption.iv &&
    manifest.encryption.authTag
  );
}

function isBadEncryptedManifest(manifest) {
  return Boolean(manifest?.isEncrypted === true && !hasEncryptionMetadata(manifest));
}

async function deleteRemote(wallet, hash) {
  const response = await fetch(`${MANIFEST_SYNC_URL}/wallet/${wallet}/manifests/${encodeURIComponent(hash)}`, { method: 'DELETE' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
}

async function fetchRemote(wallet) {
  const response = await fetch(`${MANIFEST_SYNC_URL}/wallet/${wallet}/manifests`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return Array.isArray(data.manifests) ? data.manifests : [];
}

async function main() {
  const { file, manifests } = loadLocalManifestsFile();
  if (!file) {
    console.log('[cleanup-manifests] no local manifests.json found; skipping cleanup');
    return;
  }

  const wallets = Array.from(new Set(manifests.map((m) => normalizeWallet(m.ownerWallet)).filter(Boolean)));
  const badLocal = manifests.filter(isBadEncryptedManifest);
  const cleanLocal = manifests.filter((m) => !isBadEncryptedManifest(m));

  if (badLocal.length) {
    fs.writeFileSync(file, JSON.stringify(cleanLocal, null, 2), 'utf8');
    console.log(`[cleanup-manifests] removed ${badLocal.length} bad encrypted local manifest(s)`);
  } else {
    console.log('[cleanup-manifests] no bad local encrypted manifests found');
  }

  for (const wallet of wallets) {
    try {
      const remote = await fetchRemote(wallet);
      const badRemote = remote.filter(isBadEncryptedManifest);
      for (const item of badRemote) {
        await deleteRemote(wallet, item.hash);
        console.log(`[cleanup-manifests] deleted bad remote manifest ${item.name || item.hash}`);
      }
    } catch (error) {
      console.warn(`[cleanup-manifests] wallet ${wallet} skipped: ${error?.message || error}`);
    }
  }

  console.log('[cleanup-manifests] done');
}

main().catch((error) => {
  console.warn(`[cleanup-manifests] ${AUTO_MODE ? 'cleanup skipped' : 'cleanup failed'}: ${error?.message || error}`);
  process.exit(AUTO_MODE ? 0 : 1);
});
