const fs = require('node:fs');

const p = 'client/src/NativeP2PAppLive.tsx';
let s = fs.readFileSync(p, 'utf8');
let changed = false;

function replaceOnce(from, to) {
  if (s.includes(from)) {
    s = s.replace(from, to);
    changed = true;
  }
}

// Isolate new folder UI cache from old leaked localStorage keys.
replaceOnce(
  'const FILE_FOLDERS_KEY = "chunknet.ui.fileFolders";',
  'const FILE_FOLDERS_KEY = "chunknet.ui.fileFolders.v3";'
);

// Folders in My Drive must come only from visible personal files, not stale personal:folder:* entries.
replaceOnce(
  '    const personalFileKeys = new Set(personalFiles.map((file) => file.hash));\n    const personalFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith("personal:folder:") || personalFileKeys.has(key)).map(([, folder]) => folder).filter(Boolean);',
  '    const personalFileKeys = new Set(personalFiles.flatMap((file) => [file.hash, file.rootHash, keyFor(file)]).filter(Boolean));\n    const personalFolders = Object.entries(fileFolders).filter(([key]) => personalFileKeys.has(key)).map(([, folder]) => folder).filter(Boolean);'
);

// Folder lookup should accept hash/rootHash and ignore stale standalone folders.
replaceOnce(
  '      const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;',
  '      const folder = cf?.folder || fileFolders[file.hash] || fileFolders[file.rootHash] || UNCATEGORIZED;'
);

replaceOnce(
  '    const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;',
  '    const folder = cf?.folder || fileFolders[file.hash] || fileFolders[file.rootHash] || UNCATEGORIZED;'
);

// Changing account should clear the in-memory folder cache immediately.
replaceOnce(
  '  const disconnectWallet = () => run(async () => {\n    setWallet(await api.invoke<WalletState>("wallet:disconnect"));\n    await refresh();\n  });',
  '  const disconnectWallet = () => run(async () => {\n    setWallet(await api.invoke<WalletState>("wallet:disconnect"));\n    setFileFolders({});\n    setActiveFolder(ALL_FILES);\n    await refresh();\n  });'
);

// Do not store folder assignment for All files/Uncategorized as a real folder.
replaceOnce(
  '        for (const file of result.files || []) next[file.hash] = activeFolder;',
  '        for (const file of result.files || []) if (activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED) next[file.hash] = activeFolder;'
);

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-ui-folder-scope] scoped My Drive folders to current account files');
} else {
  console.log('[patch-ui-folder-scope] already applied');
}
