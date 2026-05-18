const fs = require('node:fs');
const path = require('node:path');

const liveFile = 'client/src/NativeP2PAppLive.tsx';
const preloadFile = path.join('electron', 'preload.cjs');

if (!fs.existsSync(liveFile)) {
  console.warn('[patch-live-folder-no-helper] NativeP2PAppLive not found');
  process.exit(0);
}

let s = fs.readFileSync(liveFile, 'utf8');
const before = s;

function changed(next) {
  if (next !== s) s = next;
}

function insertAfter(anchor, line, label) {
  if (s.includes(line.trim())) return;
  if (!s.includes(anchor)) {
    console.warn('[patch-live-folder-no-helper] marker not found:', label);
    return;
  }
  s = s.replace(anchor, anchor + line);
}

// Keep folder code independent from helpers that are removed/reordered by other patches.
s = s.replace(
  /const key = \(view === "company" \|\| view === "admin"\) && activeWorkspace \? companyFolderKey\(activeWorkspace\.workspaceId, folder\) : personalFolderKey\(folder\);/g,
  'const key = (view === "company" || view === "admin") && activeWorkspace ? ("company:" + activeWorkspace.workspaceId + ":folder:" + folder) : ("personal:folder:" + folder);'
);

// Do not depend on identityLabel here. In some restored UI variants folderIdentityReady
// is injected before identityLabel, which causes a temporal-dead-zone crash.
s = s.replace(
  /const folderIdentityReady = Boolean\([^\n]*\);/g,
  'const folderIdentityReady = Boolean(wallet?.connected || wallet?.accountId || wallet?.address || wallet?.username || wallet?.seedFingerprint || wallet?.authMode === "seed");'
);

if (!s.includes('const folderIdentityReady =')) {
  s = s.replace(
    /(  const walletConnected = Boolean\([^\n]+\);\r?\n)/,
    '$1  const folderIdentityReady = Boolean(wallet?.connected || wallet?.accountId || wallet?.address || wallet?.username || wallet?.seedFingerprint || wallet?.authMode === "seed");\n'
  );
}

if (!s.includes('const [folderCreateBusy, setFolderCreateBusy]')) {
  s = s.replace(
    /(  const \[newFolder, setNewFolder\] = useState\(""\);\r?\n)/,
    '$1  const [folderCreateBusy, setFolderCreateBusy] = useState(false);\n'
  );
}

if (!s.includes('  | "p2p:updateFile"')) {
  s = s.replace('  | "p2p:downloadToPath"\n', '  | "p2p:downloadToPath"\n  | "p2p:updateFile"\n');
}

if (!s.includes('folderName?: string')) {
  s = s.replace(
    'ownerWallet?: string; replicas?: string[];',
    'ownerWallet?: string; folder?: string; folderName?: string; folderId?: string; replicas?: string[];'
  );
}

// The real bug: personal folders were only localStorage-only and ignored manifest.folder after refresh.
s = s.replace(
  /  const folders = useMemo\(\(\) => \{[\s\S]*?\n  \}, \[fileFolders, activeWorkspace, personalFiles, view(?:, folderIdentityReady)?\]\);/,
  `  const folders = useMemo(() => {
    if (!folderIdentityReady && view !== "company" && view !== "admin") return [ALL_FILES, UNCATEGORIZED];
    const names = new Set<string>();
    const add = (value?: string | null) => {
      const clean = String(value || "").trim();
      if (clean && clean !== ALL_FILES && clean !== UNCATEGORIZED) names.add(clean);
    };
    if (view === "company" || view === "admin") {
      const companyPrefix = activeWorkspace ? "company:" + activeWorkspace.workspaceId + ":folder:" : "company:none:folder:";
      for (const file of activeWorkspace?.files || []) add(file.folder);
      for (const [key, folder] of Object.entries(fileFolders)) if (key.startsWith(companyPrefix)) add(folder);
    } else {
      const personalFileKeys = new Set(personalFiles.flatMap((file) => [file.hash, file.rootHash].filter(Boolean)));
      for (const file of personalFiles) add(file.folder || file.folderName);
      for (const [key, folder] of Object.entries(fileFolders)) {
        if (key.startsWith("personal:folder:") || personalFileKeys.has(key)) add(folder);
      }
    }
    return [ALL_FILES, UNCATEGORIZED, ...Array.from(names).sort((a, b) => a.localeCompare(b))];
  }, [fileFolders, activeWorkspace, personalFiles, view, folderIdentityReady]);`
);

s = s.replace(
  /const folder = cf\?\.folder \|\| fileFolders\[file\.hash\] \|\| UNCATEGORIZED;/g,
  'const folder = cf?.folder || file.folder || file.folderName || fileFolders[file.hash] || fileFolders[file.rootHash] || UNCATEGORIZED;'
);

s = s.replace(
  /  const createFolder = \(\) => \{[\s\S]*?\n  const upload =/,
  `  const createFolder = () => {
    const folder = newFolder.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ");
    console.log('[folders] create clicked', { folder, view, folderIdentityReady, folderCreateBusy });
    if (folderCreateBusy) return;
    if (!folder || folder === ALL_FILES || folder === UNCATEGORIZED) {
      toast.error('Folder name is required');
      return;
    }
    if (!folderIdentityReady && view !== "company" && view !== "admin") {
      toast.error('Sign in first, then create folders');
      return;
    }
    const existingNames = new Set(folders.map((value) => String(value || '').toLowerCase()));
    if (existingNames.has(folder.toLowerCase())) {
      toast.error('Folder already exists');
      return;
    }
    setFolderCreateBusy(true);
    const key = (view === "company" || view === "admin") && activeWorkspace ? ("company:" + activeWorkspace.workspaceId + ":folder:" + folder) : ("personal:folder:" + folder);
    setFileFolders((current) => ({ ...current, [key]: folder }));
    setActiveFolder(folder);
    setNewFolder("");
    toast.success("Folder created: " + folder);
    setTimeout(() => setFolderCreateBusy(false), 0);
  };
  const upload =`
);

s = s.replace(
  /for \(const file of result\.files \|\| \[\]\) next\[file\.hash\] = activeFolder;/,
  'for (const file of result.files || []) { next[file.hash] = activeFolder; if (file.rootHash) next[file.rootHash] = activeFolder; }'
);

s = s.replace(
  /else setFileFolders\(\(current\) => \(\{ \.\.\.current, \[file\.hash\]: nextFolder \}\)\);/,
  `else {
                setFileFolders((current) => ({ ...current, [file.hash]: nextFolder, ...(file.rootHash ? { [file.rootHash]: nextFolder } : {}) }));
                void api.invoke("p2p:updateFile", { hash: file.hash, rootHash: file.rootHash, patch: { folder: nextFolder } })
                  .then(refresh)
                  .catch((error) => toast.error(err(error)));
              }`
);

const nativeFolderBlock = `          <div className="flex gap-2">
            <Input value={newFolder} onChange={(event) => setNewFolder(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); createFolder(); } }} placeholder="New folder" disabled={folderCreateBusy} />
            <button type="button" disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }} className="inline-flex h-10 min-w-12 items-center justify-center rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">+</button>
          </div>`;

s = s.replace(
  '          <div className="flex gap-2"><Input value={newFolder} onChange={(event) => setNewFolder(event.target.value)} placeholder="New folder" /><Button onClick={createFolder}>+</Button></div>',
  nativeFolderBlock
);

if (!s.includes('disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }}')) {
  s = s.replace(
    /          <div className="flex gap-2">\r?\n\s*<Input[\s\S]*?placeholder="New folder"[\s\S]*?\/?>\r?\n\s*(?:<Button[\s\S]*?>\+<\/Button>|<button[\s\S]*?>\+<\/button>)\r?\n\s*<\/div>/,
    nativeFolderBlock
  );
}

s = s.replace(/<button type="button" onMouseDown=\{\(event\) => \{ event\.preventDefault\(\); createFolder\(\); \}\} onClick=\{\(event\) => \{ event\.preventDefault\(\); createFolder\(\); \}\} className="inline-flex h-10 min-w-12 items-center justify-center rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-500">\+<\/button>/g, '<button type="button" disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }} className="inline-flex h-10 min-w-12 items-center justify-center rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">+</button>');
s = s.replace(/<Button([^>]*?)onClick=\{createFolder\}([^>]*?)disabled=\{busy\}([^>]*?)>\+<\/Button>/g, '<Button$1disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }}$2$3>+</Button>');
s = s.replace(/<Button([^>]*?)disabled=\{busy\}([^>]*?)onClick=\{createFolder\}([^>]*?)>\+<\/Button>/g, '<Button$1$2disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }}$3>+</Button>');
s = s.replace(/<Button onClick=\{createFolder\} disabled=\{busy\}>\+<\/Button>/g, '<Button disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }}>+</Button>');
s = s.replace(/<Button onClick=\{createFolder\}>\+<\/Button>/g, '<Button disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }}>+</Button>');

if (s.includes('personalFolderKey(folder)') || s.includes('companyFolderKey(activeWorkspace.workspaceId, folder)')) {
  console.error('[patch-live-folder-no-helper] helper calls still exist');
  process.exit(1);
}
if (s.includes('identityLabel !== "Guest"')) {
  console.error('[patch-live-folder-no-helper] identityLabel dependency still exists');
  process.exit(1);
}
if (!s.includes('wallet?.seedFingerprint || wallet?.authMode === "seed"')) {
  console.error('[patch-live-folder-no-helper] folderIdentityReady repair failed');
  process.exit(1);
}
if (!s.includes('const folder = cf?.folder || file.folder || file.folderName')) {
  console.error('[patch-live-folder-no-helper] manifest folder display repair failed');
  process.exit(1);
}
if (!s.includes('p2p:updateFile')) {
  console.error('[patch-live-folder-no-helper] p2p:updateFile channel missing');
  process.exit(1);
}

if (s !== before) fs.writeFileSync(liveFile, s, 'utf8');

let preloadChanged = false;
if (fs.existsSync(preloadFile)) {
  let preload = fs.readFileSync(preloadFile, 'utf8');
  const preloadBefore = preload;
  for (const channel of ['drive:getFolders', 'drive:saveFolders', 'p2p:updateFile']) {
    if (!preload.includes("'" + channel + "'")) {
      preload = preload.replace("  'p2p:listFiles',\n", "  'p2p:listFiles',\n  '" + channel + "',\n");
    }
  }
  preload = preload.replace(
    "channel.startsWith('company:')",
    "channel.startsWith('company:') || channel.startsWith('drive:')"
  );
  if (preload !== preloadBefore) {
    fs.writeFileSync(preloadFile, preload, 'utf8');
    preloadChanged = true;
  }
}

if (s !== before || preloadChanged) {
  console.log('[patch-live-folder-no-helper] fixed live folders: single-click create, manifest folder display, and personal file move');
} else {
  console.log('[patch-live-folder-no-helper] already safe');
}