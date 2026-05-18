const fs = require('node:fs');
const path = require('node:path');

const preloadFiles = [
  path.join(process.cwd(), 'electron', 'preload.cjs'),
  path.join(process.cwd(), 'electron', 'preload.js'),
];

const folderChannels = [
  'drive:getFolders',
  'drive:saveFolders',
  'p2p:listFolders',
  'p2p:createFolder',
  'p2p:renameFolder',
  'p2p:deleteFolder',
  'p2p:moveFolder',
  'p2p:moveFile',
  'p2p:renameItem',
  'p2p:moveItem',
  'p2p:deleteItem',
  'p2p:updateFile',
];

function insertAfterListFiles(src, channel) {
  if (src.includes("'" + channel + "'")) return src;
  if (src.includes("  'p2p:listFiles',\n")) {
    return src.replace("  'p2p:listFiles',\n", "  'p2p:listFiles',\n  '" + channel + "',\n");
  }
  if (src.includes('const allowedChannels = new Set([')) {
    return src.replace('const allowedChannels = new Set([', "const allowedChannels = new Set([\n  '" + channel + "',");
  }
  return src;
}

function patchPreload(preloadPath) {
  if (!fs.existsSync(preloadPath)) return { skipped: true, file: preloadPath };
  let src = fs.readFileSync(preloadPath, 'utf8');
  const before = src;

  for (const channel of folderChannels) {
    src = insertAfterListFiles(src, channel);
  }

  if (!src.includes("channel.startsWith('drive:')")) {
    if (src.includes("channel.startsWith('company:')")) {
      src = src.replace(
        "channel.startsWith('company:')",
        "channel.startsWith('company:') || channel.startsWith('drive:')"
      );
    }
  }

  for (const channel of folderChannels) {
    if (!src.includes("'" + channel + "'")) {
      throw new Error(preloadPath + ': failed to allow ' + channel);
    }
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

console.log(changed ? '[patch-preload-drive-ipc] folder IPC allowed in preload variants' : '[patch-preload-drive-ipc] preload variants already allow folder IPC');