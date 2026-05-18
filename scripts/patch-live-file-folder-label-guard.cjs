const fs = require('node:fs');
const path = require('node:path');

const p = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(p)) {
  console.warn('[live-file-folder-label-guard] NativeP2PAppLive.tsx not found');
  process.exit(0);
}

let s = fs.readFileSync(p, 'utf8');
const before = s;

if (!s.includes('| "p2p:listFolders"')) {
  s = s.replace('  | "p2p:listFiles"', '  | "p2p:listFiles"\n  | "p2p:listFolders"');
}

if (!s.includes('type ManifestFolder =')) {
  s = s.replace(
    'type View = "personal" | "company" | "shared" | "admin";',
    'type ManifestFolder = { id?: string; name: string; folderId?: string; parentFolderId?: string | null; hash?: string; rootHash?: string; kind?: string; isFolder?: boolean };\ntype View = "personal" | "company" | "shared" | "admin";'
  );
}

if (!s.includes('const [manifestFolders, setManifestFolders] = useState<ManifestFolder[]>([])')) {
  s = s.replace(
    '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});',
    '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n  const [manifestFolders, setManifestFolders] = useState<ManifestFolder[]>([]);'
  );
}

if (!s.includes('function folderProp(file: P2PFile, key: string)')) {
  const anchor = 'function protection(file: P2PFile) {';
  const helpers = `function folderProp(file: P2PFile, key: string) {\n  return String((file as unknown as Record<string, unknown>)?.[key] || "").trim();\n}\nfunction folderIds(folder: ManifestFolder) {\n  return [folder.folderId, folder.id, folder.hash, folder.rootHash].filter(Boolean).map((value) => String(value));\n}\n`;
  s = s.replace(anchor, helpers + anchor);
}

if (!s.includes('const liveManifestFolders = useMemo(() =>')) {
  s = s.replace(
    '  const personalFiles = useMemo(() => files.filter((file) => !companyFileByKey.has(keyFor(file)) && !companyFileByKey.has(file.hash)), [files, companyFileByKey]);',
    '  const liveManifestFolders = useMemo(() => (Array.isArray(manifestFolders) ? manifestFolders.filter((folder) => folder?.name && folder?.folderId) : []), [manifestFolders]);\n  const manifestFolderNames = useMemo(() => new Set(liveManifestFolders.map((folder) => String(folder.name || ""))), [liveManifestFolders]);\n  const manifestFolderByAnyId = useMemo(() => {\n    const map = new Map<string, ManifestFolder>();\n    for (const folder of liveManifestFolders) for (const id of folderIds(folder)) map.set(id, folder);\n    return map;\n  }, [liveManifestFolders]);\n  const personalFolderForFile = (file: P2PFile) => {\n    const rawId = folderProp(file, "parentFolderId") || folderProp(file, "folderId");\n    const byId = rawId ? manifestFolderByAnyId.get(rawId) : null;\n    if (byId?.name) return byId.name;\n    const rawName = folderProp(file, "folderName") || folderProp(file, "folder") || String(fileFolders[file.hash] || "").trim();\n    return rawName && manifestFolderNames.has(rawName) ? rawName : UNCATEGORIZED;\n  };\n  const personalFiles = useMemo(() => files.filter((file) => !companyFileByKey.has(keyFor(file)) && !companyFileByKey.has(file.hash)), [files, companyFileByKey]);'
  );
}

// Force personal folder list to come only from live manifest folders.
s = s.replace(
  /const personalFileKeys = new Set\(personalFiles\.map\(\(file\) => file\.hash\)\);\r?\n    const personalFolders = Object\.entries\(fileFolders\)\.filter\(\(\[key\]\) => key\.startsWith\("personal:folder:"\) \|\| personalFileKeys\.has\(key\)\)\.map\(\(\[, folder\]\) => folder\)\.filter\(Boolean\);/,
  'const personalFolders = liveManifestFolders.map((folder) => folder.name).filter(Boolean);'
);

s = s.replace(
  '  }, [fileFolders, activeWorkspace, personalFiles, view]);',
  '  }, [fileFolders, activeWorkspace, liveManifestFolders, view]);'
);

// Guard all known render/filter folder label expressions.
s = s.replaceAll(
  'const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;',
  'const folder = cf?.folder || personalFolderForFile(file);'
);
s = s.replaceAll(
  'const folder = cf?.folder || fileFolders[file.rootHash] || fileFolders[file.hash] || UNCATEGORIZED;',
  'const folder = cf?.folder || personalFolderForFile(file);'
);

// Load live manifest folders independently even if refresh Promise shape was not patched.
if (!s.includes('[live-folder-label-guard]')) {
  const effectAnchor = '  useEffect(() => {\n    setFileFolders(readJson(folderStorageKey, {}));\n    setActiveFolder(ALL_FILES);\n  }, [folderStorageKey]);';
  const injected = `${effectAnchor}\n  useEffect(() => {\n    if (!api || !wallet?.connected) { setManifestFolders([]); return; }\n    void api.invoke<ManifestFolder[]>("p2p:listFolders")\n      .then((next) => setManifestFolders(Array.isArray(next) ? next : []))\n      .catch(() => setManifestFolders([]));\n    console.info("[live-folder-label-guard] refreshed manifest folder labels");\n  }, [api, wallet?.connected, files.length]);`;
  s = s.replace(effectAnchor, injected);
}

// Keep localStorage from preserving deleted personal folders.
s = s.replace(
  '  useEffect(() => {\n    localStorage.setItem(folderStorageKey, JSON.stringify(fileFolders));\n  }, [fileFolders, folderStorageKey]);',
  '  useEffect(() => {\n    const cleaned = Object.fromEntries(Object.entries(fileFolders).filter(([key, folder]) => {\n      if (key.startsWith("personal:folder:")) return false;\n      if (String(folder || "") && !manifestFolderNames.has(String(folder))) return false;\n      return true;\n    }));\n    localStorage.setItem(folderStorageKey, JSON.stringify(cleaned));\n  }, [fileFolders, folderStorageKey, manifestFolderNames]);'
);

if (s !== before) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[live-file-folder-label-guard] deleted folder labels now render as Uncategorized');
} else {
  console.log('[live-file-folder-label-guard] already patched');
}
