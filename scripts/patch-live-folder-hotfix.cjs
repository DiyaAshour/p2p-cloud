const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(file)) process.exit(0);
let s = fs.readFileSync(file, 'utf8');
const before = s;

function addAfter(marker, text) {
  if (s.includes(text.trim().slice(0, 50))) return;
  if (s.includes(marker)) s = s.replace(marker, marker + text);
}

addAfter('const FILE_FOLDERS_KEY = "chunknet.ui.fileFolders";\n', 'const FOLDER_PARENTS_KEY = "chunknet.ui.folderParents";\n');
addAfter(
  '  const [fileFolders, setFileFolders] = useState<Record<string, string>>(() => readJson<Record<string, string>>(FILE_FOLDERS_KEY, {}));\n',
  '  const [folderParents, setFolderParents] = useState<Record<string, string>>(() => readJson<Record<string, string>>(FOLDER_PARENTS_KEY, {}));\n'
);
addAfter(
  '  useEffect(() => { localStorage.setItem(FILE_FOLDERS_KEY, JSON.stringify(fileFolders)); }, [fileFolders]);\n',
  '  useEffect(() => { localStorage.setItem(FOLDER_PARENTS_KEY, JSON.stringify(folderParents)); }, [folderParents]);\n'
);

if (!s.includes('const folderDepth = (folder: string) =>')) {
  const helpers = `  const folderPath = (folder: string) => {
    if (folder === ALL_FILES || folder === UNCATEGORIZED) return folder;
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor = folder;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      chain.unshift(cursor);
      cursor = folderParents[cursor] || "";
    }
    return chain.join(" / ") || folder;
  };
  const folderDepth = (folder: string) => {
    let depth = 0;
    const seen = new Set<string>();
    let cursor = folderParents[folder] || "";
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      cursor = folderParents[cursor] || "";
    }
    return depth;
  };
  const orderedFolders = useMemo(() => {
    const names = [...folders];
    const childrenOf = (parent: string) => names.filter((folder) => (folderParents[folder] || "") === parent).sort((a, b) => a.localeCompare(b));
    const result: string[] = [];
    const walk = (parent: string) => {
      for (const child of childrenOf(parent)) {
        result.push(child);
        walk(child);
      }
    };
    walk("");
    for (const orphan of names.sort((a, b) => a.localeCompare(b))) if (!result.includes(orphan)) result.push(orphan);
    return result;
  }, [folders, folderParents]);
`;
  const marker = '  const safetyPeerEnabled = Boolean(summary?.safetyPeerUrl);\n';
  if (s.includes(marker)) s = s.replace(marker, helpers + marker);
}

s = s.replace(
  '  const folderList = useMemo(() => [ALL_FILES, UNCATEGORIZED, ...folders], [folders]);',
  '  const folderList = useMemo(() => [ALL_FILES, UNCATEGORIZED, ...orderedFolders], [orderedFolders]);'
);

if (s !== before) {
  fs.writeFileSync(file, s, 'utf8');
  console.log('[patch-live-folder-hotfix] ensured live folder helpers.');
} else {
  console.log('[patch-live-folder-hotfix] no changes needed.');
}
