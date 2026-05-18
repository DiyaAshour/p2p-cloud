const fs = require('fs');
const path = require('path');

const file = path.join(process.cwd(), 'electron', 'main-stable.js');

if (!fs.existsSync(file)) {
  throw new Error(`Missing ${file}`);
}

let s = fs.readFileSync(file, 'utf8');

function insertBefore(marker, block, guard) {
  if (s.includes(guard)) return false;
  const idx = s.indexOf(marker);
  if (idx < 0) throw new Error(`Marker not found: ${marker}`);
  s = s.slice(0, idx) + block.trim() + '\n\n' + s.slice(idx);
  return true;
}

if (!s.includes('const FOLDER_MANIFEST_KIND')) {
  s = s.replace(
    /const WALLET_LOGIN_MAX_FUTURE_MS = .*?;\s*/,
    (match) => `${match}const FOLDER_MANIFEST_KIND = 'folder';\n`
  );
}

const helpers = `
function findOrFallbackManifestItem(payload = {}) {
  const lookupId = String(
    payload.itemId ||
    payload.id ||
    payload.hash ||
    payload.rootHash ||
    payload.folderId ||
    payload.folderPath ||
    payload.name ||
    ''
  ).trim();

  let item = typeof findOwnedManifestItemById === 'function'
    ? findOwnedManifestItemById(lookupId)
    : null;

  if (item) return item;

  const cleanId = lookupId.replace(/^folder:/, '').trim();

  if (!cleanId) return null;

  return {
    kind: typeof FOLDER_MANIFEST_KIND !== 'undefined' ? FOLDER_MANIFEST_KIND : 'folder',
    type: 'folder',
    isFolder: true,
    folderId: cleanId,
    id: cleanId,
    hash: \`folder:\${cleanId}\`,
    rootHash: \`folder:\${cleanId}\`,
    ownerWallet: typeof folderOwnerIdentity === 'function' ? folderOwnerIdentity() : activeWallet(),
    name: String(payload.name || payload.folderPath || cleanId),
    visibility: 'private',
    isPublic: false,
    isEncrypted: false,
    chunks: [],
    chunkSize: 0,
    totalChunks: 0,
    size: 0,
    storedSize: 0,
    updatedAt: new Date().toISOString(),
  };
}

function manifestItemIsFolder(item = {}) {
  if (typeof isFolderManifest === 'function') return isFolderManifest(item);

  return (
    item.kind === 'folder' ||
    item.type === 'folder' ||
    item.isFolder === true ||
    item.name === '.p2p-folder' ||
    Boolean(item.folderId && !item.chunks?.length) ||
    String(item.hash || '').startsWith('folder:')
  );
}

function manifestItemIds(item = {}) {
  const hash = String(item.hash || '').trim();
  const rootHash = String(item.rootHash || '').trim();

  return Array.from(new Set([
    item.itemId,
    item.id,
    item.fileId,
    item.folderId,
    hash,
    rootHash,
    hash.replace(/^folder:/, ''),
    rootHash.replace(/^folder:/, ''),
    item.name,
  ].map((value) => String(value || '').trim()).filter(Boolean)));
}

function manifestItemMatchesAnyId(item = {}, ids = new Set()) {
  const normalized = new Set(
    Array.from(ids || [])
      .map((value) => String(value || '').replace(/^folder:/, '').trim())
      .filter(Boolean)
  );

  return manifestItemIds(item).some((id) => {
    const clean = String(id || '').replace(/^folder:/, '').trim();
    return normalized.has(id) || normalized.has(clean);
  });
}

function manifestOwnNameLower(item = {}) {
  return String(item.name || '').trim().toLowerCase();
}

function normalizeParentFolderId(value = '') {
  return String(value || '').replace(/^folder:/, '').trim();
}

function manifestFolderNameLower(item = {}) {
  return String(item.folderName || item.folder || '').trim().toLowerCase();
}

function manifestDeleteOwnerIdentity() {
  return typeof folderOwnerIdentity === 'function' ? folderOwnerIdentity() : activeWallet();
}

function assertValidMoveTarget(item = {}, targetFolderId = null) {
  const targetId = String(targetFolderId || '').replace(/^folder:/, '').trim();

  // Empty target means root / Uncategorized.
  if (!targetId) return null;

  const folders =
    typeof walletFolderManifests === 'function'
      ? walletFolderManifests()
      : walletManifests().filter((m) =>
          typeof manifestItemIsFolder === 'function'
            ? manifestItemIsFolder(m)
            : (m.kind === 'folder' || m.isFolder === true || String(m.hash || '').startsWith('folder:'))
        );

  const targetFolder = folders.find((folder) => {
    const ids =
      typeof manifestItemIds === 'function'
        ? manifestItemIds(folder)
        : [folder.folderId, folder.id, folder.hash, folder.rootHash];

    return ids
      .map((id) => String(id || '').replace(/^folder:/, '').trim())
      .includes(targetId);
  });

  if (!targetFolder) {
    throw new Error(\`Target folder not found: \${targetId}\`);
  }

  const sourceIsFolder =
    typeof manifestItemIsFolder === 'function'
      ? manifestItemIsFolder(item)
      : (item.kind === 'folder' || item.isFolder === true || String(item.hash || '').startsWith('folder:'));

  if (!sourceIsFolder) {
    return targetFolder;
  }

  const sourceIds =
    typeof manifestItemIds === 'function'
      ? manifestItemIds(item)
      : [item.folderId, item.id, item.hash, item.rootHash];

  const sourceSet = new Set(
    sourceIds
      .map((id) => String(id || '').replace(/^folder:/, '').trim())
      .filter(Boolean)
  );

  if (sourceSet.has(targetId)) {
    throw new Error('Cannot move folder into itself');
  }

  let cursor = String(targetFolder.parentFolderId || '')
    .replace(/^folder:/, '')
    .trim();

  const seen = new Set();

  while (cursor) {
    if (sourceSet.has(cursor)) {
      throw new Error('Cannot move folder inside its child');
    }

    if (seen.has(cursor)) {
      throw new Error('Folder tree cycle detected');
    }

    seen.add(cursor);

    const parent = folders.find((folder) => {
      const ids =
        typeof manifestItemIds === 'function'
          ? manifestItemIds(folder)
          : [folder.folderId, folder.id, folder.hash, folder.rootHash];

      return ids
        .map((id) => String(id || '').replace(/^folder:/, '').trim())
        .includes(cursor);
    });

    cursor = String(parent?.parentFolderId || '')
      .replace(/^folder:/, '')
      .trim();
  }

  return targetFolder;
}
`;

insertBefore("ipcMain.handle('p2p:moveItem'", helpers, 'function findOrFallbackManifestItem');

const lookupPattern = /const\s+item\s*=\s*findOwnedManifestItemById\(\s*payload\.itemId\s*\|\|\s*payload\.id\s*\|\|\s*payload\.hash\s*\|\|\s*payload\.rootHash\s*\|\|\s*payload\.folderId\s*\);\s*if\s*\(!item\)\s*throw\s+new\s+Error\('Item not found'\);/g;

let replaced = 0;
s = s.replace(lookupPattern, () => {
  replaced += 1;
  return "const item = findOrFallbackManifestItem(payload);\n  if (!item) throw new Error(`Item not found. payload=${JSON.stringify(payload)}`);";
});

if (!s.includes('function findOwnedManifestItemById')) {
  const findOwnedManifestItemById = `
function findOwnedManifestItemById(itemId = '') {
  const id = String(itemId || '').trim();

  if (!id) return null;

  const cleanId = id.replace(/^folder:/, '').trim();
  const list = Array.isArray(manifests) ? manifests : [];

  const candidates = list
    .filter(isUsableManifest)
    .filter((manifest) => {
      if (typeof canTouchManifest === 'function') return canTouchManifest(manifest);
      return walletOwnsManifest(manifest);
    });

  const found = candidates.find((manifest) => {
    const hash = String(manifest.hash || '').trim();
    const rootHash = String(manifest.rootHash || '').trim();

    const values = [
      manifest.id,
      manifest.fileId,
      manifest.folderId,
      manifest.itemId,
      hash,
      rootHash,
      hash.replace(/^folder:/, ''),
      rootHash.replace(/^folder:/, ''),
      manifest.name,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);

    return values.includes(id) || values.includes(cleanId);
  });

  return found || null;
}
`;

  insertBefore("ipcMain.handle('p2p:deleteItem'", findOwnedManifestItemById, 'function findOwnedManifestItemById');
}

fs.writeFileSync(file, s, 'utf8');

console.log('[patch-folder-actions-stable-final] applied', {
  file,
  replaced,
  hasFallback: s.includes('function findOrFallbackManifestItem'),
  hasManifestItemIsFolder: s.includes('function manifestItemIsFolder'),
  hasAssertValidMoveTarget: s.includes('function assertValidMoveTarget'),
  oldItemNotFoundLeft: s.includes("throw new Error('Item not found')"),
});
