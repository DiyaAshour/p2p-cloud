const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const livePath = path.join(root, 'client', 'src', 'NativeP2PAppLive.tsx');

function read(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
function write(file, value) { fs.writeFileSync(file, value, 'utf8'); }

function ensureDriveFolderTypes(src) {
  src = src.replace('type Bridge = { invoke: <T>(channel: Channel, payload?: unknown) => Promise<T> };', 'type Bridge = { invoke: <T>(channel: string, payload?: unknown) => Promise<T> };');
  if (!src.includes('type DriveFolder =')) {
    src = src.replace(
      'type View = "personal" | "company" | "shared" | "admin";',
      'type DriveFolder = { id?: string; name: string; folderId?: string; parentFolderId?: string | null; hash?: string; rootHash?: string; kind?: string; isFolder?: boolean; ownerWallet?: string };\ntype View = "personal" | "company" | "shared" | "admin";'
    );
  }
  if (!src.includes('folderId?: string; ownerWallet?: string')) {
    src = src.replace(
      'type P2PFile = { id?: string; name: string; size: number; hash: string; rootHash: string; uploadedAt: string; isEncrypted: boolean; totalChunks: number; ownerWallet?: string;',
      'type P2PFile = { id?: string; name: string; size: number; hash: string; rootHash: string; uploadedAt: string; isEncrypted: boolean; totalChunks: number; folder?: string; folderName?: string; folderId?: string; ownerWallet?: string;'
    );
  }
  for (const channel of ['p2p:updateFile', 'p2p:listFolders', 'p2p:createFolder', 'p2p:renameItem', 'p2p:moveItem', 'p2p:deleteItem']) {
    const line = `  | "${channel}"\n`;
    if (!src.includes(line) && src.includes('  | "p2p:prepareProof"\n')) {
      src = src.replace('  | "p2p:prepareProof"\n', '  | "p2p:prepareProof"\n' + line);
    }
  }
  return src;
}

function ensureFolderState(src) {
  if (!src.includes('const [driveFolders, setDriveFolders]')) {
    const stateLine = '  const [driveFolders, setDriveFolders] = useState<DriveFolder[]>([]);\n';
    const anchor = /  const \[fileFolders, setFileFolders\][^\n]*\r?\n/;
    if (anchor.test(src)) src = src.replace(anchor, (m) => m + stateLine);
    else src = src.replace('  const [activeWorkspaceId, setActiveWorkspaceId]', stateLine + '  const [activeWorkspaceId, setActiveWorkspaceId]');
  }
  if (!src.includes('const [activeFolderId, setActiveFolderId]')) {
    const line = '  const [activeFolderId, setActiveFolderId] = useState("");\n';
    const anchor = /  const \[activeFolder, setActiveFolder\][^\n]*\r?\n/;
    if (anchor.test(src)) src = src.replace(anchor, (m) => m + line);
  }
  return src;
}

const folderModelBlock = `  const folderById = (folderId?: string | null) => driveFolders.find((folder) => String(folder.folderId || folder.id || '') === String(folderId || '')) || null;
  const folderByName = (folderName: string) => driveFolders.find((folder) => folder.name === folderName) || null;
  const folderPath = (folderOrName: DriveFolder | string | null | undefined) => {
    const start = typeof folderOrName === "string" ? folderByName(folderOrName) : folderOrName;
    if (!start) return typeof folderOrName === "string" ? folderOrName : "";
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor: DriveFolder | null = start;
    while (cursor && !seen.has(String(cursor.folderId || cursor.id || cursor.name))) {
      seen.add(String(cursor.folderId || cursor.id || cursor.name));
      chain.unshift(cursor.name);
      cursor = cursor.parentFolderId ? folderById(cursor.parentFolderId) : null;
    }
    return chain.join(" / ");
  };
  const folderDepth = (folderName: string) => {
    let depth = 0;
    const seen = new Set<string>();
    let cursor = folderByName(folderName);
    while (cursor?.parentFolderId && !seen.has(cursor.parentFolderId)) {
      seen.add(cursor.parentFolderId);
      depth += 1;
      cursor = folderById(cursor.parentFolderId);
    }
    return depth;
  };
  const orderedDriveFolders = useMemo(() => {
    const byParent = new Map<string, DriveFolder[]>();
    for (const folder of driveFolders) {
      const parent = String(folder.parentFolderId || "");
      byParent.set(parent, [...(byParent.get(parent) || []), folder]);
    }
    for (const list of byParent.values()) list.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    const result: DriveFolder[] = [];
    const seen = new Set<string>();
    const walk = (parentId: string) => {
      for (const folder of byParent.get(parentId) || []) {
        const id = String(folder.folderId || folder.id || folder.name);
        if (seen.has(id)) continue;
        seen.add(id);
        result.push(folder);
        walk(String(folder.folderId || folder.id || ""));
      }
    };
    walk("");
    for (const folder of driveFolders) {
      const id = String(folder.folderId || folder.id || folder.name);
      if (!seen.has(id)) { seen.add(id); result.push(folder); }
    }
    return result;
  }, [driveFolders]);
  const activeFolderRecord = activeFolderId ? folderById(activeFolderId) : folderByName(activeFolder);
  const activeFolderLabel = activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED ? activeFolder : folderPath(activeFolderRecord || activeFolder);
  const folders = useMemo(() => {
    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];
    const networkFolders = orderedDriveFolders.map((folder) => folder.name).filter(Boolean);
    const sourceFolders = view === "company" || view === "admin" ? workspaceFolders : networkFolders;
    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort((a, b) => String(a).localeCompare(String(b)))];
  }, [activeWorkspace, orderedDriveFolders, view]);`;

function patchFolderModel(src) {
  const start = src.indexOf('  const folders = useMemo(() => {');
  if (start === -1) return src;
  const end = src.indexOf('  const baseFiles =', start);
  if (end === -1) return src;
  return src.slice(0, start) + folderModelBlock + '\n' + src.slice(end);
}

const visibleFilesBlock = `  const visibleFiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return baseFiles.filter((file) => {
      const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);
      const cf = match?.companyFile;
      const fileFolder = file.folderId ? folderById(file.folderId) : folderByName(file.folder || file.folderName || fileFolders[file.hash] || fileFolders[file.rootHash] || "");
      const folderName = cf?.folder || fileFolder?.name || file.folder || file.folderName || fileFolders[file.hash] || fileFolders[file.rootHash] || UNCATEGORIZED;
      const displayName = cf?.name || file.name;
      const folderOk = activeFolder === ALL_FILES
        || (activeFolder === UNCATEGORIZED && !file.folderId && (!folderName || folderName === UNCATEGORIZED))
        || Boolean(activeFolderRecord && (file.folderId === activeFolderRecord.folderId || folderName === activeFolderRecord.name));
      const queryOk = !q || [displayName, file.hash, file.rootHash, folderName, folderPath(fileFolder), match?.workspace.name, file.replicationStatus].some((value) => String(value || "").toLowerCase().includes(q));
      return folderOk && queryOk;
    });
  }, [baseFiles, search, activeFolder, activeFolderRecord, fileFolders, companyFileByKey, driveFolders]);`;

function patchVisibleFiles(src) {
  const start = src.indexOf('  const visibleFiles = useMemo(() => {');
  if (start === -1) return src;
  const end = src.indexOf('\n\n  const companyBytes', start);
  if (end === -1) return src;
  return src.slice(0, start) + visibleFilesBlock + src.slice(end);
}

function patchRefresh(src) {
  return src.replace(
    '    const [nextSummary, nextFiles, nextWallet, nextCompany] = await Promise.all([\n      api.invoke<Summary>("p2p:networkSummary"),\n      api.invoke<P2PFile[]>("p2p:listFiles", { query: search }),\n      api.invoke<WalletState>("wallet:status"),\n      api.invoke<CompanyState>("company:state"),\n    ]);\n    setSummary(nextSummary);\n    setFiles(Array.isArray(nextFiles) ? nextFiles : []);\n    setWallet(nextWallet);\n    setCompany(nextCompany);',
    '    const [nextSummary, nextFiles, nextWallet, nextCompany, nextFolders] = await Promise.all([\n      api.invoke<Summary>("p2p:networkSummary"),\n      api.invoke<P2PFile[]>("p2p:listFiles", { query: search }),\n      api.invoke<WalletState>("wallet:status"),\n      api.invoke<CompanyState>("company:state"),\n      api.invoke<DriveFolder[]>("p2p:listFolders").catch(() => [] as DriveFolder[]),\n    ]);\n    setSummary(nextSummary);\n    setFiles(Array.isArray(nextFiles) ? nextFiles : []);\n    setWallet(nextWallet);\n    setCompany(nextCompany);\n    setDriveFolders(Array.isArray(nextFolders) ? nextFolders : []);'
  );
}

function patchFolderEffects(src) {
  src = src.replace(
    '    setFileFolders(readJson(folderStorageKey, {}));\n    setActiveFolder(ALL_FILES);',
    '    setFileFolders({});\n    setActiveFolder(ALL_FILES);\n    setActiveFolderId("");'
  );
  return src;
}

const folderActionsBlock = `  const createFolder = () => run(async () => {
    const folder = newFolder.trim();
    if (!folder) return;
    if (view === "company" || view === "admin") {
      const key = activeWorkspace ? companyFolderKey(activeWorkspace.workspaceId, folder) : ` + '`company:none:folder:${folder}`' + `;
      setFileFolders((current) => ({ ...current, [key]: folder }));
      setActiveFolder(folder);
      setNewFolder("");
      return;
    }
    const result = await api.invoke<{ folder?: DriveFolder; folders?: DriveFolder[] }>("p2p:createFolder", { name: folder, parentFolderId: activeFolderRecord?.folderId || "" });
    if (Array.isArray(result?.folders)) setDriveFolders(result.folders);
    if (result?.folder?.folderId) setActiveFolderId(result.folder.folderId);
    setActiveFolder(result?.folder?.name || folder);
    setNewFolder("");
    setFileFolders({});
    await refresh();
  });

  const renameFolder = (folderName: string, folderId?: string) => run(async () => {
    const folder = folderId ? folderById(folderId) : folderByName(folderName);
    if (!folder) throw new Error("This folder is not a network manifest folder. Refresh and try again.");
    const name = window.prompt("Rename folder", folder.name)?.trim();
    if (!name || name === folder.name) return;
    const result = await api.invoke<{ item?: DriveFolder }>("p2p:renameItem", { itemId: folder.id || folder.folderId || folder.hash, name });
    setDriveFolders((current) => current.map((candidate) => (candidate.folderId === folder.folderId || candidate.id === folder.id) ? { ...candidate, name: result?.item?.name || name } : candidate));
    if (activeFolderId === folder.folderId || activeFolder === folder.name) {
      setActiveFolder(result?.item?.name || name);
      if (folder.folderId) setActiveFolderId(folder.folderId);
    }
    setFileFolders({});
    await refresh();
    toast.success("Folder renamed");
  });

  const moveFolder = (folderName: string, folderId?: string) => run(async () => {
    const folder = folderId ? folderById(folderId) : folderByName(folderName);
    if (!folder) throw new Error("This folder is not a network manifest folder. Refresh and try again.");
    const targetName = window.prompt("Move inside folder name. Leave empty for root", "")?.trim() || "";
    const target = targetName ? folderByName(targetName) : null;
    if (targetName && !target) throw new Error("Target folder not found");
    await api.invoke("p2p:moveItem", { itemId: folder.id || folder.folderId || folder.hash, targetFolderId: target?.folderId || null });
    setDriveFolders((current) => current.map((candidate) => (candidate.folderId === folder.folderId || candidate.id === folder.id) ? { ...candidate, parentFolderId: target?.folderId || "" } : candidate));
    if (activeFolderId === folder.folderId || activeFolder === folder.name) { setActiveFolder(ALL_FILES); setActiveFolderId(""); }
    setFileFolders({});
    await refresh();
    toast.success("Folder moved");
  });

  const deleteFolder = (folderName: string, folderId?: string) => run(async () => {
    const folder = folderId ? folderById(folderId) : folderByName(folderName);
    if (!folder) throw new Error("This folder is not a network manifest folder. Refresh and try again.");
    if (!window.confirm("Delete folder " + folderPath(folder) + " from network manifests?")) return;
    await api.invoke("p2p:deleteItem", { itemId: folder.id || folder.folderId || folder.hash });
    const removed = new Set<string>([String(folder.folderId || folder.id || "")]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of driveFolders) {
        const id = String(candidate.folderId || candidate.id || "");
        if (id && !removed.has(id) && removed.has(String(candidate.parentFolderId || ""))) { removed.add(id); changed = true; }
      }
    }
    setDriveFolders((current) => current.filter((candidate) => !removed.has(String(candidate.folderId || candidate.id || ""))));
    if (activeFolderId && removed.has(activeFolderId)) { setActiveFolder(ALL_FILES); setActiveFolderId(""); }
    setFileFolders({});
    await refresh();
    toast.success("Folder deleted");
  });
`;

function patchActions(src) {
  let start = src.indexOf('  const createFolder = () =>');
  const upload = src.indexOf('  const upload = () => run(async () => {', start);
  if (start !== -1 && upload !== -1) return src.slice(0, start) + folderActionsBlock + src.slice(upload);
  start = src.indexOf('  const renameFolder = (folderName: string');
  const upload2 = src.indexOf('  const upload = () => run(async () => {', start);
  if (start !== -1 && upload2 !== -1) return src.slice(0, start) + folderActionsBlock + src.slice(upload2);
  return src;
}

function patchUploadPayload(src) {
  src = src.replace(
    '      folderPath: activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED ? "" : activeFolder,',
    '      folderPath: activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED ? "" : activeFolderLabel,\n      folderId: activeFolderRecord?.folderId || "",\n      folderName: activeFolderRecord?.name || "",'
  );
  return src;
}

function patchFileCard(src) {
  src = src.replace(
    '    const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;',
    '    const fileFolder = file.folderId ? folderById(file.folderId) : folderByName(file.folder || file.folderName || fileFolders[file.hash] || fileFolders[file.rootHash] || "");\n    const folder = cf?.folder || fileFolder?.name || file.folder || file.folderName || fileFolders[file.hash] || fileFolders[file.rootHash] || UNCATEGORIZED;\n    const folderLabel = cf?.folder || (fileFolder ? folderPath(fileFolder) : folder);'
  );
  src = src.replace(
    '<p className="text-xs text-zinc-500"><FolderOpen className="mr-1 inline size-3" />{folder}</p>',
    '<p className="text-xs text-zinc-500"><FolderOpen className="mr-1 inline size-3" />{folderLabel}</p>'
  );
  return src;
}

function patchFolderListUi(src) {
  const newFolderList = `              {folders.map((folder) => {
                const manifestFolder = folderByName(folder);
                const isManagedFolder = view === "personal" && Boolean(manifestFolder) && folder !== ALL_FILES && folder !== UNCATEGORIZED;
                const folderIsActive = activeFolder === folder && (!manifestFolder || !activeFolderId || activeFolderId === manifestFolder.folderId);
                return (
                  <div key={manifestFolder?.folderId || folder} className={\`rounded-2xl border \${folderIsActive ? "border-blue-500/40 bg-blue-950/20" : "border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/60"}\`} style={isManagedFolder ? { marginLeft: folderDepth(folder) * 14 } : undefined}>
                    <button onClick={() => { setActiveFolder(folder); setActiveFolderId(manifestFolder?.folderId || ""); }} className={\`block w-full px-4 py-3 text-left text-sm \${folderIsActive ? "text-blue-100" : "text-zinc-300"}\`}>
                      <span className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate"><FolderOpen className="mr-2 inline size-4" />{isManagedFolder ? folderPath(manifestFolder) : folder}</span>
                        {isManagedFolder && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">manifest</span>}
                      </span>
                    </button>
                    {isManagedFolder && (
                      <div className="grid grid-cols-3 gap-1 px-3 pb-3">
                        <Button variant="outline" size="sm" onClick={() => renameFolder(folder, manifestFolder?.folderId)} disabled={busy}>Rename</Button>
                        <Button variant="outline" size="sm" onClick={() => moveFolder(folder, manifestFolder?.folderId)} disabled={busy}>Move</Button>
                        <Button variant="destructive" size="sm" onClick={() => deleteFolder(folder, manifestFolder?.folderId)} disabled={busy}>Delete</Button>
                      </div>
                    )}
                  </div>
                );
              })}`;
  const patterns = [
    /              \{folders\.map\(\(folder\) => \{[\s\S]*?              \}\)\}/,
    /              \{folders\.map\(\(folder\) => \([\s\S]*?              \)\)\}/,
  ];
  for (const pattern of patterns) if (pattern.test(src)) return src.replace(pattern, newFolderList);
  return src;
}

function patchDisconnect(src) {
  return src.replace(
    '  const disconnectWallet = () => run(async () => {\n    setWallet(await api.invoke<WalletState>("wallet:disconnect"));\n    await refresh();\n  });',
    '  const disconnectWallet = () => run(async () => {\n    const nextWallet = await api.invoke<WalletState>("wallet:disconnect");\n    setWallet(nextWallet);\n    setDrivePassword("");\n    setFiles([]);\n    setDriveFolders([]);\n    setFileFolders({});\n    setActiveFolder(ALL_FILES);\n    setActiveFolderId("");\n    await refresh();\n  });'
  );
}

let src = read(livePath);
if (!src) {
  console.warn('[live-network-folders] NativeP2PAppLive.tsx missing');
  process.exit(0);
}
const before = src;

src = ensureDriveFolderTypes(src);
src = ensureFolderState(src);
src = patchFolderModel(src);
src = patchVisibleFiles(src);
src = patchRefresh(src);
src = patchFolderEffects(src);
src = patchDisconnect(src);
src = patchActions(src);
src = patchUploadPayload(src);
src = patchFileCard(src);
src = patchFolderListUi(src);

if (src !== before) {
  write(livePath, src);
  console.log('[live-network-folders] nested manifest-backed folder UI installed');
} else {
  console.log('[live-network-folders] nested manifest-backed folder UI already installed');
}
