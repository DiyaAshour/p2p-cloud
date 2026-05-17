const fs = require('node:fs');

const p = 'client/src/NativeP2PAppLive.tsx';
if (!fs.existsSync(p)) {
  console.warn('[patch-live-folder-identity-clear] NativeP2PAppLive not found');
  process.exit(0);
}

let s = fs.readFileSync(p, 'utf8');
let changed = false;

function replace(from, to, label) {
  if (s.includes(from)) {
    s = s.replace(from, to);
    changed = true;
  } else if (label) {
    console.warn('[patch-live-folder-identity-clear] marker not found:', label);
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

// Ensure folder parent state exists for network folder tree actions.
replace(
  '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => readJson(ACTIVE_WORKSPACE_KEY, ""));',
  '  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});\n  const [folderParents, setFolderParents] = useState<Record<string, string>>({});\n  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => readJson(ACTIVE_WORKSPACE_KEY, ""));',
  'folderParents state'
);

// Never let stale personal folders render while logged out. This is the hard UI guard.
insertAfter(
  '  const folders = useMemo(() => {\n',
  '    if (!walletConnected && view !== "company" && view !== "admin") return [ALL_FILES, UNCATEGORIZED];\n',
  'folders logged-out guard'
);

// Old localStorage loader must not keep folders from the previous identity.
replace(
  '  useEffect(() => {\n    setFileFolders(readJson(folderStorageKey, {}));\n    setActiveFolder(ALL_FILES);\n  }, [folderStorageKey]);\n  useEffect(() => {\n    localStorage.setItem(folderStorageKey, JSON.stringify(fileFolders));\n  }, [fileFolders, folderStorageKey]);',
  '  useEffect(() => {\n    setFileFolders({});\n    setFolderParents({});\n    setActiveFolder(ALL_FILES);\n  }, [folderStorageKey]);',
  'replace localStorage folder persistence'
);

// If the previous patch already removed localStorage, still force clear on identity key change.
replace(
  '  useEffect(() => {\n    setActiveFolder(ALL_FILES);\n  }, [folderStorageKey]);',
  '  useEffect(() => {\n    setFileFolders({});\n    setFolderParents({});\n    setActiveFolder(ALL_FILES);\n  }, [folderStorageKey]);',
  'clear on folderStorageKey change'
);

// Add an independent logout guard. Even if refresh is slow, folders disappear immediately.
if (!s.includes('logout folder state guard')) {
  replace(
    '  useEffect(() => {\n    localStorage.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify(activeWorkspace?.workspaceId || ""));\n  }, [activeWorkspace?.workspaceId]);',
    '  useEffect(() => {\n    localStorage.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify(activeWorkspace?.workspaceId || ""));\n  }, [activeWorkspace?.workspaceId]);\n\n  // logout folder state guard\n  useEffect(() => {\n    if (!walletConnected) {\n      setFileFolders({});\n      setFolderParents({});\n      setActiveFolder(ALL_FILES);\n    }\n  }, [walletConnected, folderStorageKey]);',
    'logout independent guard'
  );
}

// Clear immediately on disconnect before async refresh finishes.
replace(
  '  const disconnectWallet = () => run(async () => {\n    setWallet(await api.invoke<WalletState>("wallet:disconnect"));\n    await refresh();\n  });',
  '  const disconnectWallet = () => run(async () => {\n    setFileFolders({});\n    setFolderParents({});\n    setActiveFolder(ALL_FILES);\n    setWallet(await api.invoke<WalletState>("wallet:disconnect"));\n    await refresh();\n  });',
  'disconnectWallet clear folders'
);

// Clear when refresh reports no authenticated identity.
replace(
  '    } else {\n      setFileFolders({});\n      setFolderParents({});\n    }\n    if (!activeWorkspaceId && nextCompany.workspaces?.[0]?.workspaceId) setActiveWorkspaceId(nextCompany.workspaces[0].workspaceId);',
  '    } else {\n      setFileFolders({});\n      setFolderParents({});\n      setActiveFolder(ALL_FILES);\n    }\n    if (!activeWorkspaceId && nextCompany.workspaces?.[0]?.workspaceId) setActiveWorkspaceId(nextCompany.workspaces[0].workspaceId);',
  'refresh unauthenticated clear active folder'
);

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-live-folder-identity-clear] folders hidden when logged out and cleared on identity switch');
} else {
  console.log('[patch-live-folder-identity-clear] already applied');
}
