const fs = require('node:fs');
const path = require('node:path');

const mainPath = path.join(process.cwd(), 'electron', 'main-stable.js');
const preloadPath = path.join(process.cwd(), 'electron', 'preload.cjs');

function patchMain() {
  if (!fs.existsSync(mainPath)) return console.warn('[shared-link] main-stable.js missing; skipping');
  let s = fs.readFileSync(mainPath, 'utf8');

  if (!s.includes('function parseSharedFileLink(')) {
    const anchor = "function findManifest(payload = {}) { const hash = String(payload.hash || ''); const rootHash = String(payload.rootHash || ''); return walletManifests().find((m) => m.hash === hash || m.rootHash === rootHash); }";
    const injected = [
      anchor,
      "function base64UrlDecodeJson(value = '') { const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/'); const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='); return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')); }",
      "function parseSharedFileLink(link = '') { const raw = String(link || '').trim(); if (!raw) throw new Error('Shared link is required.'); let rootHash = ''; let manifest = null; if (raw.startsWith('chunknet://file/')) { const parsed = new URL(raw); rootHash = parsed.hostname || parsed.pathname.replace(/^\\//, ''); const encodedManifest = parsed.searchParams.get('manifest') || parsed.searchParams.get('m'); if (encodedManifest) manifest = base64UrlDecodeJson(encodedManifest); } else if (/^[a-f0-9]{64}$/i.test(raw)) { rootHash = raw.toLowerCase(); } else { throw new Error('Invalid Chunknet shared link.'); } rootHash = String(rootHash || manifest?.rootHash || manifest?.hash || '').toLowerCase(); if (!/^[a-f0-9]{64}$/.test(rootHash)) throw new Error('Shared link is missing a valid root hash.'); return { rootHash, manifest }; }",
      "function sanitizeSharedManifest(manifest, rootHash) { if (!manifest || typeof manifest !== 'object') throw new Error('Shared link does not include a file manifest yet. Ask the sender to copy a fresh share link.'); const actualRoot = String(manifest.rootHash || manifest.hash || '').toLowerCase(); if (actualRoot !== rootHash) throw new Error('Shared link manifest does not match the root hash.'); if (manifest.isEncrypted) throw new Error('This is an encrypted private file. Share Key support is the next step.'); if (!Array.isArray(manifest.chunks) || !manifest.chunks.length) throw new Error('Shared manifest has no chunks.'); return { ...manifest, id: activeWallet() + ':' + (manifest.hash || rootHash) + ':shared', rootHash, hash: String(manifest.hash || rootHash).toLowerCase(), ownerWallet: activeWallet(), originalOwnerWallet: manifest.ownerWallet || '', importedFromSharedLink: true, importedAt: new Date().toISOString(), visibility: 'shared', isPublic: true, isEncrypted: false }; }",
      "function importSharedLinkToMyDrive(link = '') { assertVerifiedWallet(); ensureDataDir(); loadManifests(); const { rootHash, manifest } = parseSharedFileLink(link); const source = manifest || manifests.find((item) => item.rootHash === rootHash || item.hash === rootHash); const imported = sanitizeSharedManifest(source, rootHash); manifests = manifests.filter((item) => !(normalizeWallet(item.ownerWallet) === activeWallet() && (item.rootHash === imported.rootHash || item.hash === imported.hash))); manifests.push(imported); persistManifests(); return { ok: true, file: imported, summary: networkSummary() }; }"
    ].join('\n');

    if (s.includes(anchor)) s = s.replace(anchor, injected);
    else console.warn('[shared-link] findManifest anchor not found; skipping main helper injection');
  }

  if (!s.includes("ipcMain.handle('p2p:importSharedLink'")) {
    s = s.replace(
      "ipcMain.handle('p2p:upload', async () => { throw new Error('Use native streaming upload. Browser RAM upload is disabled.'); });",
      "ipcMain.handle('p2p:upload', async () => { throw new Error('Use native streaming upload. Browser RAM upload is disabled.'); });\nipcMain.handle('p2p:importSharedLink', async (_event, payload = {}) => importSharedLinkToMyDrive(payload.link));"
    );
  }

  fs.writeFileSync(mainPath, s, 'utf8');
}

function patchPreload() {
  if (!fs.existsSync(preloadPath)) return console.warn('[shared-link] preload.cjs missing; skipping');
  let s = fs.readFileSync(preloadPath, 'utf8');
  if (!s.includes("'p2p:importSharedLink'")) {
    s = s.replace("  'p2p:uploadFiles',\n", "  'p2p:uploadFiles',\n  'p2p:importSharedLink',\n");
  }
  fs.writeFileSync(preloadPath, s, 'utf8');
}

patchMain();
patchPreload();
console.log('[shared-link] import shared link IPC enabled');
