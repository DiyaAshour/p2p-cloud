const fs = require('node:fs');
const path = require('node:path');

const liveFile = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');

if (!fs.existsSync(liveFile)) {
  console.warn('[patch-live-folder-actions] NativeP2PAppLive not found');
  process.exit(0);
}

// Retired legacy patch.
// The live folder UI is now owned by scripts/patch-live-network-folders.cjs and the
// manifest-backed p2p:* folder IPCs. This file intentionally does not inject the old
// drive:getFolders / drive:saveFolders UI anymore, because it can override the
// network-folder UI and remove driveFolders state.
const source = fs.readFileSync(liveFile, 'utf8');

if (source.includes('const [driveFolders, setDriveFolders]') || source.includes('p2p:createFolder') || source.includes('const renameFolder = (folderName: string) =>')) {
  console.log('[patch-live-folder-actions] retired legacy patch skipped; network folder UI is present');
} else {
  console.log('[patch-live-folder-actions] retired legacy patch skipped; patch-live-network-folders will install folder UI');
}
