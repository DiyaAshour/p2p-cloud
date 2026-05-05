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

function loadLocalManifests() {
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

function isRepairable(manifest) {
  return Boolean(
    manifest &&
    manifest.isEncrypted === true &&
    manifest.encryption &&
    manifest.encryption.algorithm &&
    manifest.encryption.salt &&
    manifest.encryption.iv &&
    manifest.encryption.authTag &&
    manifest.hash &&
    normalizeWallet(manifest.ownerWallet)
  );
}

async function pushManifest(manifest) {
  const wallet = normalizeWallet(manifest.ownerWallet);
  const response = await fetch(`${MANIFEST_SYNC_URL}/wallet/${wallet}/manifests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: { ...manifest, ownerWallet: wallet, visibility: 'private', isPublic: false } }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function main() {
  const { file, manifests } = loadLocalManifests();
  if (!file) {
    console.log('[repair-manifests] no local manifests.json found; skipping auto repair');
    return;
  }

  const repairable = manifests.filter(isRepairable);
  console.log(`[repair-manifests] source: ${file}`);
  console.log(`[repair-manifests] manifest-sync: ${MANIFEST_SYNC_URL}`);
  console.log(`[repair-manifests] encrypted manifests with metadata: ${repairable.length}`);

  let ok = 0;
  for (const manifest of repairable) {
    try {
      await pushManifest(manifest);
      ok += 1;
      console.log(`[repair-manifests] pushed ${ok}/${repairable.length}: ${manifest.name} ${manifest.hash}`);
    } catch (error) {
      console.warn(`[repair-manifests] skipped ${manifest.name || manifest.hash}: ${error?.message || error}`);
    }
  }

  console.log(`[repair-manifests] done. repaired=${ok}/${repairable.length}`);
}

main().catch((error) => {
  console.warn(`[repair-manifests] ${AUTO_MODE ? 'auto repair skipped' : 'repair failed'}: ${error?.message || error}`);
  process.exit(AUTO_MODE ? 0 : 1);
});
