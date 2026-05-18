const fs = require('node:fs');
const path = require('node:path');

const p = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(p)) {
  console.warn('[live-file-classification-manifest] NativeP2PAppLive.tsx not found');
  process.exit(0);
}

let s = fs.readFileSync(p, 'utf8');
const before = s;

if (!s.includes('| "p2p:listFolders"')) {
  s = s.replace('  | "p2p:listFiles"', '  | "p2p:listFiles"\n  | "p2p:listFolders"\n  | "p2p:moveItem"');
}

s = s.replace(
  'type P2PFile = { id?: string; name: string; size: number; hash: string; rootHash: string; uploadedAt: string; isEncrypted: boolean; totalChunks: number; ownerWallet?: string; replicas?: string[]; replicationStatus?: string; protectedChunks?: number; needsRepairChunks?: number };\ntype View = "personal" | "company" | "shared" | "admin";',
  'type P2PFile = { id?: string; name: string; size: number; hash: string; rootHash: string; uploadedAt: string; isEncrypted: boolean; totalChunks: number; ownerWallet?: string; replicas?: string[]; replicationStatus?: string; protectedChunks?: number; needsRepairChunks?: number; folderId?: string; parentFolderId?: string; folderName?: string; folder?: string };\ntype ManifestFolder = { id?: string; name: string; folderId?: string; parentFolderId?: string | null; hash?: string; rootHash?: string; kind?: string; isFolder?: boolean };\ntype View = "personal" | "company" | "shared" | "admin";'
);

if (!s.includes('function folderProp(file: P2PFile, key: string)')) {
  s = s.replace(
    'function keyFor(file: P2PFile) {\n  return file.rootHash || file.hash;\n}',
    'function keyFor(file: P2PFile) {\n  return file.rootHash || file.hash;\n}\nfunction itemIdFor(file: P2PFile) {\n  return file.id || file.rootHash || file.hash;\n}\nfunction folderProp(file: P2PFile, key: string) {\n  return String((file as unknown as Record<string, unknown>)?.[key] || "").trim();\n}\nfunction folderIds(folder: ManifestFolder) {\n  return [folder.folderId, folder.id, folder.hash, folder.rootHash].filter(Boolean).map((value) => String(value));\n}'
  );
}

if (!s.includes('const [manifestFolders, setManifestFolders] = useState<ManifestFolder[]>([])')) {
  s = s.replace(
    '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});',
    '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n  const [manifestFolders, setManifestFolders] = useState<ManifestFolder[]>([]);'
  );
}

if (!s.includes('const liveManifestFolders = useMemo(() =>')) {
  s = s.replace(
    '  const personalFiles = useMemo(() => files.filter((file) => !companyFileByKey.has(keyFor(file)) && !companyFileByKey.has(file.hash)), [files, companyFileByKey]);',
    '  const liveManifestFolders = useMemo(() => (Array.isArray(manifestFolders) ? manifestFolders.filter((folder) => folder?.name && folder?.folderId) : []), [manifestFolders]);\n  const manifestFolderNames = useMemo(() => new Set(liveManifestFolders.map((folder) => String(folder.name || ""))), [liveManifestFolders]);\n  const manifestFolderByAnyId = useMemo(() => {\n    const map = new Map<string, ManifestFolder>();\n    for (const folder of liveManifestFolders) {\n      for (const id of folderIds(folder)) map.set(id, folder);\n    }\n    return map;\n  }, [liveManifestFolders]);\n  const personalFolderForFile = (file: P2PFile) => {\n    const rawId = folderProp(file, "parentFolderId") || folderProp(file, "folderId");\n    const byId = rawId ? manifestFolderByAnyId.get(rawId) : null;\n    if (byId?.name) return byId.name;\n    const rawName = folderProp(file, "folderName") || folderProp(file, "folder") || String(fileFolders[file.hash] || "").trim();\n    return rawName && manifestFolderNames.has(rawName) ? rawName : UNCATEGORIZED;\n  };\n  const folderTargetByName = (folderName: string) => liveManifestFolders.find((folder) => folder.name === folderName) || null;\n  const personalFiles = useMemo(() => files.filter((file) => !companyFileByKey.has(keyFor(file)) && !companyFileByKey.has(file.hash)), [files, companyFileByKey]);'
  );
}

const oldFoldersBlock = `  const folders = useMemo(() => {
    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];
    const personalFileKeys = new Set(personalFiles.map((file) => file.hash));
    const personalFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith("personal:folder:") || personalFileKeys.has(key)).map(([, folder]) => folder).filter(Boolean);
    const companyPrefix = activeWorkspace ? \`company:\${activeWorkspace.workspaceId}:folder:\` : "company:none:folder:";
    const companyFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith(companyPrefix)).map(([, folder]) => folder).filter(Boolean);
    const sourceFolders = view === "company" || view === "admin" ? [...workspaceFolders, ...companyFolders] : personalFolders;
    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];
  }, [fileFolders, activeWorkspace, personalFiles, view]);`;
const newFoldersBlock = `  const folders = useMemo(() => {
    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];
    const companyPrefix = activeWorkspace ? \`company:\${activeWorkspace.workspaceId}:folder:\` : "company:none:folder:";
    const companyFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith(companyPrefix)).map(([, folder]) => folder).filter(Boolean);
    const personalFolders = liveManifestFolders.map((folder) => folder.name).filter(Boolean);
    const sourceFolders = view === "company" || view === "admin" ? [...workspaceFolders, ...companyFolders] : personalFolders;
    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];
  }, [fileFolders, activeWorkspace, liveManifestFolders, view]);`;
if (s.includes(oldFoldersBlock)) s = s.replace(oldFoldersBlock, newFoldersBlock);

s = s.replace(
  '      const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;\n      const displayName = cf?.name || file.name;',
  '      const folder = cf?.folder || personalFolderForFile(file);\n      const displayName = cf?.name || file.name;'
);

s = s.replace(
  '    const [nextSummary, nextFiles, nextWallet, nextCompany] = await Promise.all([\n      api.invoke<Summary>("p2p:networkSummary"),\n      api.invoke<P2PFile[]>("p2p:listFiles", { query: search }),\n      api.invoke<WalletState>("wallet:status"),\n      api.invoke<CompanyState>("company:state"),\n    ]);\n    setSummary(nextSummary);\n    setFiles(Array.isArray(nextFiles) ? nextFiles : []);\n    setWallet(nextWallet);\n    setCompany(nextCompany);',
  '    const [nextSummary, nextFiles, nextFolders, nextWallet, nextCompany] = await Promise.all([\n      api.invoke<Summary>("p2p:networkSummary"),\n      api.invoke<P2PFile[]>("p2p:listFiles", { query: search }),\n      api.invoke<ManifestFolder[]>("p2p:listFolders").catch(() => [] as ManifestFolder[]),\n      api.invoke<WalletState>("wallet:status"),\n      api.invoke<CompanyState>("company:state"),\n    ]);\n    setSummary(nextSummary);\n    setFiles(Array.isArray(nextFiles) ? nextFiles : []);\n    setManifestFolders(Array.isArray(nextFolders) ? nextFolders : []);\n    setWallet(nextWallet);\n    setCompany(nextCompany);'
);

s = s.replace(
  '      const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;\n    const role = match?.workspace.members.find((m) => m.deviceId === deviceId)?.role;',
  '    const folder = cf?.folder || personalFolderForFile(file);\n    const role = match?.workspace.members.find((m) => m.deviceId === deviceId)?.role;'
);

s = s.replace(
  '              else setFileFolders((current) => ({ ...current, [file.hash]: nextFolder }));',
  '              else {\n                const targetFolder = nextFolder ? folderTargetByName(nextFolder) : null;\n                if (nextFolder && !targetFolder) { toast.error("Target folder not found"); return; }\n                void api.invoke("p2p:moveItem", { itemId: itemIdFor(file), targetFolderId: targetFolder ? targetFolder.folderId : "" })\n                  .then(() => refresh())\n                  .catch((error) => toast.error(err(error)));\n              }'
);

s = s.replace(
  '  useEffect(() => {\n    localStorage.setItem(folderStorageKey, JSON.stringify(fileFolders));\n  }, [fileFolders, folderStorageKey]);',
  '  useEffect(() => {\n    const cleaned = Object.fromEntries(Object.entries(fileFolders).filter(([key, folder]) => {\n      if (key.startsWith("personal:folder:")) return false;\n      if (String(folder || "") && !manifestFolderNames.has(String(folder))) return false;\n      return true;\n    }));\n    localStorage.setItem(folderStorageKey, JSON.stringify(cleaned));\n  }, [fileFolders, folderStorageKey, manifestFolderNames]);'
);

if (s !== before) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[live-file-classification-manifest] per-file classification now uses p2p manifest folders');
} else {
  console.log('[live-file-classification-manifest] already patched or markers not found');
}
