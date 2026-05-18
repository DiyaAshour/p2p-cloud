const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = process.cwd();
const livePath = path.join(root, 'client', 'src', 'NativeP2PAppLive.tsx');
const safeRef = '9d64d69b05a89ca28c6677162230b5f1ef2fa7c9';

function isProbablyBroken(src) {
  return !src.includes('export default function NativeP2PAppLive') || !src.includes('<main className=') || !src.includes('</main>') || !src.includes('</div>') || src.length < 25000;
}

function restoreSafeLiveIfNeeded() {
  const current = fs.existsSync(livePath) ? fs.readFileSync(livePath, 'utf8') : '';
  if (!isProbablyBroken(current)) return;
  try {
    const content = execFileSync('git', ['show', `${safeRef}:client/src/NativeP2PAppLive.tsx`], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    fs.writeFileSync(livePath, content, 'utf8');
    console.log('[live-network-folders] restored NativeP2PAppLive.tsx from known-good UI commit because current file was truncated');
  } catch (error) {
    console.warn('[live-network-folders] could not restore known-good UI:', error?.message || error);
  }
}

function forceIdentityAccountCard(src) {
  if (!src.includes('import IdentityAccountCard from "./IdentityAccountCard";')) {
    src = src.replace('import { toast } from "sonner";', 'import { toast } from "sonner";\nimport IdentityAccountCard from "./IdentityAccountCard";');
  }
  if (src.includes('<IdentityAccountCard api={api}')) {
    return src.replace(/walletConnected=\{walletConnected\}/g, 'walletConnected={identityConnected}');
  }
  const replacement = '          <IdentityAccountCard api={api} busy={busy} identityLabel={identityLabel} walletConnected={identityConnected} onWallet={setWallet} onRefresh={refresh} onDisconnect={disconnectWallet} />';
  const exactOld = `<Card className="rounded-2xl border-zinc-800 bg-zinc-900">\n            <CardContent className="space-y-4 p-5">\n              <p className="text-sm text-zinc-400">Identity</p>\n              <p className="truncate font-medium">{identityLabel}</p>\n              {walletConnected ? (\n                <Button variant="outline" onClick={disconnectWallet} disabled={busy}>Disconnect</Button>\n              ) : (\n                <Button onClick={connectWallet} disabled={busy}><Wallet className="size-4" />Connect Wallet</Button>\n              )}\n            </CardContent>\n          </Card>`;
  if (src.includes(exactOld)) return src.replace(exactOld, replacement.trimEnd());
  const broad = /          <Card className="rounded-2xl border-zinc-800 bg-zinc-900">\r?\n            <CardContent className="space-y-4 p-5">\r?\n              <p className="text-sm text-zinc-400">Identity<\/p>[\s\S]*?<Wallet className="size-4" \/>Connect Wallet[\s\S]*?            <\/CardContent>\r?\n          <\/Card>/;
  if (broad.test(src)) return src.replace(broad, replacement);
  console.warn('[live-network-folders] could not find old Identity card; leaving current identity block unchanged');
  return src;
}

function ensureDriveFoldersState(src) {
  if (src.includes('const [driveFolders, setDriveFolders]')) return src;
  const line = '  const [driveFolders, setDriveFolders] = useState<DriveFolder[]>([]);\n';
  const exact = '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n';
  if (src.includes(exact)) return src.replace(exact, exact + line);
  const fileFoldersRegex = /(  const \[fileFolders, setFileFolders\][^\n]*\r?\n)/;
  if (fileFoldersRegex.test(src)) return src.replace(fileFoldersRegex, `$1${line}`);
  const activeWorkspaceRegex = /(  const \[activeWorkspaceId, setActiveWorkspaceId\][^\n]*\r?\n)/;
  if (activeWorkspaceRegex.test(src)) return src.replace(activeWorkspaceRegex, `${line}$1`);
  const newFolderRegex = /(  const \[newFolder, setNewFolder\][^\n]*\r?\n)/;
  if (newFolderRegex.test(src)) return src.replace(newFolderRegex, `$1${line}`);
  console.warn('[live-network-folders] could not inject driveFolders state; folder action helpers will stay disabled');
  return src;
}

const networkFoldersMemo = `  const folders = useMemo(() => {
    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];
    const networkFolders = driveFolders.map((folder) => folder.name).filter(Boolean);
    const sourceFolders = view === "company" || view === "admin" ? workspaceFolders : networkFolders;
    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];
  }, [activeWorkspace, driveFolders, view]);`;

function patchFoldersMemo(src) {
  const marker = '  const folders = useMemo(() => {';
  const start = src.indexOf(marker);
  if (start === -1) {
    console.warn('[live-network-folders] folders memo not found');
    return src;
  }
  const nextMarker = '  const baseFiles =';
  const end = src.indexOf(nextMarker, start);
  if (end === -1) {
    console.warn('[live-network-folders] folders memo end not found');
    return src;
  }
  const current = src.slice(start, end);
  if (current.includes('const sourceFolders = view === "company" || view === "admin" ? workspaceFolders : networkFolders;')) return src;
  return src.slice(0, start) + networkFoldersMemo + '\n' + src.slice(end);
}

function patchFolderListUi(src) {
  const newFolderList = `              {folders.map((folder) => {
                const manifestFolder = folderByName(folder);
                const isManagedFolder = view === "personal" && Boolean(manifestFolder) && folder !== ALL_FILES && folder !== UNCATEGORIZED;
                return (
                  <div key={folder} className={\`rounded-2xl border \${activeFolder === folder ? "border-blue-500/40 bg-blue-950/20" : "border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/60"}\`}>
                    <button onClick={() => setActiveFolder(folder)} className={\`block w-full px-4 py-3 text-left text-sm \${activeFolder === folder ? "text-blue-100" : "text-zinc-300"}\`}>
                      <span className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate"><FolderOpen className="mr-2 inline size-4" />{folder}</span>
                        {isManagedFolder && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">manifest</span>}
                      </span>
                    </button>
                    {isManagedFolder && (
                      <div className="grid grid-cols-3 gap-1 px-3 pb-3">
                        <Button variant="outline" size="sm" onClick={() => renameFolder(folder)} disabled={busy}>Rename</Button>
                        <Button variant="outline" size="sm" onClick={() => moveFolder(folder)} disabled={busy}>Move</Button>
                        <Button variant="destructive" size="sm" onClick={() => deleteFolder(folder)} disabled={busy}>Delete</Button>
                      </div>
                    )}
                  </div>
                );
              })}`;
  const broad = /              \{folders\.map\(\(folder\) =>[\s\S]*?              \)\)\}/;
  const broadBlock = /              \{folders\.map\(\(folder\) => \{[\s\S]*?              \}\)\}/;
  if (broadBlock.test(src)) return src.replace(broadBlock, newFolderList);
  if (broad.test(src)) return src.replace(broad, newFolderList);
  console.warn('[live-network-folders] could not patch folder list UI; actions may not be visible');
  return src;
}

function patch() {
  let src = fs.readFileSync(livePath, 'utf8');
  const before = src;

  src = forceIdentityAccountCard(src);

  if (!src.includes('| "p2p:updateFile"')) {
    src = src.replace('  | "p2p:prepareProof"\n', '  | "p2p:prepareProof"\n  | "p2p:updateFile"\n');
  }
  src = src.replace('type Bridge = { invoke: <T>(channel: Channel, payload?: unknown) => Promise<T> };', 'type Bridge = { invoke: <T>(channel: string, payload?: unknown) => Promise<T> };');
  if (!src.includes('folder?: string; ownerWallet?: string')) {
    src = src.replace('totalChunks: number; ownerWallet?: string;', 'totalChunks: number; folder?: string; folderName?: string; folderId?: string; ownerWallet?: string;');
  }
  if (!src.includes('type DriveFolder =')) {
    src = src.replace('type View = "personal" | "company" | "shared" | "admin";', 'type DriveFolder = { id?: string; name: string; folderId?: string; parentFolderId?: string | null; hash?: string; rootHash?: string; kind?: string; isFolder?: boolean; ownerWallet?: string };\ntype View = "personal" | "company" | "shared" | "admin";');
  }

  src = src.replace(
    '  const walletConnected = Boolean(wallet?.connected && (wallet.accountId || wallet.address));\n  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";',
    '  const walletConnected = Boolean(wallet?.connected && wallet?.authMode !== "seed" && (wallet.accountId || wallet.address));\n  const seedConnected = Boolean(wallet?.authMode === "seed" && (wallet.accountId || wallet.username || wallet.seedFingerprint));\n  const identityConnected = Boolean(walletConnected || seedConnected);\n  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";'
  );
  if (!src.includes('const identityConnected = Boolean(walletConnected || seedConnected);')) {
    src = src.replace(
      '  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";',
      '  const seedConnected = Boolean(wallet?.authMode === "seed" && (wallet.accountId || wallet.username || wallet.seedFingerprint));\n  const identityConnected = Boolean(walletConnected || seedConnected);\n  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";'
    );
  }
  src = src.replace(/walletConnected=\{walletConnected\}/g, 'walletConnected={identityConnected}');
  src = src.replace('if (!walletConnected) throw new Error("Connect wallet before importing a shared link.");', 'if (!identityConnected) throw new Error("Sign in before importing a shared link.");');
  src = src.replace('disabled={busy || !walletConnected}>Save to My Drive', 'disabled={busy || !identityConnected}>Save to My Drive');
  src = src.replace('if (!walletConnected) throw new Error("Connect wallet or sign in with Seed Account before uploading");', 'if (!identityConnected) throw new Error("Connect wallet or sign in with Seed Account before uploading");');

  src = ensureDriveFoldersState(src);
  src = patchFoldersMemo(src);

  src = src.replace(
    '  const disconnectWallet = () => run(async () => {\n    setWallet(await api.invoke<WalletState>("wallet:disconnect"));\n    await refresh();\n  });',
    '  const disconnectWallet = () => run(async () => {\n    const nextWallet = await api.invoke<WalletState>("wallet:disconnect");\n    setWallet(nextWallet);\n    setDrivePassword("");\n    setFiles([]);\n    setDriveFolders([]);\n    setFileFolders({});\n    try { Object.keys(localStorage).filter((key) => key.toLowerCase().includes("folder")).forEach((key) => localStorage.removeItem(key)); } catch {}\n    setActiveFolder(ALL_FILES);\n    await refresh();\n  });'
  );

  if (!src.includes('const folderByName = (folderName: string)')) {
    src = src.replace('  const baseFiles = view === "company" || view === "admin" ? companyFiles : view === "shared" ? sharedFiles : personalFiles;', '  const folderByName = (folderName: string) => driveFolders.find((folder) => folder.name === folderName);\n  const activeFolderRecord = folderByName(activeFolder);\n  const baseFiles = view === "company" || view === "admin" ? companyFiles : view === "shared" ? sharedFiles : personalFiles;');
  }

  src = src.replace(
    '    const [nextSummary, nextFiles, nextWallet, nextCompany] = await Promise.all([\n      api.invoke<Summary>("p2p:networkSummary"),\n      api.invoke<P2PFile[]>("p2p:listFiles", { query: search }),\n      api.invoke<WalletState>("wallet:status"),\n      api.invoke<CompanyState>("company:state"),\n    ]);\n    setSummary(nextSummary);\n    setFiles(Array.isArray(nextFiles) ? nextFiles : []);\n    setWallet(nextWallet);\n    setCompany(nextCompany);',
    '    const [nextSummary, nextFiles, nextWallet, nextCompany, nextFolders] = await Promise.all([\n      api.invoke<Summary>("p2p:networkSummary"),\n      api.invoke<P2PFile[]>("p2p:listFiles", { query: search }),\n      api.invoke<WalletState>("wallet:status"),\n      api.invoke<CompanyState>("company:state"),\n      api.invoke<DriveFolder[]>("p2p:listFolders").catch(() => [] as DriveFolder[]),\n    ]);\n    setSummary(nextSummary);\n    setFiles(Array.isArray(nextFiles) ? nextFiles : []);\n    setWallet(nextWallet);\n    setCompany(nextCompany);\n    setDriveFolders(Array.isArray(nextFolders) ? nextFolders : []);'
  );

  src = src.replace(
    '      const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;',
    '      const folder = cf?.folder || file.folder || file.folderName || fileFolders[file.hash] || fileFolders[file.rootHash] || UNCATEGORIZED;'
  );
  src = src.replace(
    '    const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;',
    '    const folder = cf?.folder || file.folder || file.folderName || fileFolders[file.hash] || fileFolders[file.rootHash] || UNCATEGORIZED;'
  );

  src = src.replace(
    '    if (activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED && result?.files?.length) {\n      setFileFolders((current) => {\n        const next = { ...current };\n        for (const file of result.files || []) next[file.hash] = activeFolder;\n        return next;\n      });\n    }',
    '    if (activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED && result?.files?.length) {\n      setFileFolders((current) => {\n        const next = { ...current };\n        for (const file of result.files || []) { next[file.hash] = file.folder || activeFolder; if (file.rootHash) next[file.rootHash] = file.folder || activeFolder; }\n        return next;\n      });\n    }'
  );

  src = src.replace(
    '              if (match) void api.invoke("company:updateFile", { workspaceId: match.workspace.workspaceId, rootHash: match.companyFile.rootHash, patch: { folder: nextFolder } }).then(refresh);\n              else setFileFolders((current) => ({ ...current, [file.hash]: nextFolder }));',
    '              if (match) void api.invoke("company:updateFile", { workspaceId: match.workspace.workspaceId, rootHash: match.companyFile.rootHash, patch: { folder: nextFolder } }).then(refresh);\n              else void api.invoke("p2p:updateFile", { hash: file.hash, rootHash: file.rootHash, patch: { folder: nextFolder } }).then(refresh);'
  );

  src = src.replace(
    '  const createFolder = () => {\n    const folder = newFolder.trim();\n    if (!folder) return;\n    setFileFolders((current) => ({ ...current, [`folder:${folder}`]: folder }));\n    setActiveFolder(folder);\n    setNewFolder("");\n  };',
    '  const createFolder = () => run(async () => {\n    const folder = newFolder.trim();\n    if (!folder) return;\n    if (view === "company" || view === "admin") {\n      const key = activeWorkspace ? `company:${activeWorkspace.workspaceId}:folder:${folder}` : `company:none:folder:${folder}`;\n      setFileFolders((current) => ({ ...current, [key]: folder }));\n      setActiveFolder(folder);\n      setNewFolder("");\n      return;\n    }\n    const result = await api.invoke<{ folder?: DriveFolder; folders?: DriveFolder[] }>("p2p:createFolder", { name: folder, parentFolderId: activeFolderRecord?.folderId || null });\n    setNewFolder("");\n    if (Array.isArray(result?.folders)) setDriveFolders(result.folders);\n    setActiveFolder(result?.folder?.name || folder);\n    setFileFolders({});\n    await refresh();\n  });'
  );
  src = src.replace(
    '  const createFolder = () => {\n    const folder = newFolder.trim();\n    if (!folder) return;\n    const key = (view === "company" || view === "admin") && activeWorkspace ? `company:${activeWorkspace.workspaceId}:folder:${folder}` : `personal:folder:${folder}`;\n    setFileFolders((current) => ({ ...current, [key]: folder }));\n    setActiveFolder(folder);\n    setNewFolder("");\n  };',
    '  const createFolder = () => run(async () => {\n    const folder = newFolder.trim();\n    if (!folder) return;\n    if (view === "company" || view === "admin") {\n      const key = activeWorkspace ? `company:${activeWorkspace.workspaceId}:folder:${folder}` : `company:none:folder:${folder}`;\n      setFileFolders((current) => ({ ...current, [key]: folder }));\n      setActiveFolder(folder);\n      setNewFolder("");\n      return;\n    }\n    const result = await api.invoke<{ folder?: DriveFolder; folders?: DriveFolder[] }>("p2p:createFolder", { name: folder, parentFolderId: activeFolderRecord?.folderId || null });\n    setNewFolder("");\n    if (Array.isArray(result?.folders)) setDriveFolders(result.folders);\n    setActiveFolder(result?.folder?.name || folder);\n    setFileFolders({});\n    await refresh();\n  });'
  );

  if (!src.includes('const renameFolder = (folderName: string) =>')) {
    src = src.replace('  const upload = () => run(async () => {', '  const renameFolder = (folderName: string) => run(async () => {\n    const folder = folderByName(folderName);\n    if (!folder) throw new Error("This folder is not a network manifest folder. Refresh and try again.");\n    const name = window.prompt("Rename folder", folder.name)?.trim();\n    if (!name || name === folder.name) return;\n    const result = await api.invoke<{ item?: DriveFolder }>("p2p:renameItem", { itemId: folder.id || folder.folderId || folder.hash, name });\n    setDriveFolders((current) => current.map((candidate) => (candidate.folderId === folder.folderId || candidate.id === folder.id) ? { ...candidate, name: result?.item?.name || name } : candidate));\n    setFileFolders({});\n    if (activeFolder === folderName) setActiveFolder(result?.item?.name || name);\n    await refresh();\n    toast.success("Folder renamed");\n  });\n  const moveFolder = (folderName: string) => run(async () => {\n    const folder = folderByName(folderName);\n    if (!folder) throw new Error("This folder is not a network manifest folder. Refresh and try again.");\n    const targetName = window.prompt("Move to folder name. Leave empty for root", "")?.trim() || "";\n    const target = targetName ? folderByName(targetName) : null;\n    if (targetName && !target) throw new Error("Target folder not found");\n    await api.invoke("p2p:moveItem", { itemId: folder.id || folder.folderId || folder.hash, targetFolderId: target?.folderId || null });\n    if (activeFolder === folderName) setActiveFolder(ALL_FILES);\n    setFileFolders({});\n    await refresh();\n    toast.success("Folder moved");\n  });\n  const deleteFolder = (folderName: string) => run(async () => {\n    const folder = folderByName(folderName);\n    if (!folder) throw new Error("This folder is not a network manifest folder. Refresh and try again.");\n    if (!window.confirm(`Delete folder ${folder.name} from network manifests?`)) return;\n    await api.invoke("p2p:deleteItem", { itemId: folder.id || folder.folderId || folder.hash });\n    setDriveFolders((current) => current.filter((candidate) => candidate.folderId !== folder.folderId && candidate.id !== folder.id && candidate.hash !== folder.hash));\n    setFileFolders({});\n    if (activeFolder === folderName) setActiveFolder(ALL_FILES);\n    await refresh();\n    toast.success("Folder deleted");\n  });\n  const upload = () => run(async () => {');
  } else {
    src = src.replace(/const renameFolder = \(folderName: string\) => run\(async \(\) => \{[\s\S]*?  const upload = \(\) => run\(async \(\) => \{/,
      'const renameFolder = (folderName: string) => run(async () => {\n    const folder = folderByName(folderName);\n    if (!folder) throw new Error("This folder is not a network manifest folder. Refresh and try again.");\n    const name = window.prompt("Rename folder", folder.name)?.trim();\n    if (!name || name === folder.name) return;\n    const result = await api.invoke<{ item?: DriveFolder }>("p2p:renameItem", { itemId: folder.id || folder.folderId || folder.hash, name });\n    setDriveFolders((current) => current.map((candidate) => (candidate.folderId === folder.folderId || candidate.id === folder.id) ? { ...candidate, name: result?.item?.name || name } : candidate));\n    setFileFolders({});\n    if (activeFolder === folderName) setActiveFolder(result?.item?.name || name);\n    await refresh();\n    toast.success("Folder renamed");\n  });\n  const moveFolder = (folderName: string) => run(async () => {\n    const folder = folderByName(folderName);\n    if (!folder) throw new Error("This folder is not a network manifest folder. Refresh and try again.");\n    const targetName = window.prompt("Move to folder name. Leave empty for root", "")?.trim() || "";\n    const target = targetName ? folderByName(targetName) : null;\n    if (targetName && !target) throw new Error("Target folder not found");\n    await api.invoke("p2p:moveItem", { itemId: folder.id || folder.folderId || folder.hash, targetFolderId: target?.folderId || null });\n    if (activeFolder === folderName) setActiveFolder(ALL_FILES);\n    setFileFolders({});\n    await refresh();\n    toast.success("Folder moved");\n  });\n  const deleteFolder = (folderName: string) => run(async () => {\n    const folder = folderByName(folderName);\n    if (!folder) throw new Error("This folder is not a network manifest folder. Refresh and try again.");\n    if (!window.confirm(`Delete folder ${folder.name} from network manifests?`)) return;\n    await api.invoke("p2p:deleteItem", { itemId: folder.id || folder.folderId || folder.hash });\n    setDriveFolders((current) => current.filter((candidate) => candidate.folderId !== folder.folderId && candidate.id !== folder.id && candidate.hash !== folder.hash));\n    setFileFolders({});\n    if (activeFolder === folderName) setActiveFolder(ALL_FILES);\n    await refresh();\n    toast.success("Folder deleted");\n  });\n  const upload = () => run(async () => {');
  }

  src = patchFolderListUi(src);

  if (src !== before) {
    fs.writeFileSync(livePath, src, 'utf8');
    console.log('[live-network-folders] patched manifest-only My Drive folder UI and actions');
  } else {
    console.log('[live-network-folders] already patched');
  }
}

restoreSafeLiveIfNeeded();
patch();