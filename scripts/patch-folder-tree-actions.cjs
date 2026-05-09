const fs = require('node:fs');
const path = require('node:path');

const appPath = path.join(process.cwd(), 'client', 'src', 'NativeP2PApp.tsx');
let src = fs.readFileSync(appPath, 'utf8');
const before = src;

function addAfter(marker, text) {
  if (src.includes(text.trim().slice(0, 80))) return;
  if (!src.includes(marker)) {
    console.warn('[patch-folder-tree-actions] marker not found:', marker.slice(0, 80));
    return;
  }
  src = src.replace(marker, marker + text);
}

function replaceRegex(regex, replacement, label) {
  if (!regex.test(src)) {
    console.warn('[patch-folder-tree-actions] regex not found:', label);
    return;
  }
  src = src.replace(regex, replacement);
}

// Ensure folder parent metadata exists even when an older local file missed the previous patch.
addAfter('const FILE_NAMES_KEY = "peercloud.ui.fileNames";\n', 'const FOLDER_PARENTS_KEY = "peercloud.ui.folderParents";\n');
addAfter(
  '  const [fileNames, setFileNames] = useState<Record<string, string>>(() => safeJson<Record<string, string>>(FILE_NAMES_KEY, {}));\n',
  '  const [folderParents, setFolderParents] = useState<Record<string, string>>(() => safeJson<Record<string, string>>(FOLDER_PARENTS_KEY, {}));\n'
);
addAfter(
  '  useEffect(() => { localStorage.setItem(FILE_NAMES_KEY, JSON.stringify(fileNames)); }, [fileNames]);\n',
  '  useEffect(() => { localStorage.setItem(FOLDER_PARENTS_KEY, JSON.stringify(folderParents)); }, [folderParents]);\n'
);

// Ensure tree helpers exist. If flat allFolders still exists, replace it.
replaceRegex(
  /  const allFolders = useMemo\(\(\) => \[ALL_FILES, UNCATEGORIZED, \.\.\.folderNames\], \[folderNames\]\);\n/,
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
  'flat allFolders'
);

// Force createFolder to create inside the currently open custom folder.
replaceRegex(
  /  const createFolder = \(\) => \{ const name = newFolderName\.trim\(\);[\s\S]*?toast\.success\([^;]*?Folder created[\s\S]*?\); \};\n/,
  '  const createFolder = () => { const name = newFolderName.trim(); if (!name || name === ALL_FILES || name === UNCATEGORIZED) return; if (folderNames.includes(name)) { toast.error("Folder already exists"); return; } const parent = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : ""; setFolderNames((current) => [...current, name]); setFolderParents((current) => ({ ...current, [name]: parent })); setActiveFolder(name); setNewFolderName(""); toast.success(parent ? `Folder created inside ${folderPath(parent)}: ${name}` : `Folder created: ${name}`); };\n',
  'createFolder function'
);

// Insert folder tree actions before the selected file actions.
if (!src.includes('const removeActiveFolder = () =>')) {
  const marker = '  const deleteSelectedFiles = () => runBusy(async () => {';
  const actions = `  const folderDescendants = (folder: string) => {
    const result = new Set<string>();
    const walk = (parent: string) => {
      for (const child of folderNames.filter((candidate) => (folderParents[candidate] || "") === parent)) {
        if (!result.has(child)) {
          result.add(child);
          walk(child);
        }
      }
    };
    walk(folder);
    return result;
  };
  const removeActiveFolder = () => {
    if (activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED) { toast.error("Open a custom folder first"); return; }
    const removed = new Set<string>([activeFolder, ...Array.from(folderDescendants(activeFolder))]);
    const parent = folderParents[activeFolder] || "";
    const count = removed.size;
    if (!confirm(\`Remove \${count} folder(s)? Files inside will move to Uncategorized, not be deleted.\`)) return;
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
    toast.success(\`Removed \${count} folder(s)\`);
  };
`;
  if (src.includes(marker)) src = src.replace(marker, actions + marker);
  else console.warn('[patch-folder-tree-actions] could not add removeActiveFolder');
}

// Make sidebar render a visible tree. Handles both old and partially patched nav blocks.
replaceRegex(
  /<nav className="grid gap-2 text-sm">\{allFolders\.map\(\(folder\) => <button[\s\S]*?\}\)<\/nav>/,
  '<nav className="grid gap-2 text-sm">{allFolders.map((folder) => <button key={folder} onClick={() => setActiveFolder(folder)} style={{ paddingLeft: folder === ALL_FILES || folder === UNCATEGORIZED ? undefined : `${16 + folderDepth(folder) * 18}px` }} className={`rounded-xl px-4 py-3 text-left transition duration-200 ${activeFolder === folder ? "bg-zinc-800 font-medium text-zinc-50" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"}`}><FolderOpen className="mr-2 inline size-4" />{folder === ALL_FILES || folder === UNCATEGORIZED ? folder : folderPath(folder)}</button>)}</nav>',
  'folder sidebar nav'
);

// Improve move dropdown labels to show nested paths.
src = src.replaceAll(
  'folderNames.map((folder) => <option key={folder} value={folder}>{folder}</option>)',
  'orderedFolders.map((folder) => <option key={folder} value={folder}>{folderPath(folder)}</option>)'
);
src = src.replaceAll(
  '{folderNames.map((folder) => <option key={folder} value={folder}>{folder}</option>)}',
  '{orderedFolders.map((folder) => <option key={folder} value={folder}>{folderPath(folder)}</option>)}'
);

// Add active folder remove button beside Rename Folder if not present.
if (!src.includes('Remove Folder</Button>')) {
  src = src.replace(
    '<Button variant="outline" onClick={renameActiveFolder}><Edit3 className="size-4" />Rename Folder</Button>',
    '<Button variant="outline" onClick={renameActiveFolder}><Edit3 className="size-4" />Rename Folder</Button><Button variant="destructive" onClick={removeActiveFolder}><Trash2 className="size-4" />Remove Folder</Button>'
  );
}

if (src !== before) {
  fs.writeFileSync(appPath, src, 'utf8');
  console.log('[patch-folder-tree-actions] fixed nested folder creation and added folder removal.');
} else {
  console.log('[patch-folder-tree-actions] no changes needed.');
}
