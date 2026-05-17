const fs = require('node:fs');

const p = 'client/src/NativeP2PAppLive.tsx';
let s = fs.readFileSync(p, 'utf8');
let changed = false;

function r(from, to) {
  if (s.includes(from)) {
    s = s.replace(from, to);
    changed = true;
  }
}

r('const FILE_FOLDERS_KEY = "chunknet.ui.fileFolders";', 'const FILE_FOLDERS_KEY = "chunknet.ui.fileFolders.v5";');
r('const FILE_FOLDERS_KEY = "chunknet.ui.fileFolders.v3";', 'const FILE_FOLDERS_KEY = "chunknet.ui.fileFolders.v5";');
r('const FILE_FOLDERS_KEY = "chunknet.ui.fileFolders.v4";', 'const FILE_FOLDERS_KEY = "chunknet.ui.fileFolders.v5";');

r(
  '    const personalFileKeys = new Set(personalFiles.map((file) => file.hash));\n    const personalFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith("personal:folder:") || personalFileKeys.has(key)).map(([, folder]) => folder).filter(Boolean);',
  '    const personalFileKeys = new Set(personalFiles.flatMap((file) => [file.hash, file.rootHash, keyFor(file)]).filter(Boolean));\n    const personalFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith("personal:folder:") || personalFileKeys.has(key)).map(([, folder]) => folder).filter(Boolean);'
);
r(
  '    const personalFileKeys = new Set(personalFiles.flatMap((file) => [file.hash, file.rootHash, keyFor(file)]).filter(Boolean));\n    const personalFolders = Object.entries(fileFolders).filter(([key]) => personalFileKeys.has(key)).map(([, folder]) => folder).filter(Boolean);',
  '    const personalFileKeys = new Set(personalFiles.flatMap((file) => [file.hash, file.rootHash, keyFor(file)]).filter(Boolean));\n    const personalFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith("personal:folder:") || personalFileKeys.has(key)).map(([, folder]) => folder).filter(Boolean);'
);

r('      const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;', '      const folder = cf?.folder || fileFolders[file.hash] || fileFolders[file.rootHash] || UNCATEGORIZED;');
r('    const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;', '    const folder = cf?.folder || fileFolders[file.hash] || fileFolders[file.rootHash] || UNCATEGORIZED;');

r(
  '  useEffect(() => {\n    localStorage.setItem(folderStorageKey, JSON.stringify(fileFolders));\n  }, [fileFolders, folderStorageKey]);',
  '  useEffect(() => {\n    if (!wallet?.connected) return;\n    localStorage.setItem(folderStorageKey, JSON.stringify(fileFolders));\n  }, [fileFolders, folderStorageKey, wallet?.connected]);'
);

r(
  '  const connectWallet = () => run(async () => {\n    const address = window.prompt("Wallet address 0x...")?.trim();\n    if (!address) return;\n    setWallet(await api.invoke<WalletState>("wallet:connect", { address }));\n    await refresh();\n  });',
  '  const connectWallet = () => run(async () => {\n    const address = window.prompt("Wallet address 0x...")?.trim();\n    if (!address) return;\n    setFileFolders({});\n    setActiveFolder(ALL_FILES);\n    const nextWallet = await api.invoke<WalletState>("wallet:connect", { address });\n    setWallet(nextWallet);\n    setFileFolders(readJson(FILE_FOLDERS_KEY + "." + identityStorageId(nextWallet), {}));\n    await refresh();\n  });'
);

r(
  '  const disconnectWallet = () => run(async () => {\n    setWallet(await api.invoke<WalletState>("wallet:disconnect"));\n    await refresh();\n  });',
  '  const disconnectWallet = () => run(async () => {\n    setFileFolders({});\n    setActiveFolder(ALL_FILES);\n    const nextWallet = await api.invoke<WalletState>("wallet:disconnect");\n    setWallet(nextWallet);\n    setFileFolders(readJson(FILE_FOLDERS_KEY + "." + identityStorageId(nextWallet), {}));\n    await refresh();\n  });'
);
r(
  '  const disconnectWallet = () => run(async () => {\n    setWallet(await api.invoke<WalletState>("wallet:disconnect"));\n    setFileFolders({});\n    setActiveFolder(ALL_FILES);\n    await refresh();\n  });',
  '  const disconnectWallet = () => run(async () => {\n    setFileFolders({});\n    setActiveFolder(ALL_FILES);\n    const nextWallet = await api.invoke<WalletState>("wallet:disconnect");\n    setWallet(nextWallet);\n    setFileFolders(readJson(FILE_FOLDERS_KEY + "." + identityStorageId(nextWallet), {}));\n    await refresh();\n  });'
);

r('        for (const file of result.files || []) next[file.hash] = activeFolder;', '        for (const file of result.files || []) if (activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED) next[file.hash] = activeFolder;');

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-ui-folder-scope] fixed identity folder switching');
} else {
  console.log('[patch-ui-folder-scope] already applied');
}
