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

if (!s.includes('final logged-out folder guard')) {
  patch(
    /(  const folders = useMemo\(\(\) => \{\r?\n)/,
    '$1    // final logged-out folder guard\n    if (!walletConnected && view !== "company" && view !== "admin") return [ALL_FILES, UNCATEGORIZED];\n',
    'folders memo'
  );
}

if (!s.includes('final folder state clear guard')) {
  const addedAfterWorkspaceEffect = patch(
    /(  useEffect\(\(\) => \{\r?\n    localStorage\.setItem\(ACTIVE_WORKSPACE_KEY, JSON\.stringify\(activeWorkspace\?\.workspaceId \|\| ""\)\);\r?\n  \}, \[activeWorkspace\?\.workspaceId\]\);\r?\n)/,
    '$1\n  // final folder state clear guard\n  useEffect(() => {\n    if (!walletConnected) {\n      setFileFolders({});\n      setFolderParents({});\n      setActiveFolder(ALL_FILES);\n    }\n  }, [walletConnected]);\n',
    ''
  );
  if (!addedAfterWorkspaceEffect) {
    insertBefore(
      /  const run = async \(work: \(\) => Promise<void>\) => \{\r?\n/,
      '  // final folder state clear guard\n  useEffect(() => {\n    if (!walletConnected) {\n      setFileFolders({});\n      setFolderParents({});\n      setActiveFolder(ALL_FILES);\n    }\n  }, [walletConnected]);\n\n',
      'insert guard before run'
    );
  }
}

// Repair a previously injected guard that referenced folderStorageKey in restored UI variants.
s = s.replace(/\}, \[walletConnected, folderStorageKey\]\);/g, '}, [walletConnected]);');

if (!s.includes('const [fileFolders, setFileFolders]')) {
  console.error('[patch-live-folder-final-guard] failed to inject fileFolders state');
  process.exit(1);
}
if (!s.includes('const [folderParents, setFolderParents]')) {
  console.error('[patch-live-folder-final-guard] failed to inject folderParents state');
  process.exit(1);
}

fs.writeFileSync(file, s, 'utf8');
console.log(changed ? '[patch-live-folder-final-guard] installed final folder guard' : '[patch-live-folder-final-guard] already applied');
