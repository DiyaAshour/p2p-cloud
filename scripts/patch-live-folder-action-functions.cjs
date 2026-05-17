const fs = require('node:fs');
const p = 'client/src/NativeP2PAppLive.tsx';
let s = fs.readFileSync(p, 'utf8');
let changed = false;
function r(a,b){ if(s.includes(a)){ s=s.replace(a,b); changed=true; } }
const marker = '  const upload = () => run(async () => {';
const block = `  const renameActiveFolder = () => {
    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) return;
    const name = window.prompt("Rename folder", activeFolder)?.trim();
    if (!name || name === ALL_FILES || name === UNCATEGORIZED || name === activeFolder) return;
    const nextFolders = Object.fromEntries(Object.entries(fileFolders).map(([key, folder]) => [key, folder === activeFolder ? name : folder]));
    setFileFolders(nextFolders);
    setActiveFolder(name);
  };
  const deleteActiveFolder = () => {
    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) return;
    const nextFolders = Object.fromEntries(Object.entries(fileFolders).filter(([key, folder]) => !key.endsWith(':' + activeFolder) && folder !== activeFolder));
    setFileFolders(nextFolders);
    setActiveFolder(ALL_FILES);
  };
  const moveActiveFolderToParent = (targetFolder: string) => {
    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED || !targetFolder || targetFolder === activeFolder) return;
    const nextFolders = Object.fromEntries(Object.entries(fileFolders).map(([key, folder]) => [key, folder === activeFolder ? targetFolder : folder]));
    setFileFolders(nextFolders);
    setActiveFolder(targetFolder);
  };
`;
if (!s.includes('const deleteActiveFolder = () =>')) r(marker, block + marker);
if(changed){ fs.writeFileSync(p,s,'utf8'); console.log('[patch-live-folder-action-functions] installed'); } else console.log('[patch-live-folder-action-functions] already applied');
