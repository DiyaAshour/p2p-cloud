const fs = require('node:fs');
const p = 'client/src/NativeP2PAppLive.tsx';
let s = fs.readFileSync(p, 'utf8');
let changed = false;
function r(a,b){ if(s.includes(a)){ s=s.replace(a,b); changed=true; } }
r('  | "company:updateFile";', '  | "company:updateFile"\n  | "drive:getFolders"\n  | "drive:saveFolders";');
r('  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => readJson(ACTIVE_WORKSPACE_KEY, ""));', '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n  const [folderParents, setFolderParents] = useState<Record<string, string>>({});\n  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => readJson(ACTIVE_WORKSPACE_KEY, ""));');
r('  const folderStorageKey = `${FILE_FOLDERS_KEY}.${identityStorageId(wallet)}`;', '  const folderStorageKey = `${FILE_FOLDERS_KEY}.${identityStorageId(wallet)}`;\n  const folderParentsStorageKey = `${FILE_FOLDERS_KEY}.parents.${identityStorageId(wallet)}`;');
r('    setFileFolders(readJson(folderStorageKey, {}));\n    setActiveFolder(ALL_FILES);\n  }, [folderStorageKey]);', '    setFileFolders(readJson(folderStorageKey, {}));\n    setFolderParents(readJson(folderParentsStorageKey, {}));\n    setActiveFolder(ALL_FILES);\n  }, [folderStorageKey, folderParentsStorageKey]);
r('  useEffect(() => {\n    localStorage.setItem(folderStorageKey, JSON.stringify(fileFolders));\n  }, [fileFolders, folderStorageKey]);', '  useEffect(() => {\n    localStorage.setItem(folderStorageKey, JSON.stringify(fileFolders));\n  }, [fileFolders, folderStorageKey]);\n  useEffect(() => {\n    localStorage.setItem(folderParentsStorageKey, JSON.stringify(folderParents));\n  }, [folderParents, folderParentsStorageKey]);');
if(changed){ fs.writeFileSync(p,s,'utf8'); console.log('[patch-live-folder-core-actions] part1 ok'); } else console.log('[patch-live-folder-core-actions] already part1');
