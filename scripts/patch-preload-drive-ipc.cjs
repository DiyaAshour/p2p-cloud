const fs = require('node:fs');
const path = require('node:path');

const preloadFiles = [
  path.join(process.cwd(), 'electron', 'preload.cjs'),
  path.join(process.cwd(), 'electron', 'preload.js'),
];

function patchPreload(preloadPath) {
  if (!fs.existsSync(preloadPath)) return { skipped: true, file: preloadPath };
  let src = fs.readFileSync(preloadPath, 'utf8');
  const before = src;

  for (const channel of ['drive:getFolders', 'drive:saveFolders']) {
    if (!src.includes("'" + channel + "'")) {
      src = src.replace("  'p2p:listFiles',\n", "  'p2p:listFiles',\n  '" + channel + "',\n");
    }
  }

  if (!src.includes("channel.startsWith('drive:')")) {
    if (src.includes("channel.startsWith('company:')")) {
      src = src.replace(
        "channel.startsWith('company:')",
        "channel.startsWith('company:') || channel.startsWith('drive:')"
      );
    }
  }

  if (!src.includes("'drive:saveFolders'")) {
    throw new Error(preloadPath + ': failed to allow drive:saveFolders');
  }
  if (!src.includes("'drive:getFolders'")) {
    throw new Error(preloadPath + ': failed to allow drive:getFolders');
  }

  if (src !== before) {
    fs.writeFileSync(preloadPath, src, 'utf8');
    return { changed: true, file: preloadPath };
  }
  return { changed: false, file: preloadPath };
}

let changed = false;
for (const file of preloadFiles) {
  const result = patchPreload(file);
  if (result.changed) changed = true;
}

console.log(changed ? '[patch-preload-drive-ipc] drive IPC allowed in preload variants' : '[patch-preload-drive-ipc] preload variants already allow drive IPC');
