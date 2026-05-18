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

function patch() {
  let src = fs.readFileSync(livePath, 'utf8');
  const before = src;

  src = forceIdentityAccountCard(src);

  if (!src.includes('| "p2p:updateFile"')) {
    src = src.replace('  | "p2p:prepareProof"\n', '  | "p2p:prepareProof"\n  | "p2p:updateFile"\n');
  }
  src = src.replace('type Bridge = { invoke: <T>(channel: Channel, payload?: unknown) => Promise<T> };', 'type Bridge = { invoke: <T>(channel: string, payload?: unknown) => Promise<T> };');
  if (!src.includes('folder?: string; ownerWallet?: string')) {
    src = src.replace('totalChunks: number; ownerWallet?: string;', 'totalChunks: number; folder?: string; ownerWallet?: string;');
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
  src = src.replace(
    '  const disconnectWallet = () => run(async () => {\n    setWallet(await api.invoke<WalletState>("wallet:disconnect"));\n    await refresh();\n  });',
    '  const disconnectWallet = () => run(async () => {\n    const nextWallet = await api.invoke<WalletState>("wallet:disconnect");\n    setWallet(nextWallet);\n    setDrivePassword("");\n    setFiles([]);\n    setDriveFolders([]);\n    setActiveFolder(ALL_FILES);\n    await refresh();\n  });'
  );

  if (!src.includes('const [driveFolders, setDriveFolders]')) {
    src = src.replace('  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});', '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n  const [driveFolders, setDriveFolders] = useState<DriveFolder[]>([]);');
  }

  src = src.replace(
    '    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const localFolders = Object.values(fileFolders).filter(Boolean);\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set([...localFolders, ...workspaceFolders])).sort()];\n  }, [fileFolders, activeWorkspace]);',
    '    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const personalManifestFolders = personalFiles.map((file) => file.folder).filter(Boolean) as string[];\n    const networkFolders = driveFolders.map((folder) => folder.name).filter(Boolean);\n    const localFolders = Object.values(fileFolders).filter(Boolean);\n    const sourceFolders = view === "company" || view === "admin" ? workspaceFolders : [...networkFolders, ...personalManifestFolders, ...localFolders];\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];\n  }, [fileFolders, activeWorkspace, personalFiles, driveFolders, view]);'
  );
  src = src.replace(
    '    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const personalManifestFolders = personalFiles.map((file) => file.folder).filter(Boolean) as string[];\n    const localFolders = Object.values(fileFolders).filter(Boolean);\n    const sourceFolders = view === "company" || view === "admin" ? workspaceFolders : [...personalManifestFolders, ...localFolders];\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];\n  }, [fileFolders, activeWorkspace, personalFiles, view]);',
    '    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const personalManifestFolders = personalFiles.map((file) => file.folder).filter(Boolean) as string[];\n    const networkFolders = driveFolders.map((folder) => folder.name).filter(Boolean);\n    const localFolders = Object.values(fileFolders).filter(Boolean);\n    const sourceFolders = view === "company" || view === "admin" ? workspaceFolders : [...networkFolders, ...personalManifestFolders, ...localFolders];\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];\n  }, [fileFolders, activeWorkspace, personalFiles, driveFolders, view]);'
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
    '      const folder = cf?.folder || file.folder || fileFolders[file.hash] || UNCATEGORIZED;'
  );
  src = src.replace(
    '    const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;',
    '    const folder = cf?.folder || file.folder || fileFolders[file.hash] || UNCATEGORIZED;'
  );

  src = src.replace(
    '    if (activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED && result?.files?.length) {\n      setFileFolders((current) => {\n        const next = { ...current };\n        for (const file of result.files || []) next[file.hash] = activeFolder;\n        return next;\n      });\n    }',
    '    if (activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED && result?.files?.length) {\n      setFileFolders((current) => {\n        const next = { ...current };\n        for (const file of result.files || []) next[file.hash] = file.folder || activeFolder;\n        return next;\n      });\n    }'
  );

  src = src.replace(
    '              if (match) void api.invoke("company:updateFile", { workspaceId: match.workspace.workspaceId, rootHash: match.companyFile.rootHash, patch: { folder: nextFolder } }).then(refresh);\n              else setFileFolders((current) => ({ ...current, [file.hash]: nextFolder }));',
    '              if (match) void api.invoke("company:updateFile", { workspaceId: match.workspace.workspaceId, rootHash: match.companyFile.rootHash, patch: { folder: nextFolder } }).then(refresh);\n              else void api.invoke("p2p:updateFile", { hash: file.hash, patch: { folder: nextFolder } }).then(refresh);'
  );

  src = src.replace(
    '  const createFolder = () => {\n    const folder = newFolder.trim();\n    if (!folder) return;\n    setFileFolders((current) => ({ ...current, [`folder:${folder}`]: folder }));\n    setActiveFolder(folder);\n    setNewFolder("");\n  };',
    '  const createFolder = () => run(async () => {\n    const folder = newFolder.trim();\n    if (!folder) return;\n    if (view === "company" || view === "admin") {\n      const key = activeWorkspace ? `company:${activeWorkspace.workspaceId}:folder:${folder}` : `company:none:folder:${folder}`;\n      setFileFolders((current) => ({ ...current, [key]: folder }));\n      setActiveFolder(folder);\n      setNewFolder("");\n      return;\n    }\n    await api.invoke("p2p:createFolder", { name: folder, parentFolderId: activeFolderRecord?.folderId || null });\n    setNewFolder("");\n    setActiveFolder(folder);\n    await refresh();\n  });'
  );
  src = src.replace(
    '  const createFolder = () => {\n    const folder = newFolder.trim();\n    if (!folder) return;\n    const key = (view === "company" || view === "admin") && activeWorkspace ? `company:${activeWorkspace.workspaceId}:folder:${folder}` : `personal:folder:${folder}`;\n    setFileFolders((current) => ({ ...current, [key]: folder }));\n    setActiveFolder(folder);\n    setNewFolder("");\n  };',
    '  const createFolder = () => run(async () => {\n    const folder = newFolder.trim();\n    if (!folder) return;\n    if (view === "company" || view === "admin") {\n      const key = activeWorkspace ? `company:${activeWorkspace.workspaceId}:folder:${folder}` : `company:none:folder:${folder}`;\n      setFileFolders((current) => ({ ...current, [key]: folder }));\n      setActiveFolder(folder);\n      setNewFolder("");\n      return;\n    }\n    await api.invoke("p2p:createFolder", { name: folder, parentFolderId: activeFolderRecord?.folderId || null });\n    setNewFolder("");\n    setActiveFolder(folder);\n    await refresh();\n  });'
  );

  if (!src.includes('const renameFolder = (folderName: string) =>')) {
    src = src.replace('  const upload = () => run(async () => {', '  const renameFolder = (folderName: string) => run(async () => {\n    const folder = folderByName(folderName);\n    if (!folder) throw new Error("Folder is not synced yet. Refresh and try again.");\n    const name = window.prompt("New folder name", folder.name)?.trim();\n    if (!name || name === folder.name) return;\n    await api.invoke("p2p:renameItem", { itemId: folder.id || folder.folderId || folder.hash, name });\n    if (activeFolder === folderName) setActiveFolder(name);\n    await refresh();\n    toast.success("Folder renamed");\n  });\n  const moveFolder = (folderName: string) => run(async () => {\n    const folder = folderByName(folderName);\n    if (!folder) throw new Error("Folder is not synced yet. Refresh and try again.");\n    const targetName = window.prompt("Move to folder name. Leave empty for root", "")?.trim() || "";\n    const target = targetName ? folderByName(targetName) : null;\n    if (targetName && !target) throw new Error("Target folder not found");\n    await api.invoke("p2p:moveItem", { itemId: folder.id || folder.folderId || folder.hash, targetFolderId: target?.folderId || null });\n    if (activeFolder === folderName) setActiveFolder(ALL_FILES);\n    await refresh();\n    toast.success("Folder moved");\n  });\n  const deleteFolder = (folderName: string) => run(async () => {\n    const folder = folderByName(folderName);\n    if (!folder) throw new Error("Folder is not synced yet. Refresh and try again.");\n    if (!window.confirm(`Delete folder ${folder.name} and its contents from manifests? Chunks/encryption are not modified.`)) return;\n    await api.invoke("p2p:deleteItem", { itemId: folder.id || folder.folderId || folder.hash });\n    if (activeFolder === folderName) setActiveFolder(ALL_FILES);\n    await refresh();\n    toast.success("Folder deleted");\n  });\n  const upload = () => run(async () => {');
  }

  const oldFolderList = `              {folders.map((folder) => (\n                <button key={folder} onClick={() => setActiveFolder(folder)} className={\`block w-full rounded-xl px-4 py-3 text-left text-sm \${activeFolder === folder ? "bg-zinc-800" : "text-zinc-400 hover:bg-zinc-800/60"}\`}>\n                  <FolderOpen className="mr-2 inline size-4" />{folder}\n                </button>\n              ))}`;
  const newFolderList = `              {folders.map((folder) => (\n                <div key={folder} className={\`rounded-xl \${activeFolder === folder ? "bg-zinc-800" : "hover:bg-zinc-800/60"}\`}>\n                  <button onClick={() => setActiveFolder(folder)} className={\`block w-full px-4 py-3 text-left text-sm \${activeFolder === folder ? "text-zinc-50" : "text-zinc-400"}\`}>\n                    <FolderOpen className="mr-2 inline size-4" />{folder}\n                  </button>\n                  {view === "personal" && folder !== ALL_FILES && folder !== UNCATEGORIZED && (\n                    <div className="flex flex-wrap gap-1 px-3 pb-3">\n                      <Button variant="outline" size="sm" onClick={() => renameFolder(folder)} disabled={busy}>Rename</Button>\n                      <Button variant="outline" size="sm" onClick={() => moveFolder(folder)} disabled={busy}>Move</Button>\n                      <Button variant="destructive" size="sm" onClick={() => deleteFolder(folder)} disabled={busy}>Delete</Button>\n                    </div>\n                  )}\n                </div>\n              ))}`;
  src = src.replace(oldFolderList, newFolderList);

  if (src !== before) {
    fs.writeFileSync(livePath, src, 'utf8');
    console.log('[live-network-folders] patched seed identity upload/disconnect, My Drive folders, folder actions UI, and Identity card');
  } else {
    console.log('[live-network-folders] already patched');
  }
}

restoreSafeLiveIfNeeded();
patch();