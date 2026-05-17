const fs = require('node:fs');
const path = require('node:path');

const liveFile = 'client/src/NativeP2PAppLive.tsx';
const preloadFile = path.join('electron', 'preload.cjs');

if (!fs.existsSync(liveFile)) {
  console.warn('[patch-live-folder-no-helper] NativeP2PAppLive not found');
  process.exit(0);
}

let s = fs.readFileSync(liveFile, 'utf8');
const before = s;

s = s.replace(
  /const key = \(view === "company" \|\| view === "admin"\) && activeWorkspace \? companyFolderKey\(activeWorkspace\.workspaceId, folder\) : personalFolderKey\(folder\);/g,
  'const key = (view === "company" || view === "admin") && activeWorkspace ? ("company:" + activeWorkspace.workspaceId + ":folder:" + folder) : ("personal:folder:" + folder);'
);

// Do not depend on identityLabel here. In some restored UI variants folderIdentityReady
// is injected before identityLabel, which causes a temporal-dead-zone crash.
s = s.replace(
  /const folderIdentityReady = Boolean\([^\n]*\);/g,
  'const folderIdentityReady = Boolean(wallet?.connected || wallet?.accountId || wallet?.address || wallet?.username || wallet?.seedFingerprint || wallet?.authMode === "seed");'
);

if (s.includes('personalFolderKey(folder)') || s.includes('companyFolderKey(activeWorkspace.workspaceId, folder)')) {
  console.error('[patch-live-folder-no-helper] helper calls still exist');
  process.exit(1);
}

if (s.includes('identityLabel !== "Guest"')) {
  console.error('[patch-live-folder-no-helper] identityLabel dependency still exists');
  process.exit(1);
}

if (!s.includes('wallet?.seedFingerprint || wallet?.authMode === "seed"')) {
  console.error('[patch-live-folder-no-helper] folderIdentityReady repair failed');
  process.exit(1);
}

if (s !== before) {
  fs.writeFileSync(liveFile, s, 'utf8');
}

let preloadChanged = false;
if (fs.existsSync(preloadFile)) {
  let preload = fs.readFileSync(preloadFile, 'utf8');
  const preloadBefore = preload;
  for (const channel of ['drive:getFolders', 'drive:saveFolders']) {
    if (!preload.includes("'" + channel + "'")) {
      preload = preload.replace("  'p2p:listFiles',\n", "  'p2p:listFiles',\n  '" + channel + "',\n");
    }
  }
  preload = preload.replace(
    "channel.startsWith('company:')",
    "channel.startsWith('company:') || channel.startsWith('drive:')"
  );
  if (preload !== preloadBefore) {
    fs.writeFileSync(preloadFile, preload, 'utf8');
    preloadChanged = true;
  }
}

if (s !== before || preloadChanged) {
  console.log('[patch-live-folder-no-helper] fixed folder create helpers and allowed drive IPC');
} else {
  console.log('[patch-live-folder-no-helper] already safe');
}
