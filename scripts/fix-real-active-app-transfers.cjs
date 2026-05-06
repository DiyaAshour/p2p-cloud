const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();

function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function write(rel, src) { fs.writeFileSync(path.join(root, rel), src, 'utf8'); console.log(`[active-transfer-fix] patched ${rel}`); }

function replaceFunction(src, functionName, nextFunctionName, replacement, rel) {
  const start = src.indexOf(`  const ${functionName} =`);
  const end = src.indexOf(`\n  const ${nextFunctionName} =`, start + 1);
  if (start === -1 || end === -1) {
    console.log(`[active-transfer-fix] ${rel}: ${functionName} not found`);
    return src;
  }
  return src.slice(0, start) + replacement + src.slice(end);
}

function ensureChannelTypes(src) {
  if (!src.includes('"p2p:uploadPath"')) src = src.replace('"p2p:upload" |', '"p2p:upload" | "p2p:uploadPath" |');
  if (!src.includes('"p2p:downloadToPath"')) src = src.replace('"p2p:download" |', '"p2p:download" | "p2p:downloadToPath" |');
  if (!src.includes('"system:pickFiles"')) src = src.replace('"electron:diagnostics";', '"electron:diagnostics" | "system:pickFiles";');
  return src;
}

function ensureTypes(src) {
  if (!src.includes('type DownloadToPathResult')) {
    src = src.replace('type DownloadResult = { ok: boolean; file: P2PFile; bytes: number[] };', 'type DownloadResult = { ok: boolean; file: P2PFile; bytes: number[]; savedToPath?: string | null; canceled?: boolean };\ntype DownloadToPathResult = { ok: boolean; canceled?: boolean; path?: string };\ntype NativePickedFile = { path: string; name: string; size: number; mimeType?: string };');
  }
  if (!src.includes('const LARGE_PREVIEW_LIMIT_BYTES')) {
    src = src.replace('const FILE_FOLDERS_KEY = "peercloud.ui.fileFolders";', 'const FILE_FOLDERS_KEY = "peercloud.ui.fileFolders";\nconst LARGE_PREVIEW_LIMIT_BYTES = 25 * 1024 * 1024;');
  }
  return src;
}

function patchNative() {
  const rel = 'client/src/NativeP2PApp.tsx';
  if (!fs.existsSync(path.join(root, rel))) return;
  let src = read(rel);
  src = ensureChannelTypes(src);
  src = ensureTypes(src);

  if (!src.includes('nativeSelectedFiles')) {
    src = src.replace('  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);', '  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);\n  const [nativeSelectedFiles, setNativeSelectedFiles] = useState<NativePickedFile[]>([]);');
    src = src.replace('const selectedBytes = useMemo(() => selectedFiles.reduce((sum, file) => sum + file.size, 0), [selectedFiles]);', 'const selectedBytes = useMemo(() => selectedFiles.reduce((sum, file) => sum + file.size, 0) + nativeSelectedFiles.reduce((sum, file) => sum + file.size, 0), [selectedFiles, nativeSelectedFiles]);');
  }

  const picker = '  const pickNativeFiles = () => runBusy(async () => {\n' +
    '    if (!walletConnected) throw new Error("Connect your wallet before uploading");\n' +
    '    const result = await bridge.invoke<{ ok: boolean; files: NativePickedFile[] }>("system:pickFiles");\n' +
    '    const picked = Array.isArray(result.files) ? result.files : [];\n' +
    '    if (!picked.length) return;\n' +
    '    setNativeSelectedFiles((current) => [...current, ...picked]);\n' +
    '    setSelectedFiles([]);\n' +
    '    toast.success(`${picked.length} file(s) ready to upload`);\n' +
    '  });\n\n' +
    '  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => { event.target.value = ""; void pickNativeFiles(); };\n';
  src = replaceFunction(src, 'handleFileSelect', 'addDroppedFiles', picker, rel);

  if (src.includes('const addDroppedFiles = (incoming: File[]) =>')) {
    src = src.replace(/  const addDroppedFiles = \(incoming: File\[\]\) => \{[\s\S]*?\};\n/, '  const addDroppedFiles = (_incoming: File[]) => {\n    toast.info("Use Choose files so Chunknet can stream from disk without freezing.");\n    void pickNativeFiles();\n  };\n');
  }

  const upload = '  const uploadFiles = () => runBusy(async () => {\n' +
    '    if (!walletConnected) throw new Error("Connect your wallet before uploading");\n' +
    '    if (uploadWouldExceedQuota) throw new Error("Storage quota exceeded. Upgrade your plan.");\n' +
    '    if (!nativeSelectedFiles.length && !selectedFiles.length) throw new Error("Select at least one file");\n' +
    '    const password = getDrivePassword();\n' +
    '    const targetFolder = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : "";\n' +
    '    const uploadedHashes: string[] = [];\n\n' +
    '    for (const file of nativeSelectedFiles) {\n' +
    '      const result = await bridge.invoke<{ file?: P2PFile }>("p2p:uploadPath", {\n' +
    '        path: file.path,\n' +
    '        name: file.name,\n' +
    '        mimeType: file.mimeType || "application/octet-stream",\n' +
    '        isEncrypted,\n' +
    '        drivePassword: password,\n' +
    '      });\n' +
    '      if (result?.file?.hash) uploadedHashes.push(result.file.hash);\n' +
    '    }\n\n' +
    '    for (const file of selectedFiles) {\n' +
    '      if (file.size > LARGE_PREVIEW_LIMIT_BYTES) throw new Error("Large browser-file upload blocked. Use Choose files so Chunknet can stream from disk safely.");\n' +
    '      const result = await bridge.invoke<{ file?: P2PFile }>("p2p:upload", { name: file.name, mimeType: file.type || "application/octet-stream", isEncrypted, drivePassword: password, bytes: await file.arrayBuffer() });\n' +
    '      if (result?.file?.hash) uploadedHashes.push(result.file.hash);\n' +
    '    }\n\n' +
    '    if (targetFolder && uploadedHashes.length) setFileFolders((current) => ({ ...current, ...Object.fromEntries(uploadedHashes.map((hash) => [hash, targetFolder])) }));\n' +
    '    setSelectedFiles([]);\n' +
    '    setNativeSelectedFiles([]);\n' +
    '    toast.success("Files stored safely");\n' +
    '    await refreshAll();\n' +
    '  });\n';
  src = replaceFunction(src, 'uploadFiles', 'downloadFile', upload, rel);

  const download = '  const downloadFile = (file: P2PFile) => runBusy(async () => {\n' +
    '    const password = file.isEncrypted ? getDrivePassword() : null;\n' +
    '    const result = await bridge.invoke<DownloadToPathResult>("p2p:downloadToPath", { hash: file.hash, drivePassword: password });\n' +
    '    if (!result.canceled) toast.success("Download saved to disk");\n' +
    '  });\n';
  src = replaceFunction(src, 'downloadFile', 'previewImage', download, rel);

  const preview = '  const previewImage = (file: P2PFile) => runBusy(async () => {\n' +
    '    if (!isImageFile(file)) return;\n' +
    '    if (file.size > LARGE_PREVIEW_LIMIT_BYTES) { await downloadFile(file); return; }\n' +
    '    const password = file.isEncrypted ? getDrivePassword() : null;\n' +
    '    const result = await bridge.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword: password });\n' +
    '    if (result.savedToPath || result.canceled) return;\n' +
    '    if (previewUrl) URL.revokeObjectURL(previewUrl);\n' +
    '    const blob = new Blob([new Uint8Array(result.bytes)], { type: result.file.mimeType || "image/*" });\n' +
    '    setPreviewUrl(URL.createObjectURL(blob));\n' +
    '    setPreviewName(result.file.name);\n' +
    '  });\n';
  src = replaceFunction(src, 'previewImage', 'closePreview', preview, rel);

  src = src.replace(/<Input type="file" multiple onChange=\{handleFileSelect\} disabled=\{!walletConnected \|\| busy\} \/>/g, '<Button type="button" variant="outline" onClick={pickNativeFiles} disabled={!walletConnected || busy}>Choose files</Button><Input type="file" multiple onChange={handleFileSelect} disabled={!walletConnected || busy} className="hidden" />');
  src = src.replaceAll('selectedFiles.length > 0', '(selectedFiles.length + nativeSelectedFiles.length) > 0');
  src = src.replaceAll('{selectedFiles.length} file(s)', '{selectedFiles.length + nativeSelectedFiles.length} file(s)');
  src = src.replace(/disabled=\{busy \|\| !walletConnected \|\| selectedFiles\.length === 0 \|\| uploadWouldExceedQuota\}/g, 'disabled={busy || !walletConnected || (selectedFiles.length === 0 && nativeSelectedFiles.length === 0) || uploadWouldExceedQuota}');
  src = src.replaceAll('onClick={() => downloadFile(file)}', 'onClick={(event) => { event.stopPropagation(); void downloadFile(file); }}');
  src = src.replaceAll('onClick={() => previewImage(file)}', 'onClick={(event) => { event.stopPropagation(); void previewImage(file); }}');

  write(rel, src);
}

function patchPreload() {
  const rel = 'electron/preload.cjs';
  let src = read(rel);
  for (const channel of ['p2p:pauseTransfer', 'p2p:resumeTransfer', 'p2p:cancelTransfer']) {
    if (!src.includes(`'${channel}'`)) src = src.replace("  'p2p:networkSummary',\n", `  'p2p:networkSummary',\n  '${channel}',\n`);
  }
  write(rel, src);
}

patchNative();
patchPreload();
console.log('[active-transfer-fix] done');
