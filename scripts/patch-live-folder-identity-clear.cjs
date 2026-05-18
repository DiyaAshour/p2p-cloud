const fs = require('node:fs');

const p = 'client/src/NativeP2PAppLive.tsx';
if (!fs.existsSync(p)) {
  console.warn('[patch-live-folder-identity-clear] NativeP2PAppLive not found');
  process.exit(0);
}

// Retired legacy patch.
// The current folder UI is manifest-backed and owned by patch-live-network-folders.cjs.
// This old patch used folderParents/setFolderParents and could reintroduce undefined
// state or override driveFolders, so it must not mutate NativeP2PAppLive anymore.
const s = fs.readFileSync(p, 'utf8');

if (s.includes('const [driveFolders, setDriveFolders]') || s.includes('p2p:createFolder') || s.includes('const renameFolder = (folderName: string) =>')) {
  console.log('[patch-live-folder-identity-clear] retired legacy patch skipped; network folder UI owns identity clearing');
} else {
  console.log('[patch-live-folder-identity-clear] retired legacy patch skipped; patch-live-network-folders will install current folder behavior');
}
