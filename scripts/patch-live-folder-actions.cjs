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
  '  | "wallet:disconnect"',
  '  | "wallet:disconnect"\n  | "drive:getFolders"\n  | "drive:saveFolders"'
);

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
  '  const baseFiles = view === "company" || view === "admin" ? companyFiles : view === "shared" ? sharedFiles : personalFiles;',
  '  const folderPath = (folder: string) => folder === ALL_FILES || folder === UNCATEGORIZED ? folder : [folderParents[folder], folder].filter(Boolean).join(" / ");\n  const orderedFolders = useMemo(() => folders, [folders]);\n  const saveDriveFolders = async (nextFolders = fileFolders, nextParents = folderParents) => {\n    if (!api || !walletConnected) return;\n    const folderNames = Array.from(new Set(Object.values(nextFolders).filter(Boolean)));\n    const foldersPayload = folderNames.map((name) => ({ id: name, name, parentId: nextParents[name] || null, updatedAt: new Date().toISOString() }));\n    await api.invoke("drive:saveFolders", { folders: foldersPayload, fileFolders: nextFolders });\n  };\n  const loadDriveFolders = async () => {\n    if (!api || !walletConnected) return;\n    const remote = await api.invoke<{ folders: Array<{ id: string; name: string; parentId?: string | null }>; fileFolders: Record<string, string> }>("drive:getFolders");\n    const nextFileFolders = remote.fileFolders || {};\n    const nextParents = Object.fromEntries((remote.folders || []).map((folder) => [folder.name || folder.id, folder.parentId || ""]));\n    setFileFolders(nextFileFolders);\n    setFolderParents(nextParents);\n  };\n  const baseFiles = view === "company" || view === "admin" ? companyFiles : view === "shared" ? sharedFiles : personalFiles;'
);

r(
  '    setCompany(nextCompany);\n    if (!activeWorkspaceId && nextCompany.workspaces?.[0]?.workspaceId) setActiveWorkspaceId(nextCompany.workspaces[0].workspaceId);',
  '    setCompany(nextCompany);\n    if (nextWallet.connected) {\n      try {\n        const remote = await api.invoke<{ folders: Array<{ id: string; name: string; parentId?: string | null }>; fileFolders: Record<string, string> }>("drive:getFolders");\n        setFileFolders(remote.fileFolders || {});\n        setFolderParents(Object.fromEntries((remote.folders || []).map((folder) => [folder.name || folder.id, folder.parentId || ""])));\n      } catch {}\n    }\n    if (!activeWorkspaceId && nextCompany.workspaces?.[0]?.workspaceId) setActiveWorkspaceId(nextCompany.workspaces[0].workspaceId);'
);

r(
  '    const key = (view === "company" || view === "admin") && activeWorkspace ? companyFolderKey(activeWorkspace.workspaceId, folder) : personalFolderKey(folder);\n    setFileFolders((current) => ({ ...current, [key]: folder }));\n    setActiveFolder(folder);',
  '    const key = (view === "company" || view === "admin") && activeWorkspace ? companyFolderKey(activeWorkspace.workspaceId, folder) : personalFolderKey(folder);\n    const parent = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : "";\n    const nextParents = { ...folderParents, [folder]: parent };\n    const nextFolders = { ...fileFolders, [key]: folder };\n    setFolderParents(nextParents);\n    setFileFolders(nextFolders);\n    void saveDriveFolders(nextFolders, nextParents);\n    setActiveFolder(folder);'
);

r(
  '  const upload = () => run(async () => {',
  '  const renameActiveFolder = () => {\n    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) return;\n    const name = window.prompt("Rename folder", activeFolder)?.trim();\n    if (!name || name === ALL_FILES || name === UNCATEGORIZED || name === activeFolder) return;\n    const nextFolders = Object.fromEntries(Object.entries(fileFolders).map(([key, folder]) => [key, folder === activeFolder ? name : folder]));\n    const nextParents = Object.fromEntries(Object.entries(folderParents).map(([folder, parent]) => [folder === activeFolder ? name : folder, parent === activeFolder ? name : parent]));\n    setFileFolders(nextFolders);\n    setFolderParents(nextParents);\n    setActiveFolder(name);\n    void saveDriveFolders(nextFolders, nextParents);\n  };\n  const deleteActiveFolder = () => {\n    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) return;\n    const nextFolders = Object.fromEntries(Object.entries(fileFolders).filter(([key, folder]) => !key.endsWith(`:${activeFolder}`) && folder !== activeFolder));\n    const nextParents = Object.fromEntries(Object.entries(folderParents).filter(([folder]) => folder !== activeFolder).map(([folder, parent]) => [folder, parent === activeFolder ? "" : parent]));\n    setFileFolders(nextFolders);\n    setFolderParents(nextParents);\n    setActiveFolder(ALL_FILES);\n    void saveDriveFolders(nextFolders, nextParents);\n  };\n  const moveActiveFolderToParent = (targetParent: string) => {\n    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) return;\n    const nextParents = { ...folderParents, [activeFolder]: targetParent === UNCATEGORIZED ? "" : targetParent };\n    setFolderParents(nextParents);\n    void saveDriveFolders(fileFolders, nextParents);\n  };\n  const upload = () => run(async () => {'
);

r(
  '          <div className="flex gap-2">\n            <Input value={newFolder} onChange={(event) => setNewFolder(event.target.value)} placeholder="New folder" />\n            <Button onClick={createFolder} disabled={busy}>+</Button>\n          </div>',
  '          <div className="flex gap-2">\n            <Input value={newFolder} onChange={(event) => setNewFolder(event.target.value)} placeholder="New folder" />\n            <Button onClick={createFolder} disabled={busy}>+</Button>\n          </div>\n          {activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED && (\n            <div className="mt-2 grid gap-2">\n              <Button variant="outline" size="sm" onClick={renameActiveFolder}>Rename folder</Button>\n              <select value={folderParents[activeFolder] || UNCATEGORIZED} onChange={(event) => moveActiveFolderToParent(event.target.value)} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">\n                <option value={UNCATEGORIZED}>Move to root</option>\n                {orderedFolders.filter((folder) => folder !== ALL_FILES && folder !== UNCATEGORIZED && folder !== activeFolder).map((folder) => <option key={folder} value={folder}>{folderPath(folder)}</option>)}\n              </select>\n              <Button variant="destructive" size="sm" onClick={deleteActiveFolder}>Delete folder</Button>\n            </div>\n          )}'
);

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-live-folder-actions] synced folders through drive IPC');
} else {
  console.log('[patch-live-folder-actions] already applied');
}
