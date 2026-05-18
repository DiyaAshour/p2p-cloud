const fs = require('node:fs');

const file = 'client/src/NativeP2PAppLive.tsx';
if (!fs.existsSync(file)) {
  console.warn('[patch-live-folder-final-guard] NativeP2PAppLive not found');
  process.exit(0);
}

let s = fs.readFileSync(file, 'utf8');
const before = s;

function softReplace(regex, replacement, label) {
  const next = s.replace(regex, replacement);
  if (next === s && label) console.warn('[patch-live-folder-final-guard] marker not found:', label);
  s = next;
}

function insertBefore(regex, insertion, label) {
  if (s.includes(insertion.trim())) return;
  if (!regex.test(s)) {
    console.warn('[patch-live-folder-final-guard] marker not found:', label);
    return;
  }
  s = s.replace(regex, insertion + '$&');
}

// Last UI guard. Do not let folder creation depend on drive:* IPC.
s = s.replace(/  \| "drive:getFolders"\r?\n/g, '');
s = s.replace(/  \| "drive:saveFolders"\r?\n/g, '');
s = s.replace(/api\.invoke\("drive:saveFolders"\s+as\s+Channel,\s*\{\s*folders:\s*foldersPayload,\s*fileFolders:\s*nextFolders\s*\}\)/g, 'Promise.resolve({ ok: true })');
s = s.replace(/api\.invoke\("drive:saveFolders",\s*\{\s*folders:\s*foldersPayload,\s*fileFolders:\s*nextFolders\s*\}\)/g, 'Promise.resolve({ ok: true })');

if (!s.includes('  | "p2p:updateFile"')) {
  s = s.replace('  | "p2p:downloadToPath"\n', '  | "p2p:downloadToPath"\n  | "p2p:updateFile"\n');
}

if (!s.includes('const [fileFolders, setFileFolders]')) insertBefore(/  const \[activeWorkspaceId, setActiveWorkspaceId\][^\n]*\r?\n/, '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n', 'fileFolders state');
if (!s.includes('const [folderParents, setFolderParents]')) insertBefore(/  const \[activeWorkspaceId, setActiveWorkspaceId\][^\n]*\r?\n/, '  const [folderParents, setFolderParents] = useState<Record<string, string>>({});\n', 'folderParents state');
if (!s.includes('const [folderCreateBusy, setFolderCreateBusy]')) insertBefore(/  const \[activeWorkspaceId, setActiveWorkspaceId\][^\n]*\r?\n/, '  const [folderCreateBusy, setFolderCreateBusy] = useState(false);\n', 'folderCreateBusy state');

s = s.replace(/const folderIdentityReady = Boolean\([^\n]*\);/g, 'const folderIdentityReady = Boolean(wallet?.connected || wallet?.accountId || wallet?.address || wallet?.username || wallet?.seedFingerprint || wallet?.authMode === "seed");');
if (!s.includes('const folderIdentityReady =')) {
  softReplace(/(  const walletConnected = Boolean\([\s\S]*?\);\r?\n)/, '$1  const folderIdentityReady = Boolean(wallet?.connected || wallet?.accountId || wallet?.address || wallet?.username || wallet?.seedFingerprint || wallet?.authMode === "seed");\n', 'folderIdentityReady');
}

if (!s.includes('folderName?: string')) {
  s = s.replace('ownerWallet?: string; replicas?: string[];', 'ownerWallet?: string; folder?: string; folderName?: string; folderId?: string; replicas?: string[];');
}

softReplace(
  /  const folders = useMemo\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*fileFolders[^\]]*\]\);/,
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
  }, [fileFolders, activeWorkspace, personalFiles, view, folderIdentityReady]);`,
  'folders memo'
);

// Best-effort display repair. Different restored UI variants use different folder expressions.
s = s.replace(/const folder = cf\?\.folder \|\| fileFolders\[file\.hash\] \|\| UNCATEGORIZED;/g, 'const folder = cf?.folder || file.folder || file.folderName || fileFolders[file.hash] || fileFolders[file.rootHash] || UNCATEGORIZED;');
s = s.replace(/const folder = cf\?\.folder \|\| fileFolders\[file\.rootHash\] \|\| fileFolders\[file\.hash\] \|\| UNCATEGORIZED;/g, 'const folder = cf?.folder || file.folder || file.folderName || fileFolders[file.hash] || fileFolders[file.rootHash] || UNCATEGORIZED;');

softReplace(
  /  const createFolder = \(\) => \{[\s\S]*?\n  const upload =/,
  `  const createFolder = () => {
    // final local createFolder v10 — no drive:saveFolders IPC
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
    const parent = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : "";
    setFileFolders((current) => ({ ...current, [key]: folder }));
    setFolderParents((current) => ({ ...current, [folder]: parent }));
    setActiveFolder(folder);
    setNewFolder("");
    toast.success("Folder created: " + folder);
    setTimeout(() => setFolderCreateBusy(false), 0);
  };
  const upload =`,
  'createFolder v10'
);

s = s.replace(/for \(const file of result\.files \|\| \[\]\) next\[file\.hash\] = activeFolder;/g, 'for (const file of result.files || []) { next[file.hash] = activeFolder; if (file.rootHash) next[file.rootHash] = activeFolder; }');
s = s.replace(/else setFileFolders\(\(current\) => \(\{ \.\.\.current, \[file\.hash\]: nextFolder \}\)\);/g, `else {
                setFileFolders((current) => ({ ...current, [file.hash]: nextFolder, ...(file.rootHash ? { [file.rootHash]: nextFolder } : {}) }));
                void api.invoke("p2p:updateFile", { hash: file.hash, rootHash: file.rootHash, patch: { folder: nextFolder } })
                  .then(refresh)
                  .catch((error) => toast.error(err(error)));
              }`);

const nativeFolderBlock = `          <div className="flex gap-2">
            <Input value={newFolder} onChange={(event) => setNewFolder(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); createFolder(); } }} placeholder="New folder" disabled={folderCreateBusy} />
            <button type="button" disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }} className="inline-flex h-10 min-w-12 items-center justify-center rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">+</button>
          </div>`;

s = s.replace('          <div className="flex gap-2"><Input value={newFolder} onChange={(event) => setNewFolder(event.target.value)} placeholder="New folder" /><Button onClick={createFolder}>+</Button></div>', nativeFolderBlock);
if (!s.includes('disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }}')) {
  s = s.replace(/          <div className="flex gap-2">\r?\n\s*<Input[\s\S]*?placeholder="New folder"[\s\S]*?\/?>\r?\n\s*(?:<Button[\s\S]*?>\+<\/Button>|<button[\s\S]*?>\+<\/button>)\r?\n\s*<\/div>/, nativeFolderBlock);
}

s = s.replace(/onMouseDown=\{\(event\) => \{ event\.preventDefault\(\); createFolder\(\); \}\}\s*/g, '');
s = s.replace(/<Button onClick=\{createFolder\}>\+<\/Button>/g, '<Button disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }}>+</Button>');
s = s.replace(/<Button onClick=\{createFolder\} disabled=\{busy\}>\+<\/Button>/g, '<Button disabled={folderCreateBusy} onClick={(event) => { event.preventDefault(); createFolder(); }}>+</Button>');

if (!s.includes('final local createFolder v10')) {
  console.error('[patch-live-folder-final-guard] failed to patch createFolder v10');
  process.exit(1);
}
if (s.includes('api.invoke("drive:saveFolders"')) {
  console.warn('[patch-live-folder-final-guard] legacy drive:saveFolders reference remains outside createFolder; continuing because folder create is local v10');
}
if (s.includes('onMouseDown={(event) => { event.preventDefault(); createFolder(); }}')) {
  console.error('[patch-live-folder-final-guard] duplicate onMouseDown create handler remains');
  process.exit(1);
}
if (!s.includes('p2p:updateFile')) {
  console.error('[patch-live-folder-final-guard] p2p:updateFile channel missing');
  process.exit(1);
}

if (s !== before) fs.writeFileSync(file, s, 'utf8');
console.log(s !== before ? '[patch-live-folder-final-guard] installed final local createFolder v10 without drive IPC' : '[patch-live-folder-final-guard] already applied local createFolder v10');