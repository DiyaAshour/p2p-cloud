const fs = require('node:fs');

const file = 'client/src/NativeP2PAppLive.tsx';
if (!fs.existsSync(file)) {
  console.warn('[patch-live-folder-final-guard] NativeP2PAppLive not found');
  process.exit(0);
}

let s = fs.readFileSync(file, 'utf8');
let changed = false;

function markChange(next) {
  if (next !== s) { s = next; changed = true; }
}
function patch(regex, replacement, label) {
  if (regex.test(s)) {
    s = s.replace(regex, replacement);
    changed = true;
    return true;
  }
  if (label) console.warn('[patch-live-folder-final-guard] marker not found:', label);
  return false;
}
function insertBefore(regex, insertion, label) {
  if (s.includes(insertion.trim())) return true;
  if (regex.test(s)) {
    s = s.replace(regex, insertion + '$&');
    changed = true;
    return true;
  }
  if (label) console.warn('[patch-live-folder-final-guard] marker not found:', label);
  return false;
}

if (!s.includes('| "drive:saveFolders"')) {
  patch(/(  \| "wallet:disconnect"\r?\n)/, '$1  | "drive:getFolders"\n  | "drive:saveFolders"\n  | "p2p:updateFile"\n', 'channel union');
}

if (!s.includes('const [fileFolders, setFileFolders]')) {
  insertBefore(
    /  const \[activeWorkspaceId, setActiveWorkspaceId\][^\n]*\r?\n/,
    '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n',
    'inject missing fileFolders before activeWorkspaceId'
  );
}

if (!s.includes('const [folderParents, setFolderParents]')) {
  const insertedAfterFileFolders = patch(
    /(  const \[fileFolders, setFileFolders\][^\n]*\r?\n)/,
    '$1  const [folderParents, setFolderParents] = useState<Record<string, string>>({});\n',
    ''
  );
  if (!insertedAfterFileFolders) {
    insertBefore(
      /  const \[activeWorkspaceId, setActiveWorkspaceId\][^\n]*\r?\n/,
      '  const [folderParents, setFolderParents] = useState<Record<string, string>>({});\n',
      'inject folderParents before activeWorkspaceId'
    );
  }
}

if (!s.includes('const [folderCreateBusy, setFolderCreateBusy]')) {
  insertBefore(
    /  const \[activeWorkspaceId, setActiveWorkspaceId\][^\n]*\r?\n/,
    '  const [folderCreateBusy, setFolderCreateBusy] = useState(false);\n',
    'inject folderCreateBusy before activeWorkspaceId'
  );
}

if (!s.includes('const folderIdentityReady =')) {
  patch(
    /(  const walletConnected = Boolean\([\s\S]*?\);\r?\n)/,
    '$1  const folderIdentityReady = Boolean(wallet?.connected || wallet?.accountId || wallet?.address || wallet?.username || wallet?.seedFingerprint || wallet?.authMode === "seed");\n',
    'folderIdentityReady after walletConnected'
  );
}
markChange(s.replace(
  'const folderIdentityReady = Boolean(wallet?.connected || wallet?.accountId || wallet?.address || wallet?.username || wallet?.seedFingerprint);',
  'const folderIdentityReady = Boolean(wallet?.connected || wallet?.accountId || wallet?.address || wallet?.username || wallet?.seedFingerprint || wallet?.authMode === "seed");'
));
markChange(s.replace(/identityLabel !== "Guest" \|\| /g, ''));

if (!s.includes('final logged-out folder guard')) {
  patch(
    /(  const folders = useMemo\(\(\) => \{\r?\n)/,
    '$1    // final logged-out folder guard\n    if (!folderIdentityReady && view !== "company" && view !== "admin") return [ALL_FILES, UNCATEGORIZED];\n',
    'folders memo'
  );
}
markChange(s.replace('if (!walletConnected && view !== "company" && view !== "admin") return [ALL_FILES, UNCATEGORIZED];', 'if (!folderIdentityReady && view !== "company" && view !== "admin") return [ALL_FILES, UNCATEGORIZED];'));

if (!s.includes('final folder state clear guard')) {
  const addedAfterWorkspaceEffect = patch(
    /(  useEffect\(\(\) => \{\r?\n    localStorage\.setItem\(ACTIVE_WORKSPACE_KEY, JSON\.stringify\(activeWorkspace\?\.workspaceId \|\| ""\)\);\r?\n  \}, \[activeWorkspace\?\.workspaceId\]\);\r?\n)/,
    '$1\n  // final folder state clear guard\n  useEffect(() => {\n    if (!folderIdentityReady) {\n      setFileFolders({});\n      setFolderParents({});\n      setActiveFolder(ALL_FILES);\n    }\n  }, [folderIdentityReady]);\n',
    ''
  );
  if (!addedAfterWorkspaceEffect) {
    insertBefore(
      /  const run = async \(work: \(\) => Promise<void>\) => \{\r?\n/,
      '  // final folder state clear guard\n  useEffect(() => {\n    if (!folderIdentityReady) {\n      setFileFolders({});\n      setFolderParents({});\n      setActiveFolder(ALL_FILES);\n    }\n  }, [folderIdentityReady]);\n\n',
      'insert guard before run'
    );
  }
}
markChange(s.replace(/if \(!walletConnected\) \{\n      setFileFolders\(\{\}\);\n      setFolderParents\(\{\}\);\n      setActiveFolder\(ALL_FILES\);\n    \}\n  \}, \[walletConnected\]\);/g, 'if (!folderIdentityReady) {\n      setFileFolders({});\n      setFolderParents({});\n      setActiveFolder(ALL_FILES);\n    }\n  }, [folderIdentityReady]);'));

patch(
  /  const createFolder = \(\) => \{[\s\S]*?\n  const upload =/,
  `  const createFolder = () => {
    // final network createFolder v7
    const folder = newFolder.trim();
    console.log('[folders] create clicked', { folder, view, folderIdentityReady, folderCreateBusy });
    if (folderCreateBusy) return;
    if (!folder || folder === ALL_FILES || folder === UNCATEGORIZED) {
      toast.error('Folder name is required');
      return;
    }
    const existingNames = new Set([...Object.values(fileFolders), ...Object.keys(folderParents)].map((value) => String(value || '').toLowerCase()));
    if (existingNames.has(folder.toLowerCase())) {
      toast.error('Folder already exists');
      return;
    }
    setFolderCreateBusy(true);
    const key = (view === "company" || view === "admin") && activeWorkspace ? ("company:" + activeWorkspace.workspaceId + ":folder:" + folder) : ("personal:folder:" + folder);
    const parent = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : "";
    const nextFolders = { ...fileFolders, [key]: folder };
    const nextParents = { ...folderParents, [folder]: parent };
    setFileFolders(nextFolders);
    setFolderParents(nextParents);
    setActiveFolder(folder);
    setNewFolder("");
    if (view === "personal") {
      const names = new Set<string>();
      for (const value of Object.values(nextFolders)) if (value && value !== ALL_FILES && value !== UNCATEGORIZED) names.add(String(value));
      for (const value of Object.keys(nextParents)) if (value && value !== ALL_FILES && value !== UNCATEGORIZED) names.add(String(value));
      const foldersPayload = Array.from(names).map((name) => ({ id: name, name, parentId: nextParents[name] || null, updatedAt: new Date().toISOString() }));
      if (api && folderIdentityReady) {
        void api.invoke("drive:saveFolders" as Channel, { folders: foldersPayload, fileFolders: nextFolders })
          .then(() => { toast.success("Folder created: " + folder); return refresh(); })
          .catch((error) => {
            setFileFolders(fileFolders);
            setFolderParents(folderParents);
            setActiveFolder(ALL_FILES);
            toast.error(err(error));
          })
          .finally(() => setFolderCreateBusy(false));
        return;
      }
    }
    toast.success("Folder created: " + folder);
    setFolderCreateBusy(false);
  };
  const upload =`,
  'createFolder final replace'
);

const nativeFolderBlock = `          <div className="flex gap-2">
            <Input value={newFolder} onChange={(event) => setNewFolder(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); createFolder(); } }} placeholder="New folder" disabled={folderCreateBusy} />
            <button type="button" disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }} className="inline-flex h-10 min-w-12 items-center justify-center rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">+</button>
          </div>`;

markChange(s.replace(
  '          <div className="flex gap-2"><Input value={newFolder} onChange={(event) => setNewFolder(event.target.value)} placeholder="New folder" /><Button onClick={createFolder}>+</Button></div>',
  nativeFolderBlock
));

if (!s.includes('disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }}')) {
  const before = s;
  s = s.replace(
    /          <div className="flex gap-2">\r?\n\s*<Input[\s\S]*?placeholder="New folder"[\s\S]*?\/?>\r?\n\s*(?:<Button[\s\S]*?>\+<\/Button>|<button[\s\S]*?>\+<\/button>)\r?\n\s*<\/div>/,
    nativeFolderBlock
  );
  if (s !== before) changed = true;
}

markChange(s.replace(/<button type="button" onMouseDown=\{\(event\) => \{ event\.preventDefault\(\); createFolder\(\); \}\} onClick=\{\(event\) => \{ event\.preventDefault\(\); createFolder\(\); \}\} className="inline-flex h-10 min-w-12 items-center justify-center rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-500">\+<\/button>/g, '<button type="button" disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }} className="inline-flex h-10 min-w-12 items-center justify-center rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">+</button>'));
markChange(s.replace(/<Button([^>]*?)onClick=\{createFolder\}([^>]*?)disabled=\{busy\}([^>]*?)>\+<\/Button>/g, '<Button$1disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }}$2$3>+</Button>'));
markChange(s.replace(/<Button([^>]*?)disabled=\{busy\}([^>]*?)onClick=\{createFolder\}([^>]*?)>\+<\/Button>/g, '<Button$1$2disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }}$3>+</Button>'));
markChange(s.replace(/<Button onClick=\{createFolder\} disabled=\{busy\}>\+<\/Button>/g, '<Button disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }}>+</Button>'));
markChange(s.replace(/<Button onClick=\{createFolder\}>\+<\/Button>/g, '<Button disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }}>+</Button>'));

markChange(s.replace(/\}, \[walletConnected, folderStorageKey\]\);/g, '}, [folderIdentityReady]);'));
markChange(s.replace(/\}, \[walletConnected\]\);/g, '}, [folderIdentityReady]);'));

if (!s.includes('const [fileFolders, setFileFolders]')) {
  console.error('[patch-live-folder-final-guard] failed to inject fileFolders state');
  process.exit(1);
}
if (!s.includes('const [folderParents, setFolderParents]')) {
  console.error('[patch-live-folder-final-guard] failed to inject folderParents state');
  process.exit(1);
}
if (!s.includes('const [folderCreateBusy, setFolderCreateBusy]')) {
  console.error('[patch-live-folder-final-guard] failed to inject folderCreateBusy state');
  process.exit(1);
}
if (!s.includes('const folderIdentityReady =')) {
  console.error('[patch-live-folder-final-guard] failed to inject folderIdentityReady');
  process.exit(1);
}
if (!s.includes('final network createFolder v7')) {
  console.error('[patch-live-folder-final-guard] failed to patch createFolder');
  process.exit(1);
}
if (s.includes('onMouseDown={(event) => { event.preventDefault(); createFolder(); }}')) {
  console.error('[patch-live-folder-final-guard] duplicate onMouseDown create handler remains');
  process.exit(1);
}
if (s.includes('personalFolderKey(') || s.includes('companyFolderKey(') || s.includes('identityLabel !== "Guest"')) {
  console.error('[patch-live-folder-final-guard] unsafe helper or identityLabel dependency remains');
  process.exit(1);
}

fs.writeFileSync(file, s, 'utf8');
console.log(changed ? '[patch-live-folder-final-guard] installed final folder guard and single-click createFolder v7' : '[patch-live-folder-final-guard] already applied');
