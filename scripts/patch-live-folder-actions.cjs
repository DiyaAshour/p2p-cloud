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

r(
  '    const key = (view === "company" || view === "admin") && activeWorkspace ? companyFolderKey(activeWorkspace.workspaceId, folder) : personalFolderKey(folder);\n    setFileFolders((current) => ({ ...current, [key]: folder }));\n    setActiveFolder(folder);',
  '    const key = (view === "company" || view === "admin") && activeWorkspace ? companyFolderKey(activeWorkspace.workspaceId, folder) : personalFolderKey(folder);\n    const parent = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : "";\n    setFolderParents((current) => ({ ...current, [folder]: parent }));\n    setFileFolders((current) => ({ ...current, [key]: folder }));\n    setActiveFolder(folder);'
);

r(
  '  const upload = () => run(async () => {',
  '  const renameActiveFolder = () => {\n    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) return;\n    const name = window.prompt("Rename folder", activeFolder)?.trim();\n    if (!name || name === ALL_FILES || name === UNCATEGORIZED || name === activeFolder) return;\n    setFileFolders((current) => Object.fromEntries(Object.entries(current).map(([key, folder]) => [key, folder === activeFolder ? name : folder])));\n    setFolderParents((current) => Object.fromEntries(Object.entries(current).map(([folder, parent]) => [folder === activeFolder ? name : folder, parent === activeFolder ? name : parent])));\n    setActiveFolder(name);\n  };\n  const deleteActiveFolder = () => {\n    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) return;\n    setFileFolders((current) => Object.fromEntries(Object.entries(current).filter(([key, folder]) => !key.endsWith(`:${activeFolder}`) && folder !== activeFolder)));\n    setFolderParents((current) => Object.fromEntries(Object.entries(current).filter(([folder]) => folder !== activeFolder).map(([folder, parent]) => [folder, parent === activeFolder ? "" : parent])));\n    setActiveFolder(ALL_FILES);\n  };\n  const moveActiveFolderToParent = (targetParent: string) => {\n    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) return;\n    if (targetParent === activeFolder) return;\n    let cursor = targetParent;\n    while (cursor) {\n      if (cursor === activeFolder) return;\n      cursor = folderParents[cursor] || "";\n    }\n    setFolderParents((current) => ({ ...current, [activeFolder]: targetParent === UNCATEGORIZED ? "" : targetParent }));\n  };\n  const upload = () => run(async () => {'
);

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-live-folder-actions] added folder actions');
} else {
  console.log('[patch-live-folder-actions] already applied');
}
