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

  const picker = `  const pickNativeFiles = () => runBusy(async () => {
    if (!walletConnected) throw new Error("Connect your wallet before uploading");
    const result = await bridge.invoke<{ ok: boolean; files: NativePickedFile[] }>("system:pickFiles");
    const picked = Array.isArray(result.files) ? result.files : [];
    if (!picked.length) return;
    setNativeSelectedFiles((current) => [...current, ...picked]);
    setSelectedFiles([]);
    toast.success(\`${picked.length} file(s) ready to upload\`);
  });

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => { event.target.value = ""; void pickNativeFiles(); };
`;
  src = replaceFunction(src, 'handleFileSelect', 'addDroppedFiles', picker, rel);

  if (src.includes('const addDroppedFiles = (incoming: File[]) =>')) {
    src = src.replace(/  const addDroppedFiles = \(incoming: File\[\]\) => \{[\s\S]*?\};\n/, `  const addDroppedFiles = (_incoming: File[]) => {
    toast.info("Use Choose files so Chunknet can stream from disk without freezing.");
    void pickNativeFiles();
  };
`);
  }

  const upload = `  const uploadFiles = () => runBusy(async () => {
    if (!walletConnected) throw new Error("Connect your wallet before uploading");
    if (uploadWouldExceedQuota) throw new Error("Storage quota exceeded. Upgrade your plan.");
    if (!nativeSelectedFiles.length && !selectedFiles.length) throw new Error("Select at least one file");
    const password = getDrivePassword();
    const targetFolder = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : "";
    const uploadedHashes: string[] = [];

    for (const file of nativeSelectedFiles) {
      const result = await bridge.invoke<{ file?: P2PFile }>("p2p:uploadPath", {
        path: file.path,
        name: file.name,
        mimeType: file.mimeType || "application/octet-stream",
        isEncrypted,
        drivePassword: password,
      });
      if (result?.file?.hash) uploadedHashes.push(result.file.hash);
    }

    for (const file of selectedFiles) {
      if (file.size > LARGE_PREVIEW_LIMIT_BYTES) throw new Error("Large browser-file upload blocked. Use Choose files so Chunknet can stream from disk safely.");
      const result = await bridge.invoke<{ file?: P2PFile }>("p2p:upload", { name: file.name, mimeType: file.type || "application/octet-stream", isEncrypted, drivePassword: password, bytes: await file.arrayBuffer() });
      if (result?.file?.hash) uploadedHashes.push(result.file.hash);
    }

    if (targetFolder && uploadedHashes.length) setFileFolders((current) => ({ ...current, ...Object.fromEntries(uploadedHashes.map((hash) => [hash, targetFolder])) }));
    setSelectedFiles([]);
    setNativeSelectedFiles([]);
    toast.success("Files stored safely");
    await refreshAll();
  });
`;
  src = replaceFunction(src, 'uploadFiles', 'downloadFile', upload, rel);

  const download = `  const downloadFile = (file: P2PFile) => runBusy(async () => {
    const password = file.isEncrypted ? getDrivePassword() : null;
    const result = await bridge.invoke<DownloadToPathResult>("p2p:downloadToPath", { hash: file.hash, drivePassword: password });
    if (!result.canceled) toast.success("Download saved to disk");
  });
`;
  src = replaceFunction(src, 'downloadFile', 'previewImage', download, rel);

  const preview = `  const previewImage = (file: P2PFile) => runBusy(async () => {
    if (!isImageFile(file)) return;
    if (file.size > LARGE_PREVIEW_LIMIT_BYTES) { await downloadFile(file); return; }
    const password = file.isEncrypted ? getDrivePassword() : null;
    const result = await bridge.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword: password });
    if (result.savedToPath || result.canceled) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const blob = new Blob([new Uint8Array(result.bytes)], { type: result.file.mimeType || "image/*" });
    setPreviewUrl(URL.createObjectURL(blob));
    setPreviewName(result.file.name);
  });
`;
  src = replaceFunction(src, 'previewImage', 'closePreview', preview, rel);

  src = src.replace(/<Input type="file" multiple onChange=\{handleFileSelect\} disabled=\{!walletConnected \|\| busy\} \/>/g, '<Button type="button" variant="outline" onClick={pickNativeFiles} disabled={!walletConnected || busy}>Choose files</Button><Input type="file" multiple onChange={handleFileSelect} disabled={!walletConnected || busy} className="hidden" />');
  src = src.replaceAll('selectedFiles.length > 0', '(selectedFiles.length + nativeSelectedFiles.length) > 0');
  src = src.replaceAll('{selectedFiles.length} file(s)', '{selectedFiles.length + nativeSelectedFiles.length} file(s)');
  src = src.replace(/disabled=\{busy \|\| !walletConnected \|\| selectedFiles\.length === 0 \|\| uploadWouldExceedQuota\}/g, 'disabled={busy || !walletConnected || (selectedFiles.length === 0 && nativeSelectedFiles.length === 0) || uploadWouldExceedQuota}');
  src = src.replaceAll('onClick={() => downloadFile(file)}', 'onClick={(event) => { event.stopPropagation(); void downloadFile(file); }}');
  src = src.replaceAll('onClick={() => previewImage(file)}', 'onClick={(event) => { event.stopPropagation(); void previewImage(file); }}');

  write(rel, src);
}

function patchDrive() {
  const rel = 'client/src/DriveP2PApp.tsx';
  if (!fs.existsSync(path.join(root, rel))) return;
  let src = read(rel);
  // Direct Drive file is already patched in repo, but force click bubbling and no legacy blob download.
  src = src.replaceAll('onClick={() => downloadFile(file)}', 'onClick={(event) => { event.stopPropagation(); void downloadFile(file); }}');
  src = src.replaceAll('onClick={() => downloadFile(previewFile)}', 'onClick={(event) => { event.stopPropagation(); void downloadFile(previewFile); }}');
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
patchDrive();
patchPreload();
console.log('[active-transfer-fix] done');
