const fs = require('node:fs');
const path = require('node:path');

const appPath = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(appPath)) {
  console.log('[patch-live-drive-ui] NativeP2PAppLive.tsx not found.');
  process.exit(0);
}

let src = fs.readFileSync(appPath, 'utf8');
const before = src;

function replaceOnce(search, replacement, label) {
  if (!src.includes(search)) {
    console.warn('[patch-live-drive-ui] skipped:', label);
    return false;
  }
  src = src.replace(search, replacement);
  return true;
}

function addAfter(marker, text, label) {
  if (src.includes(text.trim().slice(0, 60))) return;
  replaceOnce(marker, marker + text, label);
}

// 1) UI branding only. Do not rename internal replica ids.
src = src
  .replaceAll('AWS safety peer', 'Chunknet safety peer')
  .replaceAll('AWS safety peer enabled', 'Chunknet safety peer enabled')
  .replaceAll('+ AWS safety', '+ Chunknet safety');

// 2) Import icon for folder rename controls.
if (!src.includes('Edit3')) {
  src = src.replace('ShieldCheck, Trash2, Upload', 'ShieldCheck, Edit3, Trash2, Upload');
}

// 3) Persistent nested folder metadata.
addAfter(
  'const FILE_FOLDERS_KEY = "chunknet.ui.fileFolders";\n',
  'const FOLDER_PARENTS_KEY = "chunknet.ui.folderParents";\n',
  'folder parents key'
);

addAfter(
  '  const [fileFolders, setFileFolders] = useState<Record<string, string>>(() => readJson<Record<string, string>>(FILE_FOLDERS_KEY, {}));\n',
  '  const [folderParents, setFolderParents] = useState<Record<string, string>>(() => readJson<Record<string, string>>(FOLDER_PARENTS_KEY, {}));\n  const [renameFolderValue, setRenameFolderValue] = useState("");\n',
  'folder parents state'
);

addAfter(
  '  useEffect(() => { localStorage.setItem(FILE_FOLDERS_KEY, JSON.stringify(fileFolders)); }, [fileFolders]);\n',
  '  useEffect(() => { localStorage.setItem(FOLDER_PARENTS_KEY, JSON.stringify(folderParents)); }, [folderParents]);\n',
  'folder parents persistence'
);

// 4) Tree helpers replace flat folderList.
replaceOnce(
  '  const folderList = useMemo(() => [ALL_FILES, UNCATEGORIZED, ...folders], [folders]);\n',
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
    const names = [...folders];
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
  }, [folders, folderParents]);
  const folderList = useMemo(() => [ALL_FILES, UNCATEGORIZED, ...orderedFolders], [orderedFolders]);
`,
  'folder tree helpers'
);

// 5) Create inside active folder and add folder management actions.
replaceOnce(
  '  const createFolder = () => { const name = newFolder.trim(); if (!name || folderList.includes(name)) return; setFolders((x) => [...x, name]); setActiveFolder(name); setNewFolder(""); };\n',
  `  const createFolder = () => {
    const name = newFolder.trim();
    if (!name || folderList.includes(name)) return;
    const parent = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : "";
    setFolders((x) => [...x, name]);
    setFolderParents((x) => ({ ...x, [name]: parent }));
    setActiveFolder(name);
    setNewFolder("");
    toast.success(parent ? \`Folder created inside \${folderPath(parent)}\` : "Folder created");
  };
  const folderDescendants = (folder: string) => {
    const result = new Set<string>();
    const walk = (parent: string) => {
      for (const child of folders.filter((candidate) => (folderParents[candidate] || "") === parent)) {
        if (!result.has(child)) {
          result.add(child);
          walk(child);
        }
      }
    };
    walk(folder);
    return result;
  };
  const renameActiveFolder = () => {
    const name = renameFolderValue.trim();
    if (!name || activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) { toast.error("Open a custom folder first"); return; }
    if (folders.includes(name)) { toast.error("Folder already exists"); return; }
    const oldName = activeFolder;
    setFolders((x) => x.map((folder) => folder === oldName ? name : folder));
    setFolderParents((x) => Object.fromEntries(Object.entries(x).map(([folder, parent]) => [folder === oldName ? name : folder, parent === oldName ? name : parent])));
    setFileFolders((x) => Object.fromEntries(Object.entries(x).map(([hash, folder]) => [hash, folder === oldName ? name : folder])));
    setActiveFolder(name);
    setRenameFolderValue("");
    toast.success("Folder renamed");
  };
  const removeActiveFolder = () => {
    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) { toast.error("Open a custom folder first"); return; }
    const removed = new Set<string>([activeFolder, ...Array.from(folderDescendants(activeFolder))]);
    const parent = folderParents[activeFolder] || "";
    if (!confirm(\`Remove \${removed.size} folder(s)? Files inside move to Uncategorized, not deleted.\`)) return;
    setFolders((x) => x.filter((folder) => !removed.has(folder)));
    setFolderParents((x) => {
      const next: Record<string, string> = {};
      for (const [folder, folderParent] of Object.entries(x)) {
        if (!removed.has(folder)) next[folder] = removed.has(folderParent) ? parent : folderParent;
      }
      return next;
    });
    setFileFolders((x) => Object.fromEntries(Object.entries(x).map(([hash, folder]) => [hash, removed.has(folder) ? "" : folder])));
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
    setFolderParents((x) => ({ ...x, [activeFolder]: targetParent === UNCATEGORIZED ? "" : targetParent }));
    toast.success(targetParent && targetParent !== UNCATEGORIZED ? \`Moved folder inside \${folderPath(targetParent)}\` : "Moved folder to root");
  };
`,
  'folder actions'
);

// 6) Folder sidebar tree UI.
replaceOnce(
  '{folderList.map((folder) => <button key={folder} onClick={() => setActiveFolder(folder)} className={`block w-full rounded-xl px-4 py-3 text-left text-sm ${activeFolder === folder ? "bg-zinc-800" : "text-zinc-400 hover:bg-zinc-800/60"}`}><FolderOpen className="mr-2 inline size-4" />{folder}</button>)}',
  '{folderList.map((folder) => <button key={folder} onClick={() => setActiveFolder(folder)} style={{ paddingLeft: folder === ALL_FILES || folder === UNCATEGORIZED ? undefined : `${16 + folderDepth(folder) * 18}px` }} className={`block w-full rounded-xl px-4 py-3 text-left text-sm ${activeFolder === folder ? "bg-zinc-800" : "text-zinc-400 hover:bg-zinc-800/60"}`}><FolderOpen className="mr-2 inline size-4" />{folder === ALL_FILES || folder === UNCATEGORIZED ? folder : folderPath(folder)}</button>)}',
  'folder sidebar tree'
);

// 7) Active folder action bar above search.
replaceOnce(
  '<TabsContent value="files" className="space-y-4"><div className="relative"><Search',
  '<TabsContent value="files" className="space-y-4">{activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED && <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4"><div className="flex flex-col gap-2 sm:flex-row"><Input value={renameFolderValue} onChange={(e) => setRenameFolderValue(e.target.value)} placeholder={`Rename folder: ${folderPath(activeFolder)}`} /><Button variant="outline" onClick={renameActiveFolder}><Edit3 className="size-4" />Rename Folder</Button><Button variant="destructive" onClick={removeActiveFolder}><Trash2 className="size-4" />Remove Folder</Button><select value={folderParents[activeFolder] || UNCATEGORIZED} onChange={(e) => moveActiveFolderToParent(e.target.value)} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm"><option value={UNCATEGORIZED}>Move folder to root</option>{orderedFolders.filter((folder) => folder !== activeFolder).map((folder) => <option key={folder} value={folder}>{folderPath(folder)}</option>)}</select></div></div>}<div className="relative"><Search',
  'folder action panel'
);

// 8) Show folder paths in file cards and move dropdown.
src = src.replaceAll('{fileFolders[file.hash] || UNCATEGORIZED}</p>', '{fileFolders[file.hash] ? folderPath(fileFolders[file.hash]) : UNCATEGORIZED}</p>');
src = src.replaceAll('{folders.map((f) => <option key={f}>{f}</option>)}', '{orderedFolders.map((f) => <option key={f}>{folderPath(f)}</option>)}');

if (src !== before) {
  fs.writeFileSync(appPath, src, 'utf8');
  console.log('[patch-live-drive-ui] patched NativeP2PAppLive folders + Chunknet safety branding.');
} else {
  console.log('[patch-live-drive-ui] no changes needed.');
}
