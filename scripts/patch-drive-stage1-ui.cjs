const fs = require('node:fs');
const path = require('node:path');

const appPath = path.join(process.cwd(), 'client', 'src', 'NativeP2PApp.tsx');
let src = fs.readFileSync(appPath, 'utf8');
const original = src;

function replaceOnce(search, replacement, label) {
  if (!src.includes(search)) {
    console.warn(`[patch-drive-stage1-ui] skipped ${label}: marker not found`);
    return;
  }
  src = src.replace(search, replacement);
}

function insertAfter(search, insertion, label) {
  if (src.includes(insertion.trim().slice(0, 60))) {
    return;
  }
  replaceOnce(search, `${search}${insertion}`, label);
}

// 1) Icons for select, move, rename.
if (!src.includes('CheckSquare')) {
  src = src.replace(
    'MoreHorizontal, Plus, RefreshCw, Search, ShieldCheck, Trash2, Upload, Wallet, Wifi, X, Zap',
    'MoreHorizontal, Plus, RefreshCw, Search, ShieldCheck, CheckSquare, Edit3, MoveRight, Trash2, Upload, Wallet, Wifi, X, Zap'
  );
}

// 2) Local durable UI metadata keys. Chunks and encryption stay untouched.
insertAfter(
  'const FILE_FOLDERS_KEY = "peercloud.ui.fileFolders";\n',
  'const FILE_NAMES_KEY = "peercloud.ui.fileNames";\n',
  'file name alias key'
);

// 3) State for aliases, selection mode, bulk move, and rename.
insertAfter(
  '  const [fileFolders, setFileFolders] = useState<Record<string, string>>(() => safeJson<Record<string, string>>(FILE_FOLDERS_KEY, {}));\n',
  '  const [fileNames, setFileNames] = useState<Record<string, string>>(() => safeJson<Record<string, string>>(FILE_NAMES_KEY, {}));\n',
  'fileNames state'
);
insertAfter(
  '  const [newFolderName, setNewFolderName] = useState("");\n',
  '  const [selectMode, setSelectMode] = useState(false);\n  const [selectedStoredHashes, setSelectedStoredHashes] = useState<string[]>([]);\n  const [moveTargetFolder, setMoveTargetFolder] = useState(UNCATEGORIZED);\n  const [renameValue, setRenameValue] = useState("");\n  const [renameFolderValue, setRenameFolderValue] = useState("");\n',
  'selection state'
);

// 4) Persist aliases.
insertAfter(
  '  useEffect(() => { localStorage.setItem(FILE_FOLDERS_KEY, JSON.stringify(fileFolders)); }, [fileFolders]);\n',
  '  useEffect(() => { localStorage.setItem(FILE_NAMES_KEY, JSON.stringify(fileNames)); }, [fileNames]);\n',
  'fileNames persistence'
);

// 5) Display names and search through renamed files.
insertAfter(
  '  const uploadWouldExceedQuota = Boolean(wallet && selectedBytes > 0 && wallet.usedBytes + selectedBytes > wallet.plan.quotaBytes);\n',
  '  const displayFileName = (file: P2PFile) => fileNames[file.hash]?.trim() || file.name;\n',
  'displayFileName helper'
);
src = src.replace(
  '[file.name, file.hash, file.rootHash, file.ownerWallet || "", folder]',
  '[displayFileName(file), file.name, file.hash, file.rootHash, file.ownerWallet || "", folder]'
);

// 6) Derived selected objects.
insertAfter(
  '  }, [files, fileFolders, activeFolder, search]);\n',
  '  const selectedStoredFiles = useMemo(() => files.filter((file) => selectedStoredHashes.includes(file.hash)), [files, selectedStoredHashes]);\n  const selectedStoredBytes = useMemo(() => selectedStoredFiles.reduce((sum, file) => sum + Number(file.size || 0), 0), [selectedStoredFiles]);\n  const allVisibleSelected = visibleFiles.length > 0 && visibleFiles.every((file) => selectedStoredHashes.includes(file.hash));\n',
  'selected stored files derived state'
);

// 7) Bulk actions. They only change UI metadata except delete/download which use existing IPC.
insertAfter(
  '  const moveFileToFolder = (file: P2PFile, folder: string) => { setFileFolders((current) => ({ ...current, [file.hash]: folder === UNCATEGORIZED ? "" : folder })); toast.success(`Moved ${file.name}`); };\n',
  `  const toggleStoredFileSelection = (hash: string) => {
    setSelectedStoredHashes((current) => current.includes(hash) ? current.filter((item) => item !== hash) : [...current, hash]);
  };
  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedStoredHashes((current) => current.filter((hash) => !visibleFiles.some((file) => file.hash === hash)));
      return;
    }
    setSelectedStoredHashes((current) => Array.from(new Set([...current, ...visibleFiles.map((file) => file.hash)])));
  };
  const exitSelectMode = () => { setSelectMode(false); setSelectedStoredHashes([]); setRenameValue(""); };
  const moveSelectedToFolder = () => {
    if (!selectedStoredHashes.length) { toast.error("Select files or images first"); return; }
    setFileFolders((current) => {
      const next = { ...current };
      for (const hash of selectedStoredHashes) next[hash] = moveTargetFolder === UNCATEGORIZED ? "" : moveTargetFolder;
      return next;
    });
    toast.success(\`Moved \${selectedStoredHashes.length} item(s)\`);
  };
  const renameSelectedItem = () => {
    const name = renameValue.trim();
    if (selectedStoredHashes.length !== 1) { toast.error("Select exactly one file to rename"); return; }
    if (name.length < 1) { toast.error("Enter a new name"); return; }
    const hash = selectedStoredHashes[0];
    setFileNames((current) => ({ ...current, [hash]: name }));
    toast.success("Renamed");
  };
  const renameActiveFolder = () => {
    const name = renameFolderValue.trim();
    if (!name || activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) { toast.error("Open a custom folder first"); return; }
    if (folderNames.includes(name)) { toast.error("Folder already exists"); return; }
    const oldName = activeFolder;
    setFolderNames((current) => current.map((folder) => folder === oldName ? name : folder));
    setFileFolders((current) => Object.fromEntries(Object.entries(current).map(([hash, folder]) => [hash, folder === oldName ? name : folder])));
    setActiveFolder(name);
    setRenameFolderValue("");
    toast.success("Folder renamed");
  };
  const deleteSelectedFiles = () => runBusy(async () => {
    if (!selectedStoredHashes.length) throw new Error("Select files or images first");
    if (!confirm(\`Delete \${selectedStoredHashes.length} selected item(s)?\`)) return;
    for (const hash of selectedStoredHashes) await bridge.invoke("p2p:delete", { hash });
    setFileFolders((current) => { const next = { ...current }; for (const hash of selectedStoredHashes) delete next[hash]; return next; });
    setFileNames((current) => { const next = { ...current }; for (const hash of selectedStoredHashes) delete next[hash]; return next; });
    exitSelectMode();
    toast.success("Selected item(s) removed");
    await refreshAll();
  });
  const downloadSelectedFiles = () => runBusy(async () => {
    if (!selectedStoredFiles.length) throw new Error("Select files or images first");
    for (const file of selectedStoredFiles) {
      const password = file.isEncrypted ? getDrivePassword() : null;
      const result = await bridge.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword: password });
      const blob = new Blob([new Uint8Array(result.bytes)], { type: result.file.mimeType || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = displayFileName(file);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    }
    toast.success("Selected download(s) started");
  });
`,
  'bulk action functions'
);

// 8) Renamed files should download with the UI name.
src = src.replace(
  'anchor.download = result.file.name;',
  'anchor.download = displayFileName(file);'
);

// 9) Replace displayed card name with alias-aware display name.
src = src.replace(
  '<h2 className="truncate font-semibold">{file.name}</h2>',
  '<h2 className="truncate font-semibold">{displayFileName(file)}</h2>'
);

// 10) Add toolbar before the file grid.
replaceOnce(
  '<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{visibleFiles.map((file) => <Card key={file.hash}',
  `<div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
  <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
    <div>
      <p className="font-medium">{selectMode ? \`${selectedStoredHashes.length} selected · ${formatBytes(selectedStoredBytes)}\` : \`${visibleFiles.length} item(s) in ${activeFolder}\`}</p>
      <p className="text-xs text-zinc-500">Select files or images, then move, rename, download, or delete without changing encrypted chunks.</p>
    </div>
    <div className="flex flex-wrap gap-2">
      <Button variant={selectMode ? "default" : "outline"} onClick={() => { setSelectMode((value) => !value); if (selectMode) setSelectedStoredHashes([]); }}><CheckSquare className="size-4" />{selectMode ? "Done" : "Select"}</Button>
      {selectMode && <Button variant="outline" onClick={toggleSelectAllVisible}>{allVisibleSelected ? "Unselect visible" : "Select visible"}</Button>}
      {selectMode && <Button variant="ghost" onClick={exitSelectMode}>Cancel</Button>}
    </div>
  </div>
  {selectMode && <div className="mt-4 grid gap-3 rounded-2xl border border-zinc-800 bg-zinc-950 p-4 lg:grid-cols-[1fr_1fr_auto_auto]">
    <select value={moveTargetFolder} onChange={(event) => setMoveTargetFolder(event.target.value)} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none">
      <option value={UNCATEGORIZED}>Uncategorized</option>{folderNames.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
    </select>
    <Input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} placeholder="Rename selected file" disabled={selectedStoredHashes.length !== 1} />
    <Button variant="outline" onClick={moveSelectedToFolder} disabled={!selectedStoredHashes.length}><MoveRight className="size-4" />Move</Button>
    <Button variant="outline" onClick={renameSelectedItem} disabled={selectedStoredHashes.length !== 1}><Edit3 className="size-4" />Rename</Button>
    <Button variant="outline" onClick={downloadSelectedFiles} disabled={!selectedStoredHashes.length || busy}><Download className="size-4" />Download</Button>
    <Button variant="destructive" onClick={deleteSelectedFiles} disabled={!selectedStoredHashes.length || busy}><Trash2 className="size-4" />Delete</Button>
  </div>}
  {activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED && <div className="mt-3 flex flex-col gap-2 border-t border-zinc-800 pt-3 sm:flex-row">
    <Input value={renameFolderValue} onChange={(event) => setRenameFolderValue(event.target.value)} placeholder={\`Rename folder: ${activeFolder}\`} />
    <Button variant="outline" onClick={renameActiveFolder}><Edit3 className="size-4" />Rename Folder</Button>
  </div>}
</div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{visibleFiles.map((file) => <Card key={file.hash}`,
  'files bulk toolbar'
);

// 11) Add per-card select button next to existing actions.
replaceOnce(
  '<div className="flex flex-wrap gap-2">{isImageFile(file) &&',
  '<div className="flex flex-wrap gap-2">{selectMode && <Button variant={selectedStoredHashes.includes(file.hash) ? "default" : "outline"} size="sm" onClick={() => toggleStoredFileSelection(file.hash)}><CheckSquare className="size-4" />{selectedStoredHashes.includes(file.hash) ? "Selected" : "Select"}</Button>}{isImageFile(file) &&',
  'per-card select button'
);

if (src !== original) {
  fs.writeFileSync(appPath, src, 'utf8');
  console.log('[patch-drive-stage1-ui] applied Drive stage 1 UX: select, bulk move, rename, delete, download, folder rename.');
} else {
  console.log('[patch-drive-stage1-ui] no changes needed.');
}
