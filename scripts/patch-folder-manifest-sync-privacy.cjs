const fs = require('node:fs');
const path = require('node:path');

const filePath = path.join(process.cwd(), 'electron', 'manifest-sync.js');
if (!fs.existsSync(filePath)) {
  console.warn('[patch-folder-manifest-sync-privacy] manifest-sync.js not found');
  process.exit(0);
}

let src = fs.readFileSync(filePath, 'utf8');
const before = src;

function warn(label) { console.warn('[patch-folder-manifest-sync-privacy] skipped:', label); }
function replaceOnce(search, replacement, label) {
  if (!src.includes(search)) { warn(label); return; }
  src = src.replace(search, replacement);
}

if (!src.includes('function isFolderManifest')) {
  replaceOnce(
    "function isDriveMetadataManifest(manifest = {}) {\n  return manifest?.type === 'drive-folders-v1' || manifest?.hash === '__drive_folders_v1__';\n}\n",
    "function isDriveMetadataManifest(manifest = {}) {\n  return manifest?.type === 'drive-folders-v1' || manifest?.hash === '__drive_folders_v1__';\n}\n\nfunction isFolderManifest(manifest = {}) {\n  return manifest?.kind === 'folder' || manifest?.isFolder === true || String(manifest?.hash || '').startsWith('folder:');\n}\n",
    'add isFolderManifest'
  );
}

if (!src.includes('kind: \'folder\',')) {
  replaceOnce(
    "  if (!manifest.hash || !manifest.ownerWallet) return null;\n  if (isBadEncryptedManifest(manifest)) return null;\n  return {",
    "  if (isFolderManifest(manifest)) {\n    if (!manifest.hash || !manifest.ownerWallet || !manifest.folderId) return null;\n    return {\n      ...manifest,\n      kind: 'folder',\n      isFolder: true,\n      ownerWallet: normalizeIdentity(manifest.ownerWallet),\n      isEncrypted: false,\n      visibility: 'private',\n      isPublic: false,\n      size: 0,\n      storedSize: 0,\n      totalChunks: 0,\n      chunks: [],\n      replicas: Array.isArray(manifest.replicas) ? manifest.replicas : [],\n    };\n  }\n  if (!manifest.hash || !manifest.ownerWallet) return null;\n  if (isBadEncryptedManifest(manifest)) return null;\n  return {",
    'sanitize folder manifest as private'
  );
}

if (!src.includes('const isFolder = isFolderManifest(manifest);')) {
  replaceOnce(
    "  const isMetadata = isDriveMetadataManifest(manifest);\n  const payload = {",
    "  const isMetadata = isDriveMetadataManifest(manifest);\n  const isFolder = isFolderManifest(manifest);\n  const payload = {",
    'add isFolder flag'
  );
}

replaceOnce(
  "    manifest: isMetadata ? {\n      ...manifest,\n      type: 'drive-folders-v1',\n      hash: '__drive_folders_v1__',\n      name: '__drive_folders_v1__',\n      ownerWallet: identity,\n      isEncrypted: false,\n      visibility: 'private',\n      isPublic: false,\n      size: 0,\n      storedSize: 0,\n      totalChunks: 0,\n      chunks: [],\n      updatedAt: new Date().toISOString(),\n    } : {\n      ...manifest,\n      ownerWallet: identity,\n      visibility: manifest.visibility || (manifest.isEncrypted ? 'private' : 'public'),\n      isPublic: manifest.isPublic === true || manifest.visibility === 'public' || manifest.isEncrypted === false,\n    },",
  "    manifest: isMetadata ? {\n      ...manifest,\n      type: 'drive-folders-v1',\n      hash: '__drive_folders_v1__',\n      name: '__drive_folders_v1__',\n      ownerWallet: identity,\n      isEncrypted: false,\n      visibility: 'private',\n      isPublic: false,\n      size: 0,\n      storedSize: 0,\n      totalChunks: 0,\n      chunks: [],\n      updatedAt: new Date().toISOString(),\n    } : isFolder ? {\n      ...manifest,\n      kind: 'folder',\n      isFolder: true,\n      ownerWallet: identity,\n      isEncrypted: false,\n      visibility: 'private',\n      isPublic: false,\n      size: 0,\n      storedSize: 0,\n      totalChunks: 0,\n      chunks: [],\n      replicas: Array.isArray(manifest.replicas) ? manifest.replicas : [],\n      updatedAt: manifest.updatedAt || new Date().toISOString(),\n    } : {\n      ...manifest,\n      ownerWallet: identity,\n      visibility: manifest.visibility || (manifest.isEncrypted ? 'private' : 'public'),\n      isPublic: manifest.isPublic === true || manifest.visibility === 'public' || manifest.isEncrypted === false,\n    },",
  'push folder manifest as private'
);

if (src !== before) {
  fs.writeFileSync(filePath, src, 'utf8');
  console.log('[patch-folder-manifest-sync-privacy] folder manifests forced private in sync layer.');
} else {
  console.log('[patch-folder-manifest-sync-privacy] no changes needed.');
}
