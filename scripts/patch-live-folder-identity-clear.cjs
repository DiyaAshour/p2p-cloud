const fs = require('node:fs');

const p = 'client/src/NativeP2PAppLive.tsx';
if (!fs.existsSync(p)) {
  console.warn('[patch-live-folder-identity-clear] NativeP2PAppLive not found');
  process.exit(0);
}

let s = fs.readFileSync(p, 'utf8');
let changed = false;

function replaceText(from, to, label) {
  if (s.includes(from)) {
    s = s.replace(from, to);
    changed = true;
  } else if (label) {
    console.warn('[patch-live-folder-identity-clear] marker not found:', label);
  }
}
function replaceRegex(regex, to, label) {
  if (regex.test(s)) {
    s = s.replace(regex, to);
    changed = true;
  } else if (label) {
    console.warn('[patch-live-folder-identity-clear] regex not found:', label);
  }
}
function insertAfter(anchor, addition, label) {
  if (s.includes(addition.trim())) return;
  if (s.includes(anchor)) {
    s = s.replace(anchor, anchor + addition);
    changed = true;
  } else if (label) {
    console.warn('[patch-live-folder-identity-clear] marker not found:', label);
  }
}

// 1) Ensure network folder parent state exists.
replaceText(
  '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => readJson(ACTIVE_WORKSPACE_KEY, ""));',
  '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n  const [folderParents, setFolderParents] = useState<Record<string, string>>({});\n  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => readJson(ACTIVE_WORKSPACE_KEY, ""));',
  'folderParents state'
);

// 2) Hard replace the folders memo. This prevents stale personal folders from rendering when logged out,
// regardless of old localStorage or stale React state.
replaceRegex(
  /  const folders = useMemo\(\(\) => \{[\s\S]*?  \}, \[fileFolders, activeWorkspace, personalFiles, view\]\);/,
  `  const folders = useMemo(() => {
    if (!walletConnected && view !== "company" && view !== "admin") return [ALL_FILES, UNCATEGORIZED];
    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];
    const personalFileKeys = new Set(personalFiles.map((file) => file.hash));
    const personalFolders = walletConnected ? Object.entries(fileFolders).filter(([key]) => key.startsWith("personal:folder:") || personalFileKeys.has(key)).map(([, folder]) => folder).filter(Boolean) : [];
    const networkFolders = walletConnected ? Object.keys(folderParents).filter(Boolean) : [];
    const companyPrefix = activeWorkspace ? \`company:\${activeWorkspace.workspaceId}:folder:\` : "company:none:folder:";
    const companyFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith(companyPrefix)).map(([, folder]) => folder).filter(Boolean);
    const sourceFolders = view === "company" || view === "admin" ? [...workspaceFolders, ...companyFolders] : [...personalFolders, ...networkFolders];
    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];
  }, [fileFolders, folderParents, activeWorkspace, personalFiles, view, walletConnected]);`,
  'folders memo hard replace'
);

// 3) Replace old localStorage folder loader/persister with identity clear.
replaceRegex(
  /  useEffect\(\(\) => \{\n    setFileFolders\(readJson\(folderStorageKey, \{\}\)\);\n    setActiveFolder\(ALL_FILES\);\n  \}, \[folderStorageKey\]\);\n  useEffect\(\(\) => \{\n    localStorage\.setItem\(folderStorageKey, JSON\.stringify\(fileFolders\)\);\n  \}, \[fileFolders, folderStorageKey\]\);/,
  `  useEffect(() => {
    setFileFolders({});
    setFolderParents({});
    setActiveFolder(ALL_FILES);
  }, [folderStorageKey]);`,
  'remove localStorage folder loader'
);
replaceText(
  '  useEffect(() => {\n    setActiveFolder(ALL_FILES);\n  }, [folderStorageKey]);',
  '  useEffect(() => {\n    setFileFolders({});\n    setFolderParents({});\n    setActiveFolder(ALL_FILES);\n  }, [folderStorageKey]);',
  'clear on folderStorageKey change'
);

// 4) Add an independent runtime guard after active workspace persistence.
if (!s.includes('logout folder state guard')) {
  insertAfter(
    '  useEffect(() => {\n    localStorage.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify(activeWorkspace?.workspaceId || ""));\n  }, [activeWorkspace?.workspaceId]);',
    `

  // logout folder state guard
  useEffect(() => {
    if (!walletConnected) {
      setFileFolders({});
      setFolderParents({});
      setActiveFolder(ALL_FILES);
    }
  }, [walletConnected, folderStorageKey]);`,
    'logout independent guard'
  );
}

// 5) Clear immediately on disconnect before async refresh finishes.
replaceRegex(
  /  const disconnectWallet = \(\) => run\(async \(\) => \{\n[\s\S]*?    await refresh\(\);\n  \}\);/,
  `  const disconnectWallet = () => run(async () => {
    setFileFolders({});
    setFolderParents({});
    setActiveFolder(ALL_FILES);
    setWallet(await api.invoke<WalletState>("wallet:disconnect"));
    await refresh();
  });`,
  'disconnectWallet clear folders'
);

// 6) If refresh has already been patched to branch on nextWallet.connected, make sure unauthenticated branch resets active folder.
replaceText(
  '    } else {\n      setFileFolders({});\n      setFolderParents({});\n    }\n    if (!activeWorkspaceId && nextCompany.workspaces?.[0]?.workspaceId) setActiveWorkspaceId(nextCompany.workspaces[0].workspaceId);',
  '    } else {\n      setFileFolders({});\n      setFolderParents({});\n      setActiveFolder(ALL_FILES);\n    }\n    if (!activeWorkspaceId && nextCompany.workspaces?.[0]?.workspaceId) setActiveWorkspaceId(nextCompany.workspaces[0].workspaceId);',
  'refresh unauthenticated clear active folder'
);

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-live-folder-identity-clear] forced stale folders hidden when logged out');
} else {
  console.log('[patch-live-folder-identity-clear] already applied');
}
