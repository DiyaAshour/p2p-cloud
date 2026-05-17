const fs = require('node:fs');

const p = 'client/src/NativeP2PAppLive.tsx';
let s = fs.readFileSync(p, 'utf8');
let changed = false;

function r(from, to, label = '') {
  if (s.includes(from)) {
    s = s.replace(from, to);
    changed = true;
  } else if (label) {
    console.warn('[patch-live-folder-actions] marker not found:', label);
  }
}

function addChannel(channel) {
  if (!s.includes(`| "${channel}"`)) {
    r('  | "wallet:disconnect"', `  | "wallet:disconnect"\n  | "${channel}"`, `channel ${channel}`);
  }
}
addChannel('drive:getFolders');
addChannel('drive:saveFolders');
addChannel('p2p:updateFile');

r(
  '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => readJson(ACTIVE_WORKSPACE_KEY, ""));',
  '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n  const [folderParents, setFolderParents] = useState<Record<string, string>>({});\n  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => readJson(ACTIVE_WORKSPACE_KEY, ""));',
  'folderParents state'
);

r(
  '  const folders = useMemo(() => {\n    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const personalFileKeys = new Set(personalFiles.map((file) => file.hash));\n    const personalFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith("personal:folder:") || personalFileKeys.has(key)).map(([, folder]) => folder).filter(Boolean);\n    const companyPrefix = activeWorkspace ? `company:${activeWorkspace.workspaceId}:folder:` : "company:none:folder:";\n    const companyFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith(companyPrefix)).map(([, folder]) => folder).filter(Boolean);\n    const sourceFolders = view === "company" || view === "admin" ? [...workspaceFolders, ...companyFolders] : personalFolders;\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];\n  }, [fileFolders, activeWorkspace, personalFiles, view]);',
  '  const folders = useMemo(() => {\n    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const personalFileKeys = new Set(personalFiles.map((file) => file.hash));\n    const personalFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith("personal:folder:") || personalFileKeys.has(key)).map(([, folder]) => folder).filter(Boolean);\n    const networkFolders = Object.keys(folderParents).filter(Boolean);\n    const companyPrefix = activeWorkspace ? `company:${activeWorkspace.workspaceId}:folder:` : "company:none:folder:";\n    const companyFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith(companyPrefix)).map(([, folder]) => folder).filter(Boolean);\n    const sourceFolders = view === "company" || view === "admin" ? [...workspaceFolders, ...companyFolders] : [...personalFolders, ...networkFolders];\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];\n  }, [fileFolders, folderParents, activeWorkspace, personalFiles, view]);',
  'folders memo'
);

r(
  '  const baseFiles = view === "company" || view === "admin" ? companyFiles : view === "shared" ? sharedFiles : personalFiles;',
  '  const folderPath = (folder: string) => folder === ALL_FILES || folder === UNCATEGORIZED ? folder : [folderParents[folder], folder].filter(Boolean).join(" / ");\n  const orderedFolders = useMemo(() => folders, [folders]);\n  const saveDriveFolders = async (nextFolders: Record<string, string> = fileFolders, nextParents: Record<string, string> = folderParents) => {\n    if (!api || !walletConnected || view !== "personal") return;\n    const names = new Set<string>();\n    for (const value of Object.values(nextFolders)) if (value && value !== ALL_FILES && value !== UNCATEGORIZED) names.add(value);\n    for (const value of Object.keys(nextParents)) if (value && value !== ALL_FILES && value !== UNCATEGORIZED) names.add(value);\n    const foldersPayload = Array.from(names).map((name) => ({ id: name, name, parentId: nextParents[name] || null, updatedAt: new Date().toISOString() }));\n    await api.invoke("drive:saveFolders", { folders: foldersPayload, fileFolders: nextFolders });\n  };\n  const loadDriveFolders = async () => {\n    if (!api || !walletConnected) return;\n    const remote = await api.invoke<{ folders: Array<{ id: string; name: string; parentId?: string | null }>; fileFolders: Record<string, string> }>("drive:getFolders");\n    const nextFileFolders = remote.fileFolders || {};\n    const nextParents = Object.fromEntries((remote.folders || []).map((folder) => [folder.name || folder.id, folder.parentId || ""]));\n    setFileFolders(nextFileFolders);\n    setFolderParents(nextParents);\n  };\n  const baseFiles = view === "company" || view === "admin" ? companyFiles : view === "shared" ? sharedFiles : personalFiles;',
  'drive folder helpers'
);

r(
  '  useEffect(() => {\n    setFileFolders(readJson(folderStorageKey, {}));\n    setActiveFolder(ALL_FILES);\n  }, [folderStorageKey]);\n  useEffect(() => {\n    localStorage.setItem(folderStorageKey, JSON.stringify(fileFolders));\n  }, [fileFolders, folderStorageKey]);',
  '  useEffect(() => {\n    setActiveFolder(ALL_FILES);\n  }, [folderStorageKey]);',
  'remove localStorage folder source'
);

r(
  '    setSummary(nextSummary);\n    setFiles(Array.isArray(nextFiles) ? nextFiles : []);\n    setWallet(nextWallet);\n    setCompany(nextCompany);\n    if (!activeWorkspaceId && nextCompany.workspaces?.[0]?.workspaceId) setActiveWorkspaceId(nextCompany.workspaces[0].workspaceId);',
  '    setSummary(nextSummary);\n    setFiles(Array.isArray(nextFiles) ? nextFiles : []);\n    setWallet(nextWallet);\n    setCompany(nextCompany);\n    if (nextWallet.connected) {\n      try {\n        const remote = await api.invoke<{ folders: Array<{ id: string; name: string; parentId?: string | null }>; fileFolders: Record<string, string> }>("drive:getFolders");\n        setFileFolders(remote.fileFolders || {});\n        setFolderParents(Object.fromEntries((remote.folders || []).map((folder) => [folder.name || folder.id, folder.parentId || ""])));\n      } catch {\n        setFileFolders({});\n        setFolderParents({});\n      }\n    } else {\n      setFileFolders({});\n      setFolderParents({});\n    }\n    if (!activeWorkspaceId && nextCompany.workspaces?.[0]?.workspaceId) setActiveWorkspaceId(nextCompany.workspaces[0].workspaceId);',
  'refresh drive folders'
);

r(
  '  const createFolder = () => {\n    const folder = newFolder.trim();\n    if (!folder) return;\n    const key = (view === "company" || view === "admin") && activeWorkspace ? companyFolderKey(activeWorkspace.workspaceId, folder) : personalFolderKey(folder);\n    setFileFolders((current) => ({ ...current, [key]: folder }));\n    setActiveFolder(folder);\n    setNewFolder("");\n  };',
  '  const createFolder = () => {\n    const folder = newFolder.trim();\n    if (!folder || folder === ALL_FILES || folder === UNCATEGORIZED) return;\n    const key = (view === "company" || view === "admin") && activeWorkspace ? companyFolderKey(activeWorkspace.workspaceId, folder) : personalFolderKey(folder);\n    const parent = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : "";\n    const nextFolders = { ...fileFolders, [key]: folder };\n    const nextParents = { ...folderParents, [folder]: parent };\n    setFileFolders(nextFolders);\n    setFolderParents(nextParents);\n    setActiveFolder(folder);\n    setNewFolder("");\n    void saveDriveFolders(nextFolders, nextParents).then(refresh);\n  };',
  'createFolder network'
);

if (!s.includes('const renameActiveFolder = () =>')) {
  r(
    '  const upload = () => run(async () => {',
    '  const descendantsOf = (folder: string) => {\n    const removed = new Set<string>([folder]);\n    let changed = true;\n    while (changed) {\n      changed = false;\n      for (const [name, parent] of Object.entries(folderParents)) {\n        if (!removed.has(name) && removed.has(parent)) { removed.add(name); changed = true; }\n      }\n    }\n    return removed;\n  };\n  const renameActiveFolder = () => {\n    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) return;\n    const name = window.prompt("Rename folder", activeFolder)?.trim();\n    if (!name || name === ALL_FILES || name === UNCATEGORIZED || name === activeFolder) return;\n    const nextFolders = Object.fromEntries(Object.entries(fileFolders).map(([key, folder]) => [key, folder === activeFolder ? name : folder]));\n    const nextParents = Object.fromEntries(Object.entries(folderParents).map(([folder, parent]) => [folder === activeFolder ? name : folder, parent === activeFolder ? name : parent]));\n    setFileFolders(nextFolders);\n    setFolderParents(nextParents);\n    setActiveFolder(name);\n    void saveDriveFolders(nextFolders, nextParents).then(refresh);\n  };\n  const deleteActiveFolder = () => {\n    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) return;\n    const removed = descendantsOf(activeFolder);\n    const nextFolders = Object.fromEntries(Object.entries(fileFolders).filter(([, folder]) => !removed.has(folder)));\n    const nextParents = Object.fromEntries(Object.entries(folderParents).filter(([folder]) => !removed.has(folder)).map(([folder, parent]) => [folder, removed.has(parent) ? "" : parent]));\n    setFileFolders(nextFolders);\n    setFolderParents(nextParents);\n    setActiveFolder(ALL_FILES);\n    void saveDriveFolders(nextFolders, nextParents).then(refresh);\n  };\n  const moveActiveFolderToParent = (targetParent: string) => {\n    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) return;\n    const parent = targetParent === UNCATEGORIZED ? "" : targetParent;\n    if (parent === activeFolder || descendantsOf(activeFolder).has(parent)) return;\n    const nextParents = { ...folderParents, [activeFolder]: parent };\n    setFolderParents(nextParents);\n    void saveDriveFolders(fileFolders, nextParents).then(refresh);\n  };\n  const upload = () => run(async () => {',
    'folder action functions'
  );
}

r(
  '      folderPath: activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED ? "" : activeFolder,\n    });',
  '      folderPath: activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED ? "" : activeFolder,\n      folderName: activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED ? "" : activeFolder,\n    });',
  'upload folderName'
);

r(
  '              if (match) void api.invoke("company:updateFile", { workspaceId: match.workspace.workspaceId, rootHash: match.companyFile.rootHash, patch: { folder: nextFolder } }).then(refresh);\n              else setFileFolders((current) => ({ ...current, [file.hash]: nextFolder }));',
  '              if (match) void api.invoke("company:updateFile", { workspaceId: match.workspace.workspaceId, rootHash: match.companyFile.rootHash, patch: { folder: nextFolder } }).then(refresh);\n              else void api.invoke("p2p:updateFile", { hash: file.hash, patch: { folder: nextFolder } }).then(refresh);',
  'personal file folder move'
);

if (!s.includes('Rename folder</Button>')) {
  r(
    '          <div className="flex gap-2">\n            <Input value={newFolder} onChange={(event) => setNewFolder(event.target.value)} placeholder="New folder" />\n            <Button onClick={createFolder} disabled={busy}>+</Button>\n          </div>',
    '          <div className="flex gap-2">\n            <Input value={newFolder} onChange={(event) => setNewFolder(event.target.value)} placeholder="New folder" />\n            <Button onClick={createFolder} disabled={busy}>+</Button>\n          </div>\n          {activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED && (\n            <div className="mt-2 grid gap-2">\n              <Button variant="outline" size="sm" onClick={renameActiveFolder} disabled={busy}>Rename folder</Button>\n              <select value={folderParents[activeFolder] || UNCATEGORIZED} onChange={(event) => moveActiveFolderToParent(event.target.value)} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">\n                <option value={UNCATEGORIZED}>Move to root</option>\n                {orderedFolders.filter((folder) => folder !== ALL_FILES && folder !== UNCATEGORIZED && folder !== activeFolder).map((folder) => <option key={folder} value={folder}>{folderPath(folder)}</option>)}\n              </select>\n              <Button variant="destructive" size="sm" onClick={deleteActiveFolder} disabled={busy}>Delete folder</Button>\n            </div>\n          )}',
    'folder management UI exact block'
  );
}

if (!s.includes('Rename folder</Button>')) {
  r(
    '            <Button onClick={createFolder} disabled={busy}>+</Button>',
    '            <Button onClick={createFolder} disabled={busy}>+</Button>\n          </div>\n          {activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED && (\n            <div className="mt-2 grid gap-2">\n              <Button variant="outline" size="sm" onClick={renameActiveFolder} disabled={busy}>Rename folder</Button>\n              <select value={folderParents[activeFolder] || UNCATEGORIZED} onChange={(event) => moveActiveFolderToParent(event.target.value)} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">\n                <option value={UNCATEGORIZED}>Move to root</option>\n                {orderedFolders.filter((folder) => folder !== ALL_FILES && folder !== UNCATEGORIZED && folder !== activeFolder).map((folder) => <option key={folder} value={folder}>{folderPath(folder)}</option>)}\n              </select>\n              <Button variant="destructive" size="sm" onClick={deleteActiveFolder} disabled={busy}>Delete folder</Button>\n            </div>\n          )}\n          <div className="hidden">',
    'folder management UI fallback'
  );
}

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-live-folder-actions] synced folders through drive IPC with rename/delete/move');
} else {
  console.log('[patch-live-folder-actions] already applied');
}
