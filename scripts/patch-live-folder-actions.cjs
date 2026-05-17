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

r(
  '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => readJson(ACTIVE_WORKSPACE_KEY, ""));',
  '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n  const [folderParents, setFolderParents] = useState<Record<string, string>>({});\n  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => readJson(ACTIVE_WORKSPACE_KEY, ""));'
);

r(
  '  const folderStorageKey = `${FILE_FOLDERS_KEY}.${identityStorageId(wallet)}`;',
  '  const folderStorageKey = `${FILE_FOLDERS_KEY}.${identityStorageId(wallet)}`;\n  const folderParentsStorageKey = `${FILE_FOLDERS_KEY}.parents.${identityStorageId(wallet)}`;'
);

r(
  '    setFileFolders(readJson(folderStorageKey, {}));\n    setActiveFolder(ALL_FILES);\n  }, [folderStorageKey]);',
  '    setFileFolders(readJson(folderStorageKey, {}));\n    setFolderParents(readJson(folderParentsStorageKey, {}));\n    setActiveFolder(ALL_FILES);\n  }, [folderStorageKey, folderParentsStorageKey]);'
);

r(
  '  useEffect(() => {\n    if (!wallet?.connected) return;\n    localStorage.setItem(folderStorageKey, JSON.stringify(fileFolders));\n  }, [fileFolders, folderStorageKey, wallet?.connected]);',
  '  useEffect(() => {\n    if (!wallet?.connected) return;\n    localStorage.setItem(folderStorageKey, JSON.stringify(fileFolders));\n  }, [fileFolders, folderStorageKey, wallet?.connected]);\n  useEffect(() => {\n    if (!wallet?.connected) return;\n    localStorage.setItem(folderParentsStorageKey, JSON.stringify(folderParents));\n  }, [folderParents, folderParentsStorageKey, wallet?.connected]);'
);

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-live-folder-actions] added folder parent state/storage');
} else {
  console.log('[patch-live-folder-actions] already applied');
}
