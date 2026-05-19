const fs = require('node:fs');

function patch(file, fn) {
  if (!fs.existsSync(file)) {
    console.log(`[folder-cards-empty] skip missing ${file}`);
    return;
  }

  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);

  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8');
    console.log(`[folder-cards-empty] patched ${file}`);
  } else {
    console.log(`[folder-cards-empty] ok ${file}`);
  }
}

function insertBefore(source, marker, guard, block) {
  if (source.includes(guard)) return source;
  const index = source.indexOf(marker);
  if (index < 0) throw new Error(`Marker not found: ${marker}`);
  return source.slice(0, index) + block.trim() + '\n\n' + source.slice(index);
}

function replaceOnce(source, search, replacement) {
  const index = source.indexOf(search);
  if (index < 0) throw new Error(`Search block not found: ${search.slice(0, 80)}`);
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

patch('electron/main-stable.js', (source) => {
  let s = source;

  const directoriesHelper = `
function walkUploadFolderDirectories(dir) {
  const dirs = [dir];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      dirs.push(...walkUploadFolderDirectories(fullPath));
    }
  }

  return dirs;
}
`;

  s = insertBefore(
    s,
    'async function ensureUploadFolderManifest(',
    'function walkUploadFolderDirectories(',
    directoriesHelper
  );

  const guard = 'for (const dirPath of walkUploadFolderDirectories(rootDir))';
  if (!s.includes(guard)) {
    const marker = `  if (baseParentFolderId && !findFolderById(baseParentFolderId)) {\n    throw new Error('Target parent folder not found');\n  }\n\n`;
    const insertion = `${marker}  // Persist the selected root folder and all nested directories, even if some are empty.\n  for (const dirPath of walkUploadFolderDirectories(rootDir)) {\n    await ensureUploadFolderManifest(rootDir, dirPath, baseParentFolderId, pathToFolderId);\n  }\n\n`;
    s = s.replace(marker, insertion);
  }

  return s;
});

patch('client/src/NativeP2PAppLive.tsx', (source) => {
  let s = source;

  const visibleFoldersBlock = `
  const visibleFolders = useMemo(() => {
    if (view !== "personal") return [];

    const q = search.trim().toLowerCase();

    return manifestFolders.filter((folder) => {
      const parentFolderId = String(folder.parentFolderId || "");

      const locationOk =
        activeFolder === ALL_FILES
          ? parentFolderId === ""
          : activeFolder === UNCATEGORIZED
            ? false
            : activeFolderId
              ? parentFolderId === activeFolderId
              : false;

      const queryOk =
        !q ||
        [folder.name, folder.folderId, folderPath(folder)].some((value) =>
          String(value || "").toLowerCase().includes(q)
        );

      return locationOk && queryOk;
    });
  }, [view, manifestFolders, activeFolder, activeFolderId, search, folderById]);
`;

  s = insertBefore(
    s,
    '  const companyBytes = companyFiles.reduce',
    'const visibleFolders = useMemo(() =>',
    visibleFoldersBlock
  );

  const folderCardBlock = `
const openFolder = (folder: DriveFolder) => {
  setActiveFolder(folderPath(folder));
  setActiveFolderId(folder.folderId);

  setExpandedFolderIds((prev) => {
    const next = new Set(prev);
    let cursor: DriveFolder | undefined = folder;

    while (cursor) {
      if (cursor.folderId) next.add(cursor.folderId);
      cursor = cursor.parentFolderId ? folderById.get(cursor.parentFolderId) : undefined;
    }

    return next;
  });
};

const descendantFolderIdsFor = (folder: DriveFolder) => {
  const ids = new Set<string>([folder.folderId]);
  const stack = [folder.folderId];

  while (stack.length) {
    const current = stack.pop() || "";
    const children = folderChildren.get(current) || [];

    for (const child of children) {
      if (!ids.has(child.folderId)) {
        ids.add(child.folderId);
        stack.push(child.folderId);
      }
    }
  }

  return ids;
};

const folderStatsFor = (folder: DriveFolder) => {
  const ids = descendantFolderIdsFor(folder);
  const folderFiles = personalFiles.filter((file) => ids.has(getPersonalFileFolderId(file)));
  const totalBytes = folderFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
  const totalChunks = folderFiles.reduce((sum, file) => sum + Number(file.totalChunks || 0), 0);
  const protectedChunks = folderFiles.reduce(
    (sum, file) => sum + Number(file.protectedChunks ?? (file.replicationStatus === "protected" ? file.totalChunks : 0) || 0),
    0
  );
  const needsRepair = folderFiles.some((file) => file.replicationStatus === "needs-repair");

  const label =
    folderFiles.length === 0
      ? "Empty folder"
      : totalChunks <= 0
        ? "No chunks"
        : needsRepair
          ? "Needs repair"
          : protectedChunks >= totalChunks
            ? "Protected"
            : "Protecting";

  const tone =
    label === "Protected"
      ? "text-emerald-300"
      : label === "Needs repair"
        ? "text-amber-300"
        : label === "Protecting"
          ? "text-blue-300"
          : "text-zinc-400";

  return { folderFiles, totalBytes, totalChunks, protectedChunks, label, tone };
};

const renderFolderCard = (folder: DriveFolder) => {
  const stats = folderStatsFor(folder);
  const children = folderChildren.get(folder.folderId) || [];

  return (
    <Card
      key={`folder:${folder.folderId}`}
      onDoubleClick={() => openFolder(folder)}
      className="cursor-pointer rounded-2xl border-zinc-800 bg-zinc-900 transition-all hover:border-blue-500/50 hover:bg-zinc-900/80"
    >
      <CardContent className="space-y-4 p-5">
        <div className="flex h-20 items-center justify-center rounded-2xl bg-zinc-950">
          <FolderOpen className="size-10 text-blue-400" />
        </div>

        <div>
          <p className="truncate text-sm font-semibold">{folder.name}</p>
          <p className="text-xs text-zinc-400">
            {stats.folderFiles.length} file(s) · {children.length} folder(s) · {bytes(stats.totalBytes)}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            <FolderOpen className="mr-1 inline size-3" />
            {folderPath(folder) || folder.name}
          </p>

          <div className="mt-2 flex flex-wrap gap-1">
            <Badge variant="outline" className={`text-xs ${stats.tone}`}>
              <ShieldCheck className="mr-1 size-3" />
              {stats.label}
            </Badge>
          </div>

          <p className="mt-1 text-xs text-zinc-600">
            {stats.totalChunks > 0 ? `${stats.protectedChunks}/${stats.totalChunks} chunks` : "0/0 chunks"}
          </p>
        </div>

        <div className="flex flex-wrap gap-1">
          <Button size="sm" onClick={() => openFolder(folder)} disabled={busy} className="text-xs">
            Open
          </Button>

          <Button variant="outline" size="sm" onClick={() => renameFolder(folder)} disabled={busy} className="text-xs">
            <Pencil className="size-3" />
            Rename
          </Button>

          <Button variant="outline" size="sm" onClick={() => moveFolder(folder)} disabled={busy} className="text-xs">
            <MoveRight className="size-3" />
            Move
          </Button>

          <Button variant="destructive" size="sm" onClick={() => deleteFolder(folder)} disabled={busy} className="text-xs">
            <Trash2 className="size-3" />
            Delete
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
`;

  s = insertBefore(
    s,
    '  const renderFileCard = (file: P2PFile) =>',
    'const renderFolderCard = (folder: DriveFolder) =>',
    folderCardBlock
  );

  if (!s.includes('visibleFolders.map((folder) => renderFolderCard(folder))')) {
    s = replaceOnce(
      s,
      'personalFiles.length === 0 ? (',
      '(personalFiles.length === 0 && visibleFolders.length === 0) ? ('
    );

    s = replaceOnce(
      s,
      'visibleFiles.length > 0 ? (',
      '(visibleFolders.length > 0 || visibleFiles.length > 0) ? ('
    );

    s = replaceOnce(
      s,
      '{visibleFiles.map((file) => renderFileCard(file))}',
      '{visibleFolders.map((folder) => renderFolderCard(folder))}\n                  {visibleFiles.map((file) => renderFileCard(file))}'
    );
  }

  return s;
});

console.log('[folder-cards-empty] complete');
