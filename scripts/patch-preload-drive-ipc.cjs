const fs = require('node:fs');
const path = require('node:path');

const preloadPath = path.join(process.cwd(), 'electron', 'preload.cjs');
if (!fs.existsSync(preloadPath)) {
  console.error('[patch-preload-drive-ipc] missing electron/preload.cjs');
  process.exit(1);
}

let src = fs.readFileSync(preloadPath, 'utf8');
const before = src;

for (const channel of ['drive:getFolders', 'drive:saveFolders']) {
  if (!src.includes("'" + channel + "'")) {
    src = src.replace("  'p2p:listFiles',\n", "  'p2p:listFiles',\n  '" + channel + "',\n");
  }
}

if (!src.includes("channel.startsWith('drive:')")) {
  src = src.replace(
    "channel.startsWith('company:')",
    "channel.startsWith('company:') || channel.startsWith('drive:')"
  );
}

if (!src.includes("'drive:saveFolders'")) {
  console.error('[patch-preload-drive-ipc] failed to allow drive:saveFolders');
  process.exit(1);
}
if (!src.includes("'drive:getFolders'")) {
  console.error('[patch-preload-drive-ipc] failed to allow drive:getFolders');
  process.exit(1);
}
if (!src.includes("channel.startsWith('drive:')")) {
  console.error('[patch-preload-drive-ipc] failed to add drive retry');
  process.exit(1);
}

if (src !== before) {
  fs.writeFileSync(preloadPath, src, 'utf8');
  console.log('[patch-preload-drive-ipc] drive IPC allowed in preload');
} else {
  console.log('[patch-preload-drive-ipc] preload already allows drive IPC');
}
