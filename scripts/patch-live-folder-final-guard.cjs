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
  } else {
    console.warn('[patch-live-folder-final-guard] marker not found:', label);
  }
}

if (!s.includes('const [folderParents, setFolderParents]')) {
  patch(
    /(  const \[fileFolders, setFileFolders\] = useState<Record<string, string>>\(\{\}\);\r?\n)/,
    '$1  const [folderParents, setFolderParents] = useState<Record<string, string>>({});\n',
    'fileFolders state'
  );
}

if (!s.includes('final logged-out folder guard')) {
  patch(
    /(  const folders = useMemo\(\(\) => \{\r?\n)/,
    '$1    // final logged-out folder guard\n    if (!walletConnected && view !== "company" && view !== "admin") return [ALL_FILES, UNCATEGORIZED];\n',
    'folders memo'
  );
}

if (!s.includes('final folder state clear guard')) {
  patch(
    /(  useEffect\(\(\) => \{\r?\n    localStorage\.setItem\(ACTIVE_WORKSPACE_KEY, JSON\.stringify\(activeWorkspace\?\.workspaceId \|\| ""\)\);\r?\n  \}, \[activeWorkspace\?\.workspaceId\]\);\r?\n)/,
    '$1\n  // final folder state clear guard\n  useEffect(() => {\n    if (!walletConnected) {\n      setFileFolders({});\n      setFolderParents({});\n      setActiveFolder(ALL_FILES);\n    }\n  }, [walletConnected, folderStorageKey]);\n',
    'active workspace effect'
  );
}

if (!s.includes('const [folderParents, setFolderParents]')) {
  console.error('[patch-live-folder-final-guard] failed to inject folderParents state');
  process.exit(1);
}

fs.writeFileSync(file, s, 'utf8');
console.log(changed ? '[patch-live-folder-final-guard] installed final folder guard' : '[patch-live-folder-final-guard] already applied');
