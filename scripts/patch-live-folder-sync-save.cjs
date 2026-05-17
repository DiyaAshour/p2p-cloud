const fs = require('node:fs');
const p = 'client/src/NativeP2PAppLive.tsx';
let s = fs.readFileSync(p, 'utf8');
let changed = false;
function r(a,b){ if(s.includes(a)){ s=s.replace(a,b); changed=true; } }
const marker = '  const refresh = async () => {';
const block = `  const saveDriveFolders = async (nextFolders = fileFolders) => {
    if (!api || !walletConnected) return;
    const folders = Array.from(new Set(Object.values(nextFolders).filter(Boolean))).map((name) => ({ id: name, name }));
    try {
      await api.invoke("drive:saveFolders", { folders, fileFolders: nextFolders });
    } catch {}
  };
`;
if (!s.includes('const saveDriveFolders = async')) r(marker, block + marker);
r('    setFileFolders((current) => ({ ...current, [key]: folder }));\n    setActiveFolder(folder);', '    setFileFolders((current) => { const next = { ...current, [key]: folder }; void saveDriveFolders(next); return next; });\n    setActiveFolder(folder);');
r('    setFileFolders(nextFolders);\n    setActiveFolder(name);', '    setFileFolders(nextFolders);\n    void saveDriveFolders(nextFolders);\n    setActiveFolder(name);');
r('    setFileFolders(nextFolders);\n    setActiveFolder(ALL_FILES);', '    setFileFolders(nextFolders);\n    void saveDriveFolders(nextFolders);\n    setActiveFolder(ALL_FILES);');
r('    setFileFolders(nextFolders);\n    setActiveFolder(targetFolder);', '    setFileFolders(nextFolders);\n    void saveDriveFolders(nextFolders);\n    setActiveFolder(targetFolder);');
if(changed){ fs.writeFileSync(p,s,'utf8'); console.log('[patch-live-folder-sync-save] installed'); } else console.log('[patch-live-folder-sync-save] already applied');
