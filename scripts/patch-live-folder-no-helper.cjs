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

function insertAfter(regex, insertion, label) {
  if (s.includes(insertion.trim())) return;
  const next = s.replace(regex, (match) => match + insertion);
  if (next === s) console.warn('[patch-live-folder-no-helper] marker not found:', label);
  s = next;
}

function insertBefore(regex, insertion, label) {
  if (s.includes(insertion.trim())) return;
  const next = s.replace(regex, insertion + '$&');
  if (next === s) console.warn('[patch-live-folder-no-helper] marker not found:', label);
  s = next;
}

const hasNetworkFolderUi =
  s.includes('const [driveFolders, setDriveFolders]') ||
  s.includes('p2p:createFolder') ||
  s.includes('const renameFolder = (folderName: string) =>');

// Some restore patches remove folder identity helpers while keeping their usages.
if (!s.includes('function identityStorageId(')) {
  const helper = `function identityStorageId(wallet: WalletState | null) {
  if (!wallet?.connected) return "guest";
  if (wallet.authMode === "seed") return \`seed:\${wallet.accountId || wallet.seedFingerprint || wallet.username || "unknown"}\`;
  return \`wallet:\${wallet.address || wallet.accountId || "unknown"}\`;
}
`;
  if (s.includes('function readJson<T>')) {
    s = s.replace(/function readJson<T>\([\s\S]*?\n}\r?\n/, (match) => match + helper);
  } else if (s.includes('function getBridge()')) {
    s = s.replace(/function getBridge\([\s\S]*?\n}\r?\n/, (match) => match + helper);
  } else {
    s = s.replace('const ACTIVE_WORKSPACE_KEY = "chunknet.ui.activeWorkspace";\n', 'const ACTIVE_WORKSPACE_KEY = "chunknet.ui.activeWorkspace";\n\n' + helper);
  }
}

// Keep TypeScript-compatible fields/channels available, but do not replace the network folder UI.
if (!s.includes('folderName?: string')) {
  s = s.replace(
    'ownerWallet?: string; replicas?: string[];',
    'ownerWallet?: string; folder?: string; folderName?: string; folderId?: string; replicas?: string[];'
  );
}

const channelAnchor = '  | "p2p:downloadToPath"\n';
for (const channel of ['p2p:updateFile', 'p2p:listFolders', 'p2p:createFolder', 'p2p:renameItem', 'p2p:moveItem', 'p2p:deleteItem']) {
  const line = `  | "${channel}"\n`;
  if (!s.includes(line) && s.includes(channelAnchor)) s = s.replace(channelAnchor, channelAnchor + line);
}

// Some restore patches leave useEffects that depend on folderStorageKey while removing its const.
if (!s.includes('const folderStorageKey =')) {
  if (s.includes('const identityLabel =')) {
    insertAfter(/  const identityLabel = [^\n]*;\r?\n/, '  const folderStorageKey = `${FILE_FOLDERS_KEY}.${identityStorageId(wallet)}`;\n', 'folderStorageKey');
  } else {
    insertBefore(/  const workspaces = company\?\.workspaces \|\| \[\];\r?\n/, '  const folderStorageKey = `${FILE_FOLDERS_KEY}.${identityStorageId(wallet)}`;\n', 'folderStorageKey fallback');
  }
}

// Best-effort display repair. Do not fail if restored UI uses another expression.
s = s.replace(
  /const folder = cf\?\.folder \|\| fileFolders\[file\.hash\] \|\| UNCATEGORIZED;/g,
  'const folder = cf?.folder || file.folder || file.folderName || fileFolders[file.hash] || fileFolders[file.rootHash] || UNCATEGORIZED;'
);
s = s.replace(
  /const folder = cf\?\.folder \|\| fileFolders\[file\.rootHash\] \|\| fileFolders\[file\.hash\] \|\| UNCATEGORIZED;/g,
  'const folder = cf?.folder || file.folder || file.folderName || fileFolders[file.hash] || fileFolders[file.rootHash] || UNCATEGORIZED;'
);

// Legacy local-only file move repair. Avoid touching network-folder UI handlers.
s = s.replace(
  /else setFileFolders\(\(current\) => \(\{ \.\.\.current, \[file\.hash\]: nextFolder \}\)\);/g,
  `else {
                setFileFolders((current) => ({ ...current, [file.hash]: nextFolder, ...(file.rootHash ? { [file.rootHash]: nextFolder } : {}) }));
                void api.invoke("p2p:updateFile", { hash: file.hash, rootHash: file.rootHash, patch: { folder: nextFolder } })
                  .then(refresh)
                  .catch((error) => toast.error(err(error)));
              }`
);

if (hasNetworkFolderUi) {
  console.log('[patch-live-folder-no-helper] network folder UI detected; skipped legacy createFolder/folders overrides');
} else {
  console.log('[patch-live-folder-no-helper] no network folder UI detected; left legacy folder UI unchanged for later network patch');
}

if (s !== before) fs.writeFileSync(liveFile, s, 'utf8');

let preloadChanged = false;
if (fs.existsSync(preloadFile)) {
  let preload = fs.readFileSync(preloadFile, 'utf8');
  const preloadBefore = preload;
  const channels = [
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
  for (const channel of channels) {
    if (!preload.includes("'" + channel + "'")) {
      preload = preload.replace("  'p2p:listFiles',\n", "  'p2p:listFiles',\n  '" + channel + "',\n");
    }
  }
  if (!preload.includes("channel.startsWith('drive:')") && preload.includes("channel.startsWith('company:')")) {
    preload = preload.replace(
      "channel.startsWith('company:')",
      "channel.startsWith('company:') || channel.startsWith('drive:')"
    );
  }
  if (preload !== preloadBefore) {
    fs.writeFileSync(preloadFile, preload, 'utf8');
    preloadChanged = true;
  }
}

if (s !== before || preloadChanged) {
  console.log('[patch-live-folder-no-helper] compatibility guard applied without overriding network folders');
} else {
  console.log('[patch-live-folder-no-helper] already safe');
}
