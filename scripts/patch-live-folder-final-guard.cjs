const fs = require('node:fs');

const file = 'client/src/NativeP2PAppLive.tsx';
if (!fs.existsSync(file)) {
  console.warn('[patch-live-folder-final-guard] NativeP2PAppLive not found');
  process.exit(0);
}

let s = fs.readFileSync(file, 'utf8');
let changed = false;

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

// Keep IPC channel typing compatible with the final folder action.
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

// Seed auto-login may have accountId/username/fingerprint even when the old walletConnected boolean is false.
if (!s.includes('const folderIdentityReady =')) {
  patch(
    /(  const walletConnected = Boolean\([\s\S]*?\);\r?\n)/,
    '$1  const folderIdentityReady = Boolean(wallet?.connected || wallet?.accountId || wallet?.address || wallet?.username || wallet?.seedFingerprint);\n',
    'folderIdentityReady after walletConnected'
  );
}

if (!s.includes('final logged-out folder guard')) {
  patch(
    /(  const folders = useMemo\(\(\) => \{\r?\n)/,
    '$1    // final logged-out folder guard\n    if (!folderIdentityReady && view !== "company" && view !== "admin") return [ALL_FILES, UNCATEGORIZED];\n',
    'folders memo'
  );
}
// Repair older injected guards that used walletConnected.
s = s.replace('if (!walletConnected && view !== "company" && view !== "admin") return [ALL_FILES, UNCATEGORIZED];', 'if (!folderIdentityReady && view !== "company" && view !== "admin") return [ALL_FILES, UNCATEGORIZED];');

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
// Repair older injected guard dependencies/conditions.
s = s.replace(/if \(!walletConnected\) \{\n      setFileFolders\(\{\}\);\n      setFolderParents\(\{\}\);\n      setActiveFolder\(ALL_FILES\);\n    \}\n  \}, \[walletConnected\]\);/g, 'if (!folderIdentityReady) {\n      setFileFolders({});\n      setFolderParents({});\n      setActiveFolder(ALL_FILES);\n    }\n  }, [folderIdentityReady]);');

// Force New folder to work after verify-runtime-safety restores NativeP2PAppLive.
if (!s.includes('final network createFolder')) {
  patch(
    /  const createFolder = \(\) => \{[\s\S]*?\n  const upload =/,
    `  const createFolder = () => {
    // final network createFolder
    const folder = newFolder.trim();
    if (!folder || folder === ALL_FILES || folder === UNCATEGORIZED) return;
    if (!folderIdentityReady && view !== "company" && view !== "admin") {
      toast.error("Connect wallet or sign in before creating folders");
      return;
    }
    const key = (view === "company" || view === "admin") && activeWorkspace ? companyFolderKey(activeWorkspace.workspaceId, folder) : personalFolderKey(folder);
    const parent = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : "";
    const nextFolders = { ...fileFolders, [key]: folder };
    const nextParents = { ...folderParents, [folder]: parent };
    setFileFolders(nextFolders);
    setFolderParents(nextParents);
    setActiveFolder(folder);
    setNewFolder("");
    if (view === "personal") {
      const names = new Set<string>();
      for (const value of Object.values(nextFolders)) if (value && value !== ALL_FILES && value !== UNCATEGORIZED) names.add(value);
      for (const value of Object.keys(nextParents)) if (value && value !== ALL_FILES && value !== UNCATEGORIZED) names.add(value);
      const foldersPayload = Array.from(names).map((name) => ({ id: name, name, parentId: nextParents[name] || null, updatedAt: new Date().toISOString() }));
      void api.invoke("drive:saveFolders" as Channel, { folders: foldersPayload, fileFolders: nextFolders }).then(refresh).catch((error) => toast.error(err(error)));
    }
  };
  const upload =`,
    'createFolder final replace'
  );
}
// Repair older createFolder guard.
s = s.replace('if (!walletConnected && view !== "company" && view !== "admin") {\n      toast.error("Connect wallet or sign in before creating folders");', 'if (!folderIdentityReady && view !== "company" && view !== "admin") {\n      toast.error("Connect wallet or sign in before creating folders");');

// Repair a previously injected guard that referenced folderStorageKey in restored UI variants.
s = s.replace(/\}, \[walletConnected, folderStorageKey\]\);/g, '}, [folderIdentityReady]);');
s = s.replace(/\}, \[walletConnected\]\);/g, '}, [folderIdentityReady]);');

if (!s.includes('const [fileFolders, setFileFolders]')) {
  console.error('[patch-live-folder-final-guard] failed to inject fileFolders state');
  process.exit(1);
}
if (!s.includes('const [folderParents, setFolderParents]')) {
  console.error('[patch-live-folder-final-guard] failed to inject folderParents state');
  process.exit(1);
}
if (!s.includes('const folderIdentityReady =')) {
  console.error('[patch-live-folder-final-guard] failed to inject folderIdentityReady');
  process.exit(1);
}

fs.writeFileSync(file, s, 'utf8');
console.log(changed ? '[patch-live-folder-final-guard] installed final folder guard and createFolder' : '[patch-live-folder-final-guard] already applied');
