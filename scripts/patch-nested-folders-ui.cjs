const fs = require('node:fs');
const path = require('node:path');

const appPath = path.join(process.cwd(), 'client', 'src', 'NativeP2PApp.tsx');
let src = fs.readFileSync(appPath, 'utf8');
const original = src;

function replaceOnce(search, replacement, label) {
  if (!src.includes(search)) {
    console.warn(`[patch-nested-folders-ui] skipped ${label}: marker not found`);
    return false;
  }
  src = src.replace(search, replacement);
  return true;
}

function insertAfter(search, insertion, label) {
  if (src.includes(insertion.trim().slice(0, 70))) return;
  replaceOnce(search, `${search}${insertion}`, label);
}

// Durable local metadata for a folder tree. Files/chunks/encryption are not touched.
insertAfter(
  'const FILE_NAMES_KEY = "peercloud.ui.fileNames";\n',
  'const FOLDER_PARENTS_KEY = "peercloud.ui.folderParents";\n',
  'folder parents key'
);

insertAfter(
  '  const [fileNames, setFileNames] = useState<Record<string, string>>(() => safeJson<Record<string, string>>(FILE_NAMES_KEY, {}));\n',
  '  const [folderParents, setFolderParents] = useState<Record<string, string>>(() => safeJson<Record<string, string>>(FOLDER_PARENTS_KEY, {}));\n',
  'folder parents state'
);

insertAfter(
  '  useEffect(() => { localStorage.setItem(FILE_NAMES_KEY, JSON.stringify(fileNames)); }, [fileNames]);\n',
  '  useEffect(() => { localStorage.setItem(FOLDER_PARENTS_KEY, JSON.stringify(folderParents)); }, [folderParents]);\n',
  'folder parents persistence'
);

// Replace flat folder list with an ordered tree and path labels.
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
  'tree folder helpers'
);

// Create folder under the currently opened folder.
replaceOnce(
  '  const createFolder = () => { const name = newFolderName.trim(); if (!name || name === ALL_FILES || name === UNCATEGORIZED) return; if (folderNames.includes(name)) { toast.error("Folder already exists"); return; } setFolderNames((current) => [...current, name]); setActiveFolder(name); setNewFolderName(""); toast.success(`Folder created: ${name}`); };\n',
  '  const createFolder = () => { const name = newFolderName.trim(); if (!name || name === ALL_FILES || name === UNCATEGORIZED) return; if (folderNames.includes(name)) { toast.error("Folder already exists"); return; } const parent = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : ""; setFolderNames((current) => [...current, name]); setFolderParents((current) => ({ ...current, [name]: parent })); setActiveFolder(name); setNewFolderName(""); toast.success(parent ? `Folder created inside ${parent}: ${name}` : `Folder created: ${name}`); };\n',
  'nested create folder'
);

// Renaming a folder should also update parent references for children.
replaceOnce(
  '    setFolderParents((current) => Object.fromEntries(Object.entries(current).map(([folder, parent]) => [folder === oldName ? name : folder, parent === oldName ? name : parent])));',
  '    setFolderParents((current) => Object.fromEntries(Object.entries(current).map(([folder, parent]) => [folder === oldName ? name : folder, parent === oldName ? name : parent])));',
  'folder parents rename already present'
);
if (!src.includes('parent === oldName ? name : parent')) {
  replaceOnce(
    '    setFolderNames((current) => current.map((folder) => folder === oldName ? name : folder));\n    setFileFolders((current) => Object.fromEntries(Object.entries(current).map(([hash, folder]) => [hash, folder === oldName ? name : folder])));\n',
    '    setFolderNames((current) => current.map((folder) => folder === oldName ? name : folder));\n    setFolderParents((current) => Object.fromEntries(Object.entries(current).map(([folder, parent]) => [folder === oldName ? name : folder, parent === oldName ? name : parent])));\n    setFileFolders((current) => Object.fromEntries(Object.entries(current).map(([hash, folder]) => [hash, folder === oldName ? name : folder])));\n',
    'rename folder children references'
  );
}

// Add helper to move current folder under another folder or root, avoiding cycles.
insertAfter(
  '  const renameActiveFolder = () => {\n',
  '',
  'noop marker'
);
if (!src.includes('const moveActiveFolderToParent = (targetParent: string) =>')) {
  const marker = '  const deleteSelectedFiles = () => runBusy(async () => {';
  const insertion = `  const moveActiveFolderToParent = (targetParent: string) => {
    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) { toast.error("Open a custom folder first"); return; }
    if (targetParent === activeFolder) { toast.error("A folder cannot contain itself"); return; }
    let cursor = targetParent;
    while (cursor) {
      if (cursor === activeFolder) { toast.error("Cannot move a folder inside its own child"); return; }
      cursor = folderParents[cursor] || "";
    }
    setFolderParents((current) => ({ ...current, [activeFolder]: targetParent === UNCATEGORIZED ? "" : targetParent }));
    toast.success(targetParent && targetParent !== UNCATEGORIZED ? \`Moved folder inside \${targetParent}\` : "Moved folder to root");
  };
`;
  replaceOnce(marker, `${insertion}${marker}`, 'move active folder helper');
}

// Sidebar: display folder tree indentation and full paths.
src = src.replaceAll(
  'folderNames.map((folder) => <option key={folder} value={folder}>{folder}</option>)',
  'orderedFolders.map((folder) => <option key={folder} value={folder}>{folderPath(folder)}</option>)'
);
src = src.replaceAll(
  '{folderNames.map((folder) => <option key={folder} value={folder}>{folder}</option>)}',
  '{orderedFolders.map((folder) => <option key={folder} value={folder}>{folderPath(folder)}</option>)}'
);

replaceOnce(
  '<nav className="grid gap-2 text-sm">{allFolders.map((folder) => <button key={folder} onClick={() => setActiveFolder(folder)} className={`rounded-xl px-4 py-3 text-left transition duration-200 ${activeFolder === folder ? "bg-zinc-800 font-medium text-zinc-50" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"}`}><FolderOpen className="mr-2 inline size-4" />{folder}</button>)}</nav>',
  '<nav className="grid gap-2 text-sm">{allFolders.map((folder) => <button key={folder} onClick={() => setActiveFolder(folder)} style={{ paddingLeft: folder === ALL_FILES || folder === UNCATEGORIZED ? undefined : `${16 + folderDepth(folder) * 18}px` }} className={`rounded-xl px-4 py-3 text-left transition duration-200 ${activeFolder === folder ? "bg-zinc-800 font-medium text-zinc-50" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"}`}><FolderOpen className="mr-2 inline size-4" />{folder === ALL_FILES || folder === UNCATEGORIZED ? folder : folderPath(folder)}</button>)}</nav>',
  'sidebar tree nav'
);

// Active folder management UI: rename and move folder under parent.
replaceOnce(
  '    <Button variant="outline" onClick={renameActiveFolder}><Edit3 className="size-4" />Rename Folder</Button>\n  </div>}\n</div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{visibleFiles.map((file) => <Card key={file.hash}',
  '    <Button variant="outline" onClick={renameActiveFolder}><Edit3 className="size-4" />Rename Folder</Button>\n    <select value={folderParents[activeFolder] || UNCATEGORIZED} onChange={(event) => moveActiveFolderToParent(event.target.value)} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none">\n      <option value={UNCATEGORIZED}>Move folder to root</option>{orderedFolders.filter((folder) => folder !== activeFolder).map((folder) => <option key={folder} value={folder}>{folderPath(folder)}</option>)}\n    </select>\n  </div>}\n</div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{visibleFiles.map((file) => <Card key={file.hash}',
  'folder move UI'
);

// Card folder label should show path, not only leaf name.
src = src.replaceAll(
  '<FolderOpen className="mr-1 inline size-3" />{fileFolders[file.hash] || UNCATEGORIZED}',
  '<FolderOpen className="mr-1 inline size-3" />{fileFolders[file.hash] ? folderPath(fileFolders[file.hash]) : UNCATEGORIZED}'
);

if (src !== original) {
  fs.writeFileSync(appPath, src, 'utf8');
  console.log('[patch-nested-folders-ui] applied nested folders: folder tree, create inside folder, move folder, path labels.');
} else {
  console.log('[patch-nested-folders-ui] no changes needed.');
}
