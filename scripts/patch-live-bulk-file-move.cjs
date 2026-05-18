const fs = require('node:fs');
const path = require('node:path');

const p = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(p)) {
  console.warn('[live-bulk-file-move] NativeP2PAppLive.tsx not found');
  process.exit(0);
}

let s = fs.readFileSync(p, 'utf8');
const before = s;

function mustReplace(label, from, to) {
  if (s.includes(to) || s.includes(label)) return;
  if (!s.includes(from)) {
    throw new Error(`[live-bulk-file-move] required marker not found: ${label}`);
  }
  s = s.replace(from, to);
}

function mustReplaceRegex(label, regex, replacer) {
  if (s.includes(label)) return;
  if (!regex.test(s)) throw new Error(`[live-bulk-file-move] required regex marker not found: ${label}`);
  s = s.replace(regex, replacer);
}

// IPC contract: moving personal files must go through manifest backend.
if (!s.includes('| "p2p:moveItem"')) {
  s = s.replace('  | "p2p:prepareProof"', '  | "p2p:moveItem"\n  | "p2p:prepareProof"');
}
if (!s.includes('| "p2p:listFolders"')) {
  s = s.replace('  | "p2p:listFiles"', '  | "p2p:listFiles"\n  | "p2p:listFolders"');
}

// Types used by manifest folders and per-file folder metadata.
s = s.replace(
  'type P2PFile = { id?: string; name: string; size: number; hash: string; rootHash: string; uploadedAt: string; isEncrypted: boolean; totalChunks: number; ownerWallet?: string; replicas?: string[]; replicationStatus?: string; protectedChunks?: number; needsRepairChunks?: number };\ntype View = "personal" | "company" | "shared" | "admin";',
  'type P2PFile = { id?: string; name: string; size: number; hash: string; rootHash: string; uploadedAt: string; isEncrypted: boolean; totalChunks: number; ownerWallet?: string; replicas?: string[]; replicationStatus?: string; protectedChunks?: number; needsRepairChunks?: number; folderId?: string; parentFolderId?: string; folderName?: string; folder?: string };\ntype ManifestFolder = { id?: string; name: string; folderId?: string; parentFolderId?: string | null; hash?: string; rootHash?: string; kind?: string; isFolder?: boolean };\ntype View = "personal" | "company" | "shared" | "admin";'
);
if (!s.includes('type ManifestFolder =')) {
  s = s.replace(
    'type View = "personal" | "company" | "shared" | "admin";',
    'type ManifestFolder = { id?: string; name: string; folderId?: string; parentFolderId?: string | null; hash?: string; rootHash?: string; kind?: string; isFolder?: boolean };\ntype View = "personal" | "company" | "shared" | "admin";'
  );
}

if (!s.includes('function itemIdFor(file: P2PFile)')) {
  mustReplace(
    'itemIdFor helper',
    'function keyFor(file: P2PFile) {\n  return file.rootHash || file.hash;\n}',
    'function keyFor(file: P2PFile) {\n  return file.rootHash || file.hash;\n}\nfunction itemIdFor(file: P2PFile) {\n  return file.id || file.rootHash || file.hash;\n}\nfunction folderProp(file: P2PFile, key: string) {\n  return String((file as unknown as Record<string, unknown>)?.[key] || "").trim();\n}\nfunction folderIds(folder: ManifestFolder) {\n  return [folder.folderId, folder.id, folder.hash, folder.rootHash].filter(Boolean).map((value) => String(value));\n}'
  );
}

if (!s.includes('const [manifestFolders, setManifestFolders] = useState<ManifestFolder[]>([])')) {
  mustReplace(
    'bulk state',
    '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});',
    '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n  const [manifestFolders, setManifestFolders] = useState<ManifestFolder[]>([]);\n  const [bulkTargetFolder, setBulkTargetFolder] = useState(UNCATEGORIZED);\n  const [selectedFileKeys, setSelectedFileKeys] = useState<Record<string, boolean>>({});'
  );
} else {
  if (!s.includes('const [bulkTargetFolder, setBulkTargetFolder] = useState(UNCATEGORIZED);')) {
    s = s.replace(
      '  const [manifestFolders, setManifestFolders] = useState<ManifestFolder[]>([]);',
      '  const [manifestFolders, setManifestFolders] = useState<ManifestFolder[]>([]);\n  const [bulkTargetFolder, setBulkTargetFolder] = useState(UNCATEGORIZED);\n  const [selectedFileKeys, setSelectedFileKeys] = useState<Record<string, boolean>>({});'
    );
  }
}

// Manifest folder source: personal folders must come from p2p:listFolders, not localStorage.
if (!s.includes('const liveManifestFolders = useMemo(() =>')) {
  mustReplace(
    'manifest folder source',
    '  const personalFiles = useMemo(() => files.filter((file) => !companyFileByKey.has(keyFor(file)) && !companyFileByKey.has(file.hash)), [files, companyFileByKey]);',
    '  const liveManifestFolders = useMemo(() => (Array.isArray(manifestFolders) ? manifestFolders.filter((folder) => folder?.name && folder?.folderId) : []), [manifestFolders]);\n  const manifestFolderNames = useMemo(() => new Set(liveManifestFolders.map((folder) => String(folder.name || ""))), [liveManifestFolders]);\n  const manifestFolderByAnyId = useMemo(() => {\n    const map = new Map<string, ManifestFolder>();\n    for (const folder of liveManifestFolders) for (const id of folderIds(folder)) map.set(id, folder);\n    return map;\n  }, [liveManifestFolders]);\n  const personalFolderForFile = (file: P2PFile) => {\n    const rawId = folderProp(file, "parentFolderId") || folderProp(file, "folderId");\n    const byId = rawId ? manifestFolderByAnyId.get(rawId) : null;\n    if (byId?.name) return byId.name;\n    const rawName = folderProp(file, "folderName") || folderProp(file, "folder");\n    return rawName && manifestFolderNames.has(rawName) ? rawName : UNCATEGORIZED;\n  };\n  const folderTargetByName = (folderName: string) => liveManifestFolders.find((folder) => folder.name === folderName) || null;\n  const personalFiles = useMemo(() => files.filter((file) => !companyFileByKey.has(keyFor(file)) && !companyFileByKey.has(file.hash)), [files, companyFileByKey]);'
  );
}

// Replace folder list computation: remove personal localStorage folders completely.
const oldFoldersBlock = `  const folders = useMemo(() => {
    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];
    const personalFileKeys = new Set(personalFiles.map((file) => file.hash));
    const personalFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith("personal:folder:") || personalFileKeys.has(key)).map(([, folder]) => folder).filter(Boolean);
    const companyPrefix = activeWorkspace ? \`company:\${activeWorkspace.workspaceId}:folder:\` : "company:none:folder:";
    const companyFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith(companyPrefix)).map(([, folder]) => folder).filter(Boolean);
    const sourceFolders = view === "company" || view === "admin" ? [...workspaceFolders, ...companyFolders] : personalFolders;
    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];
  }, [fileFolders, activeWorkspace, personalFiles, view]);`;
const newFoldersBlock = `  const folders = useMemo(() => {
    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];
    const companyPrefix = activeWorkspace ? \`company:\${activeWorkspace.workspaceId}:folder:\` : "company:none:folder:";
    const companyFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith(companyPrefix)).map(([, folder]) => folder).filter(Boolean);
    const personalFolders = liveManifestFolders.map((folder) => folder.name).filter(Boolean);
    const sourceFolders = view === "company" || view === "admin" ? [...workspaceFolders, ...companyFolders] : personalFolders;
    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];
  }, [fileFolders, activeWorkspace, liveManifestFolders, view]);`;
if (s.includes(oldFoldersBlock)) s = s.replace(oldFoldersBlock, newFoldersBlock);

// Visible file filtering must use manifest labels.
s = s.replaceAll('const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;', 'const folder = cf?.folder || personalFolderForFile(file);');
s = s.replaceAll('const folder = cf?.folder || fileFolders[file.rootHash] || fileFolders[file.hash] || UNCATEGORIZED;', 'const folder = cf?.folder || personalFolderForFile(file);');

// Refresh must fetch live folders too.
s = s.replace(
  '    const [nextSummary, nextFiles, nextWallet, nextCompany] = await Promise.all([\n      api.invoke<Summary>("p2p:networkSummary"),\n      api.invoke<P2PFile[]>("p2p:listFiles", { query: search }),\n      api.invoke<WalletState>("wallet:status"),\n      api.invoke<CompanyState>("company:state"),\n    ]);\n    setSummary(nextSummary);\n    setFiles(Array.isArray(nextFiles) ? nextFiles : []);\n    setWallet(nextWallet);\n    setCompany(nextCompany);',
  '    const [nextSummary, nextFiles, nextFolders, nextWallet, nextCompany] = await Promise.all([\n      api.invoke<Summary>("p2p:networkSummary"),\n      api.invoke<P2PFile[]>("p2p:listFiles", { query: search }),\n      api.invoke<ManifestFolder[]>("p2p:listFolders").catch(() => [] as ManifestFolder[]),\n      api.invoke<WalletState>("wallet:status"),\n      api.invoke<CompanyState>("company:state"),\n    ]);\n    setSummary(nextSummary);\n    setFiles(Array.isArray(nextFiles) ? nextFiles : []);\n    setManifestFolders(Array.isArray(nextFolders) ? nextFolders : []);\n    setWallet(nextWallet);\n    setCompany(nextCompany);'
);

// Add selection/move handlers.
if (!s.includes('const moveSelectedFiles = () => run(async () =>')) {
  mustReplace(
    'bulk move handlers',
    '  const share = (file: P2PFile) => {\n    const link = `chunknet://file/${file.rootHash || file.hash}`;\n    void navigator.clipboard.writeText(link).then(() => toast.success("Share link copied"));\n  };',
    '  const share = (file: P2PFile) => {\n    const link = `chunknet://file/${file.rootHash || file.hash}`;\n    void navigator.clipboard.writeText(link).then(() => toast.success("Share link copied"));\n  };\n  const selectedFiles = useMemo(() => visibleFiles.filter((file) => selectedFileKeys[keyFor(file)]), [visibleFiles, selectedFileKeys]);\n  const toggleFileSelected = (file: P2PFile) => {\n    const key = keyFor(file);\n    setSelectedFileKeys((current) => ({ ...current, [key]: !current[key] }));\n  };\n  const selectAllVisibleFiles = () => {\n    setSelectedFileKeys((current) => {\n      const next = { ...current };\n      for (const file of visibleFiles) next[keyFor(file)] = true;\n      return next;\n    });\n  };\n  const clearSelectedFiles = () => setSelectedFileKeys({});\n  const moveSelectedFiles = () => run(async () => {\n    if (!selectedFiles.length) throw new Error("Select at least one file");\n    const targetName = bulkTargetFolder === UNCATEGORIZED ? "" : bulkTargetFolder;\n    const targetFolder = targetName ? folderTargetByName(targetName) : null;\n    if (targetName && !targetFolder) throw new Error("Target folder not found in manifest");\n    const targetFolderId = targetFolder ? String(targetFolder.folderId || targetFolder.id || "") : "";\n    for (const file of selectedFiles) {\n      const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);\n      if (match) {\n        await api.invoke("company:updateFile", { workspaceId: match.workspace.workspaceId, rootHash: match.companyFile.rootHash, patch: { folder: targetName } });\n      } else {\n        await api.invoke("p2p:moveItem", { itemId: itemIdFor(file), targetFolderId });\n      }\n    }\n    const movedCount = selectedFiles.length;\n    clearSelectedFiles();\n    await refresh();\n    toast.success(targetName ? `Moved ${movedCount} file(s) to ${targetName}` : `Moved ${movedCount} file(s) to Uncategorized`);\n  });'
  );
}

// Checkbox inside each card.
if (!s.includes('aria-label="Bulk select row"')) {
  mustReplace(
    'bulk select row',
    '        <CardContent className="space-y-4 p-5">\n          <div className="flex h-24 items-center justify-center rounded-2xl bg-zinc-950"><FileCheck2 className="size-10" /></div>',
    '        <CardContent className="space-y-4 p-5">\n          <div className="flex items-center justify-between gap-2" aria-label="Bulk select row">\n            <label className="flex items-center gap-2 text-xs text-zinc-400">\n              <Checkbox checked={Boolean(selectedFileKeys[keyFor(file)])} onCheckedChange={() => toggleFileSelected(file)} />\n              Select\n            </label>\n            {selectedFileKeys[keyFor(file)] && <Badge variant="outline" className="text-[10px]">selected</Badge>}\n          </div>\n          <div className="flex h-24 items-center justify-center rounded-2xl bg-zinc-950"><FileCheck2 className="size-10" /></div>'
  );
}

// Per-file dropdown must write manifest, not local state.
s = s.replace(
  '              else setFileFolders((current) => ({ ...current, [file.hash]: nextFolder }));',
  '              else {\n                const targetFolder = nextFolder ? folderTargetByName(nextFolder) : null;\n                if (nextFolder && !targetFolder) { toast.error("Target folder not found"); return; }\n                void api.invoke("p2p:moveItem", { itemId: itemIdFor(file), targetFolderId: targetFolder ? targetFolder.folderId : "" })\n                  .then(() => refresh())\n                  .catch((error) => toast.error(err(error)));\n              }'
);

// Toolbar above grid.
if (!s.includes('aria-label="Move selected files manifest toolbar"')) {
  mustReplace(
    'bulk move toolbar',
    '              <div className="relative">\n                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />\n                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files, folders, company, hash" className="pl-9" />\n              </div>\n              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">',
    '              <div className="relative">\n                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />\n                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files, folders, company, hash" className="pl-9" />\n              </div>\n              <Card className="rounded-2xl border-zinc-800 bg-zinc-900" aria-label="Move selected files manifest toolbar">\n                <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">\n                  <div className="text-sm text-zinc-400"><span className="font-medium text-zinc-100">{selectedFiles.length}</span> file(s) selected</div>\n                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">\n                    <select value={bulkTargetFolder} onChange={(event) => setBulkTargetFolder(event.target.value)} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">\n                      <option>{UNCATEGORIZED}</option>\n                      {folders.filter((folderName) => folderName !== ALL_FILES && folderName !== UNCATEGORIZED).map((folderName) => <option key={folderName}>{folderName}</option>)}\n                    </select>\n                    <Button variant="outline" size="sm" onClick={selectAllVisibleFiles} disabled={busy || visibleFiles.length === 0}>Select visible</Button>\n                    <Button variant="outline" size="sm" onClick={clearSelectedFiles} disabled={busy || selectedFiles.length === 0}>Clear</Button>\n                    <Button size="sm" onClick={moveSelectedFiles} disabled={busy || selectedFiles.length === 0}>Move selected</Button>\n                  </div>\n                </CardContent>\n              </Card>\n              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">'
  );
}

// No local personal file-folder persistence.
s = s.replace(
  '  useEffect(() => {\n    localStorage.setItem(folderStorageKey, JSON.stringify(fileFolders));\n  }, [fileFolders, folderStorageKey]);',
  '  useEffect(() => {\n    const cleaned = Object.fromEntries(Object.entries(fileFolders).filter(([key]) => !key.startsWith("personal:folder:")));\n    localStorage.setItem(folderStorageKey, JSON.stringify(cleaned));\n  }, [fileFolders, folderStorageKey]);'
);

// Hard proof: final file must include visible UI labels.
for (const required of ['aria-label="Move selected files manifest toolbar"', 'aria-label="Bulk select row"', 'p2p:moveItem']) {
  if (!s.includes(required)) throw new Error(`[live-bulk-file-move] final verification failed: ${required}`);
}

if (s !== before) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[live-bulk-file-move] selected files can now move through manifests in one action');
} else {
  console.log('[live-bulk-file-move] already patched');
}
