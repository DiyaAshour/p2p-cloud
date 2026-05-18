const fs = require('node:fs');
const path = require('node:path');

const p = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(p)) {
  console.warn('[live-bulk-file-move] NativeP2PAppLive.tsx not found');
  process.exit(0);
}

let s = fs.readFileSync(p, 'utf8');
const before = s;

if (!s.includes('| "p2p:moveItem"')) {
  s = s.replace('  | "p2p:prepareProof"', '  | "p2p:moveItem"\n  | "p2p:prepareProof"');
}

if (!s.includes('function itemIdFor(file: P2PFile)')) {
  s = s.replace(
    'function keyFor(file: P2PFile) {\n  return file.rootHash || file.hash;\n}',
    'function keyFor(file: P2PFile) {\n  return file.rootHash || file.hash;\n}\nfunction itemIdFor(file: P2PFile) {\n  return file.id || file.rootHash || file.hash;\n}'
  );
}

if (!s.includes('const [bulkTargetFolder, setBulkTargetFolder] = useState(UNCATEGORIZED);')) {
  s = s.replace(
    '  const [activeFolder, setActiveFolder] = useState(ALL_FILES);',
    '  const [activeFolder, setActiveFolder] = useState(ALL_FILES);\n  const [bulkTargetFolder, setBulkTargetFolder] = useState(UNCATEGORIZED);\n  const [selectedFileKeys, setSelectedFileKeys] = useState<Record<string, boolean>>({});'
  );
}

if (!s.includes('const selectedFiles = useMemo(() =>')) {
  const visibleBlockPattern = /  const visibleFiles = useMemo\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]+\]\);/;
  const match = s.match(visibleBlockPattern);
  if (match) {
    const insert = `${match[0]}\n  const selectedFiles = useMemo(() => visibleFiles.filter((file) => selectedFileKeys[keyFor(file)]), [visibleFiles, selectedFileKeys]);`;
    s = s.replace(match[0], insert);
  } else {
    console.warn('[live-bulk-file-move] visibleFiles block not found');
  }
}

if (!s.includes('const toggleFileSelected = (file: P2PFile) =>')) {
  const anchor = '  const share = (file: P2PFile) => {\n    const link = `chunknet://file/${file.rootHash || file.hash}`;\n    void navigator.clipboard.writeText(link).then(() => toast.success("Share link copied"));\n  };';
  const helpers = `${anchor}\n  const toggleFileSelected = (file: P2PFile) => {\n    const key = keyFor(file);\n    setSelectedFileKeys((current) => ({ ...current, [key]: !current[key] }));\n  };\n  const selectAllVisibleFiles = () => {\n    setSelectedFileKeys((current) => {\n      const next = { ...current };\n      for (const file of visibleFiles) next[keyFor(file)] = true;\n      return next;\n    });\n  };\n  const clearSelectedFiles = () => setSelectedFileKeys({});\n  const moveSelectedFiles = () => run(async () => {\n    if (!selectedFiles.length) throw new Error("Select at least one file");\n    const targetName = bulkTargetFolder === UNCATEGORIZED ? "" : bulkTargetFolder;\n    const targetFolder = targetName ? folderTargetByName(targetName) : null;\n    if (targetName && !targetFolder) throw new Error("Target folder not found in manifest");\n    const targetFolderId = targetFolder ? String(targetFolder.folderId || targetFolder.id || "") : "";\n    for (const file of selectedFiles) {\n      const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);\n      if (match) {\n        await api.invoke("company:updateFile", { workspaceId: match.workspace.workspaceId, rootHash: match.companyFile.rootHash, patch: { folder: targetName } });\n      } else {\n        await api.invoke("p2p:moveItem", { itemId: itemIdFor(file), targetFolderId });\n      }\n    }\n    const movedCount = selectedFiles.length;\n    clearSelectedFiles();\n    await refresh();\n    toast.success(targetName ? `Moved ${movedCount} file(s) to ${targetName}` : `Moved ${movedCount} file(s) to Uncategorized`);\n  });`;
  if (s.includes(anchor)) s = s.replace(anchor, helpers);
  else console.warn('[live-bulk-file-move] share function anchor not found');
}

if (!s.includes('Bulk select row')) {
  s = s.replace(
    '        <CardContent className="space-y-4 p-5">\n          <div className="flex h-24 items-center justify-center rounded-2xl bg-zinc-950"><FileCheck2 className="size-10" /></div>',
    '        <CardContent className="space-y-4 p-5">\n          <div className="flex items-center justify-between gap-2" aria-label="Bulk select row">\n            <label className="flex items-center gap-2 text-xs text-zinc-400">\n              <Checkbox checked={Boolean(selectedFileKeys[keyFor(file)])} onCheckedChange={() => toggleFileSelected(file)} />\n              Select\n            </label>\n            {selectedFileKeys[keyFor(file)] && <Badge variant="outline" className="text-[10px]">selected</Badge>}\n          </div>\n          <div className="flex h-24 items-center justify-center rounded-2xl bg-zinc-950"><FileCheck2 className="size-10" /></div>'
  );
}

if (!s.includes('Move selected files manifest toolbar')) {
  s = s.replace(
    '              <div className="relative">\n                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />\n                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files, folders, company, hash" className="pl-9" />\n              </div>\n              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">',
    '              <div className="relative">\n                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />\n                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files, folders, company, hash" className="pl-9" />\n              </div>\n              <Card className="rounded-2xl border-zinc-800 bg-zinc-900" aria-label="Move selected files manifest toolbar">\n                <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">\n                  <div className="text-sm text-zinc-400"><span className="font-medium text-zinc-100">{selectedFiles.length}</span> file(s) selected</div>\n                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">\n                    <select value={bulkTargetFolder} onChange={(event) => setBulkTargetFolder(event.target.value)} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">\n                      <option>{UNCATEGORIZED}</option>\n                      {folders.filter((folderName) => folderName !== ALL_FILES && folderName !== UNCATEGORIZED).map((folderName) => <option key={folderName}>{folderName}</option>)}\n                    </select>\n                    <Button variant="outline" size="sm" onClick={selectAllVisibleFiles} disabled={busy || visibleFiles.length === 0}>Select visible</Button>\n                    <Button variant="outline" size="sm" onClick={clearSelectedFiles} disabled={busy || selectedFiles.length === 0}>Clear</Button>\n                    <Button size="sm" onClick={moveSelectedFiles} disabled={busy || selectedFiles.length === 0}>Move selected</Button>\n                  </div>\n                </CardContent>\n              </Card>\n              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">'
  );
}

if (s !== before) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[live-bulk-file-move] selected files can now move through manifests in one action');
} else {
  console.log('[live-bulk-file-move] already patched or markers not found');
}
