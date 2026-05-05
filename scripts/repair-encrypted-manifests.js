import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MANIFEST_SYNC_URL = (process.env.MANIFEST_SYNC_URL || process.env.P2P_MANIFEST_SYNC_URL || 'http://54.166.171.208:8790').replace(/\/$/, '');

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
  throw new Error('Could not find local manifests.json. Set P2P_MANIFESTS_PATH to the file path.');
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
  const repairable = manifests.filter(isRepairable);
  console.log(`[repair-manifests] source: ${file}`);
  console.log(`[repair-manifests] manifest-sync: ${MANIFEST_SYNC_URL}`);
  console.log(`[repair-manifests] encrypted manifests with metadata: ${repairable.length}`);

  let ok = 0;
  for (const manifest of repairable) {
    await pushManifest(manifest);
    ok += 1;
    console.log(`[repair-manifests] pushed ${ok}/${repairable.length}: ${manifest.name} ${manifest.hash}`);
  }

  console.log(`[repair-manifests] done. Reopen the app, reconnect wallet, then try download again.`);
}

main().catch((error) => {
  console.error(`[repair-manifests] failed: ${error?.message || error}`);
  process.exit(1);
});
