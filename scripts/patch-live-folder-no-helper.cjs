const fs = require('node:fs');

const file = 'client/src/NativeP2PAppLive.tsx';
if (!fs.existsSync(file)) {
  console.warn('[patch-live-folder-no-helper] NativeP2PAppLive not found');
  process.exit(0);
}

let s = fs.readFileSync(file, 'utf8');
const before = s;

s = s.replace(
  /const key = \(view === "company" \|\| view === "admin"\) && activeWorkspace \? companyFolderKey\(activeWorkspace\.workspaceId, folder\) : personalFolderKey\(folder\);/g,
  'const key = (view === "company" || view === "admin") && activeWorkspace ? ("company:" + activeWorkspace.workspaceId + ":folder:" + folder) : ("personal:folder:" + folder);'
);

if (s.includes('personalFolderKey(folder)') || s.includes('companyFolderKey(activeWorkspace.workspaceId, folder)')) {
  console.error('[patch-live-folder-no-helper] helper calls still exist');
  process.exit(1);
}

if (s !== before) {
  fs.writeFileSync(file, s, 'utf8');
  console.log('[patch-live-folder-no-helper] replaced missing folder key helpers');
} else {
  console.log('[patch-live-folder-no-helper] already safe');
}
