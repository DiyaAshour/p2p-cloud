const fs = require('node:fs');
const path = require('node:path');

const p = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(p)) {
  console.warn('[live-manifest-folder-source] NativeP2PAppLive.tsx not found');
  process.exit(0);
}

let s = fs.readFileSync(p, 'utf8');
const before = s;

if (!s.includes('| "p2p:listFolders"')) {
  s = s.replace('  | "p2p:listFiles"', '  | "p2p:listFiles"\n  | "p2p:listFolders"');
}

if (!s.includes('type ManifestFolder =')) {
  s = s.replace(
    'type P2PFile = { id?: string; name: string; size: number; hash: string; rootHash: string; uploadedAt: string; isEncrypted: boolean; totalChunks: number; ownerWallet?: string; replicas?: string[]; replicationStatus?: string; protectedChunks?: number; needsRepairChunks?: number };',
    'type P2PFile = { id?: string; name: string; size: number; hash: string; rootHash: string; uploadedAt: string; isEncrypted: boolean; totalChunks: number; ownerWallet?: string; replicas?: string[]; replicationStatus?: string; protectedChunks?: number; needsRepairChunks?: number; folderId?: string; parentFolderId?: string; folderName?: string; folder?: string };\ntype ManifestFolder = { id?: string; name: string; folderId?: string; parentFolderId?: string | null; hash?: string; rootHash?: string; kind?: string; isFolder?: boolean };'
  );
}

if (!s.includes('const [manifestFolders, setManifestFolders] = useState<ManifestFolder[]>([])')) {
  s = s.replace(
    '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});',
    '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n  const [manifestFolders, setManifestFolders] = useState<ManifestFolder[]>([]);'
  );
}

const oldFolderBlock = `  const folders = useMemo(() => {
    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];
    const personalFileKeys = new Set(personalFiles.map((file) => file.hash));
    const personalFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith("personal:folder:") || personalFileKeys.has(key)).map(([, folder]) => folder).filter(Boolean);
    const companyPrefix = activeWorkspace ? \`company:\${activeWorkspace.workspaceId}:folder:\` : "company:none:folder:";
    const companyFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith(companyPrefix)).map(([, folder]) => folder).filter(Boolean);
    const sourceFolders = view === "company" || view === "admin" ? [...workspaceFolders, ...companyFolders] : personalFolders;
    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];
  }, [fileFolders, activeWorkspace, personalFiles, view]);`;

const newFolderBlock = `  const liveManifestFolders = useMemo(() => (Array.isArray(manifestFolders) ? manifestFolders.filter((folder) => folder?.name && folder?.folderId) : []), [manifestFolders]);
  const manifestFolderNames = useMemo(() => new Set(liveManifestFolders.map((folder) => String(folder.name || ""))), [liveManifestFolders]);
  const manifestFolderById = useMemo(() => {
    const map = new Map<string, ManifestFolder>();
    for (const folder of liveManifestFolders) {
      for (const id of [folder.folderId, folder.id, folder.hash, folder.rootHash]) {
        if (id) map.set(String(id), folder);
      }
    }
    return map;
  }, [liveManifestFolders]);
  const personalFolderForFile = (file: P2PFile) => {
    const rawId = String(file.parentFolderId || file.folderId || "").trim();
    const byId = rawId ? manifestFolderById.get(rawId) : null;
    if (byId?.name) return byId.name;
    const rawName = String(file.folderName || file.folder || fileFolders[file.hash] || "").trim();
    return rawName && manifestFolderNames.has(rawName) ? rawName : UNCATEGORIZED;
  };
  const folders = useMemo(() => {
    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];
    const companyPrefix = activeWorkspace ? \`company:\${activeWorkspace.workspaceId}:folder:\` : "company:none:folder:";
    const companyFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith(companyPrefix)).map(([, folder]) => folder).filter(Boolean);
    const personalFolders = liveManifestFolders.map((folder) => folder.name).filter(Boolean);
    const sourceFolders = view === "company" || view === "admin" ? [...workspaceFolders, ...companyFolders] : personalFolders;
    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];
  }, [fileFolders, activeWorkspace, liveManifestFolders, view]);`;

if (s.includes(oldFolderBlock)) s = s.replace(oldFolderBlock, newFolderBlock);
else if (!s.includes('const liveManifestFolders = useMemo')) console.warn('[live-manifest-folder-source] folders useMemo block not found');

s = s.replace(
  '      const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;\n      const displayName = cf?.name || file.name;',
  '      const folder = cf?.folder || personalFolderForFile(file);\n      const displayName = cf?.name || file.name;'
);

s = s.replace(
  '    const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;\n    const role = match?.workspace.members.find((m) => m.deviceId === deviceId)?.role;',
  '    const folder = cf?.folder || personalFolderForFile(file);\n    const role = match?.workspace.members.find((m) => m.deviceId === deviceId)?.role;'
);

const oldRefresh = `    const [nextSummary, nextFiles, nextWallet, nextCompany] = await Promise.all([
      api.invoke<Summary>("p2p:networkSummary"),
      api.invoke<P2PFile[]>("p2p:listFiles", { query: search }),
      api.invoke<WalletState>("wallet:status"),
      api.invoke<CompanyState>("company:state"),
    ]);
    setSummary(nextSummary);
    setFiles(Array.isArray(nextFiles) ? nextFiles : []);
    setWallet(nextWallet);
    setCompany(nextCompany);`;
const newRefresh = `    const [nextSummary, nextFiles, nextFolders, nextWallet, nextCompany] = await Promise.all([
      api.invoke<Summary>("p2p:networkSummary"),
      api.invoke<P2PFile[]>("p2p:listFiles", { query: search }),
      api.invoke<ManifestFolder[]>("p2p:listFolders").catch(() => [] as ManifestFolder[]),
      api.invoke<WalletState>("wallet:status"),
      api.invoke<CompanyState>("company:state"),
    ]);
    setSummary(nextSummary);
    setFiles(Array.isArray(nextFiles) ? nextFiles : []);
    setManifestFolders(Array.isArray(nextFolders) ? nextFolders : []);
    setWallet(nextWallet);
    setCompany(nextCompany);`;
if (s.includes(oldRefresh)) s = s.replace(oldRefresh, newRefresh);
else if (!s.includes('setManifestFolders(Array.isArray(nextFolders)')) console.warn('[live-manifest-folder-source] refresh block not found');

// Prevent old localStorage folder labels from creating personal folders forever.
s = s.replace(
  '  useEffect(() => {\n    localStorage.setItem(folderStorageKey, JSON.stringify(fileFolders));\n  }, [fileFolders, folderStorageKey]);',
  '  useEffect(() => {\n    const cleaned = Object.fromEntries(Object.entries(fileFolders).filter(([key, folder]) => {\n      if (key.startsWith("personal:folder:")) return false;\n      if (String(folder || "") && !manifestFolderNames.has(String(folder))) return false;\n      return true;\n    }));\n    localStorage.setItem(folderStorageKey, JSON.stringify(cleaned));\n  }, [fileFolders, folderStorageKey, manifestFolderNames]);'
);

if (s !== before) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[live-manifest-folder-source] personal folders now come from manifest folders only');
} else {
  console.log('[live-manifest-folder-source] already patched');
}
