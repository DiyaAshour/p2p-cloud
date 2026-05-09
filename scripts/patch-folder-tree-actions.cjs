const fs = require('node:fs');
const path = require('node:path');

const appPath = path.join(process.cwd(), 'client', 'src', 'NativeP2PApp.tsx');
if (!fs.existsSync(appPath)) {
  console.log('[patch-folder-tree-actions] NativeP2PApp.tsx not found.');
  process.exit(0);
}

let src = fs.readFileSync(appPath, 'utf8');
const before = src;

function addAfter(marker, text) {
  if (src.includes(text.trim().slice(0, 60))) return;
  if (!src.includes(marker)) {
    console.warn('[patch-folder-tree-actions] marker not found:', marker.slice(0, 80));
    return;
  }
  src = src.replace(marker, marker + text);
}

function replaceOnce(search, replacement, label) {
  if (!src.includes(search)) {
    console.warn('[patch-folder-tree-actions] skipped:', label);
    return false;
  }
  src = src.replace(search, replacement);
  return true;
}

// Icons needed for folder controls.
if (!src.includes('Edit3')) {
  src = src.replace('ShieldCheck, Trash2, Upload', 'ShieldCheck, Edit3, Trash2, Upload');
}

// Metadata keys/state/persistence.
addAfter('const FILE_FOLDERS_KEY = "peercloud.ui.fileFolders";\n', 'const FOLDER_PARENTS_KEY = "peercloud.ui.folderParents";\n');
addAfter(
  '  const [fileFolders, setFileFolders] = useState<Record<string, string>>(() => safeJson<Record<string, string>>(FILE_FOLDERS_KEY, {}));\n',
  '  const [folderParents, setFolderParents] = useState<Record<string, string>>(() => safeJson<Record<string, string>>(FOLDER_PARENTS_KEY, {}));\n  const [renameFolderValue, setRenameFolderValue] = useState("");\n'
);
addAfter(
  '  useEffect(() => { localStorage.setItem(FILE_FOLDERS_KEY, JSON.stringify(fileFolders)); }, [fileFolders]);\n',
  '  useEffect(() => { localStorage.setItem(FOLDER_PARENTS_KEY, JSON.stringify(folderParents)); }, [folderParents]);\n'
);

// Replace flat folder memo with folder tree helpers.
replaceOnce(
  '  const allFolders = useMemo(() => [ALL_FILES, UNCATEGORIZED, ...folderNames], [folderNames]);\n',
  `  const folderPath = (folder: string) => {
    if (folder === ALL_FILES || folder === UNCATEGORIZED) return folder;
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor = folder;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      chain.unshift(cursor);
      cursor = folderParents[cursor] || "";
    }
    return chain.join(" / ") || folder;
  };
  const folderDepth = (folder: string) => {
    let depth = 0;
    const seen = new Set<string>();
    let cursor = folderParents[folder] || "";
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      cursor = folderParents[cursor] || "";
    }
    return depth;
  };
  const orderedFolders = useMemo(() => {
    const names = [...folderNames];
    const childrenOf = (parent: string) => names.filter((folder) => (folderParents[folder] || "") === parent).sort((a, b) => a.localeCompare(b));
    const result: string[] = [];
    const walk = (parent: string) => {
      for (const child of childrenOf(parent)) {
        result.push(child);
        walk(child);
      }
    };
    walk("");
    for (const orphan of names.sort((a, b) => a.localeCompare(b))) if (!result.includes(orphan)) result.push(orphan);
    return result;
  }, [folderNames, folderParents]);
  const allFolders = useMemo(() => [ALL_FILES, UNCATEGORIZED, ...orderedFolders], [orderedFolders]);
`,
  'folder tree helpers'
);

// Create folder inside currently-open custom folder.
replaceOnce(
  '  const createFolder = () => { const name = newFolderName.trim(); if (!name || name === ALL_FILES || name === UNCATEGORIZED) return; if (folderNames.includes(name)) { toast.error("Folder already exists"); return; } setFolderNames((current) => [...current, name]); setActiveFolder(name); setNewFolderName(""); toast.success(`Folder created: ${name}`); };\n',
  '  const createFolder = () => { const name = newFolderName.trim(); if (!name || name === ALL_FILES || name === UNCATEGORIZED) return; if (folderNames.includes(name)) { toast.error("Folder already exists"); return; } const parent = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : ""; setFolderNames((current) => [...current, name]); setFolderParents((current) => ({ ...current, [name]: parent })); setActiveFolder(name); setNewFolderName(""); toast.success(parent ? `Folder created inside ${folderPath(parent)}: ${name}` : `Folder created: ${name}`); };\n',
  'nested createFolder'
);

// Folder management actions.
if (!src.includes('const folderDescendants = (folder: string) =>')) {
  const marker = '  const moveFileToFolder = (file: P2PFile, folder: string) =>';
  const actions = `  const folderDescendants = (folder: string) => {
    const result = new Set<string>();
    const walk = (parent: string) => {
      for (const child of folderNames.filter((candidate) => (folderParents[candidate] || "") === parent)) {
        if (!result.has(child)) { result.add(child); walk(child); }
      }
    };
    walk(folder);
    return result;
  };
  const renameActiveFolder = () => {
    const name = renameFolderValue.trim();
    if (!name || activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) { toast.error("Open a custom folder first"); return; }
    if (folderNames.includes(name)) { toast.error("Folder already exists"); return; }
    const oldName = activeFolder;
    setFolderNames((current) => current.map((folder) => folder === oldName ? name : folder));
    setFolderParents((current) => Object.fromEntries(Object.entries(current).map(([folder, parent]) => [folder === oldName ? name : folder, parent === oldName ? name : parent])));
    setFileFolders((current) => Object.fromEntries(Object.entries(current).map(([hash, folder]) => [hash, folder === oldName ? name : folder])));
    setActiveFolder(name);
    setRenameFolderValue("");
    toast.success("Folder renamed");
  };
  const removeActiveFolder = () => {
    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) { toast.error("Open a custom folder first"); return; }
    const removed = new Set<string>([activeFolder, ...Array.from(folderDescendants(activeFolder))]);
    const parent = folderParents[activeFolder] || "";
    if (!confirm(\`Remove \${removed.size} folder(s)? Files inside will move to Uncategorized, not be deleted.\`)) return;
    setFolderNames((current) => current.filter((folder) => !removed.has(folder)));
    setFolderParents((current) => {
      const next: Record<string, string> = {};
      for (const [folder, folderParent] of Object.entries(current)) {
        if (!removed.has(folder)) next[folder] = removed.has(folderParent) ? parent : folderParent;
      }
      return next;
    });
    setFileFolders((current) => Object.fromEntries(Object.entries(current).map(([hash, folder]) => [hash, removed.has(folder) ? "" : folder])));
    setActiveFolder(parent || ALL_FILES);
    toast.success(\`Removed \${removed.size} folder(s)\`);
  };
  const moveActiveFolderToParent = (targetParent: string) => {
    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) { toast.error("Open a custom folder first"); return; }
    if (targetParent === activeFolder) { toast.error("A folder cannot contain itself"); return; }
    let cursor = targetParent;
    while (cursor) {
      if (cursor === activeFolder) { toast.error("Cannot move a folder inside its own child"); return; }
      cursor = folderParents[cursor] || "";
    }
    setFolderParents((current) => ({ ...current, [activeFolder]: targetParent === UNCATEGORIZED ? "" : targetParent }));
    toast.success(targetParent && targetParent !== UNCATEGORIZED ? \`Moved folder inside \${folderPath(targetParent)}\` : "Moved folder to root");
  };
`;
  if (src.includes(marker)) src = src.replace(marker, actions + marker);
}

// Sidebar tree display.
src = src.replace(
  '<nav className="grid gap-2 text-sm">{allFolders.map((folder) => <button key={folder} onClick={() => setActiveFolder(folder)} className={`rounded-xl px-4 py-3 text-left transition duration-200 ${activeFolder === folder ? "bg-zinc-800 font-medium text-zinc-50" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"}`}><FolderOpen className="mr-2 inline size-4" />{folder}</button>)}</nav>',
  '<nav className="grid gap-2 text-sm">{allFolders.map((folder) => <button key={folder} onClick={() => setActiveFolder(folder)} style={{ paddingLeft: folder === ALL_FILES || folder === UNCATEGORIZED ? undefined : `${16 + folderDepth(folder) * 18}px` }} className={`rounded-xl px-4 py-3 text-left transition duration-200 ${activeFolder === folder ? "bg-zinc-800 font-medium text-zinc-50" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"}`}><FolderOpen className="mr-2 inline size-4" />{folder === ALL_FILES || folder === UNCATEGORIZED ? folder : folderPath(folder)}</button>)}</nav>'
);

// Replace dropdown labels with full folder paths.
src = src.replaceAll('folderNames.map((folder) => <option key={folder} value={folder}>{folder}</option>)', 'orderedFolders.map((folder) => <option key={folder} value={folder}>{folderPath(folder)}</option>)');

// Folder action panel above the file grid.
if (!src.includes('Remove Folder</Button>')) {
  src = src.replace(
    '<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{visibleFiles.map((file) =>',
    '{activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED && <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4"><div className="flex flex-col gap-2 sm:flex-row"><Input value={renameFolderValue} onChange={(event) => setRenameFolderValue(event.target.value)} placeholder={`Rename folder: ${folderPath(activeFolder)}`} /><Button variant="outline" onClick={renameActiveFolder}><Edit3 className="size-4" />Rename Folder</Button><Button variant="destructive" onClick={removeActiveFolder}><Trash2 className="size-4" />Remove Folder</Button><select value={folderParents[activeFolder] || UNCATEGORIZED} onChange={(event) => moveActiveFolderToParent(event.target.value)} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none"><option value={UNCATEGORIZED}>Move folder to root</option>{orderedFolders.filter((folder) => folder !== activeFolder).map((folder) => <option key={folder} value={folder}>{folderPath(folder)}</option>)}</select></div></div>}<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{visibleFiles.map((file) =>'
  );
}

// Card folder label should show nested path.
src = src.replaceAll('{fileFolders[file.hash] || UNCATEGORIZED}</p>', '{fileFolders[file.hash] ? folderPath(fileFolders[file.hash]) : UNCATEGORIZED}</p>');

if (src !== before) {
  fs.writeFileSync(appPath, src, 'utf8');
  console.log('[patch-folder-tree-actions] fixed nested folders and folder removal.');
} else {
  console.log('[patch-folder-tree-actions] no changes needed.');
}
