const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const rel = path.join('client', 'src', 'DriveP2PApp.tsx');
const file = path.join(root, rel);
if (!fs.existsSync(file)) {
  console.log('[fix-drive-mode] DriveP2PApp.tsx not found; skipping');
  process.exit(0);
}

let src = fs.readFileSync(file, 'utf8');

function replaceBlock(startNeedle, endNeedle, replacement, label) {
  const start = src.indexOf(startNeedle);
  const end = src.indexOf(endNeedle, start);
  if (start === -1 || end === -1) {
    console.log(`[fix-drive-mode] ${label} not found; skipping`);
    return;
  }
  src = src.slice(0, start) + replacement + src.slice(end);
  console.log(`[fix-drive-mode] patched ${label}`);
}

// IPC channel typing.
if (!src.includes('| "p2p:uploadPath"')) {
  src = src.replace('  | "p2p:upload"\n', '  | "p2p:upload"\n  | "p2p:uploadPath"\n');
}
if (!src.includes('| "p2p:downloadToPath"')) {
  src = src.replace('  | "p2p:download"\n', '  | "p2p:download"\n  | "p2p:downloadToPath"\n');
}
if (!src.includes('| "system:pickFiles"')) {
  src = src.replace('  | "wallet:disconnect";', '  | "wallet:disconnect"\n  | "system:pickFiles";');
}

// Types.
if (!src.includes('type NativePickedFile')) {
  src = src.replace(
    'type DownloadResult = { ok: boolean; file: P2PFile; bytes: number[] };',
    'type DownloadResult = { ok: boolean; file: P2PFile; bytes: number[]; savedToPath?: string | null; canceled?: boolean };\ntype DownloadToPathResult = { ok: boolean; canceled?: boolean; path?: string };\ntype NativePickedFile = { path: string; name: string; size: number; mimeType?: string };'
  );
}

// State and selected bytes.
if (!src.includes('nativeSelectedFiles')) {
  src = src.replace(
    '  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);',
    '  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);\n  const [nativeSelectedFiles, setNativeSelectedFiles] = useState<NativePickedFile[]>([]);'
  );
  src = src.replace(
    '  const selectedBytes = useMemo(() => selectedFiles.reduce((sum, file) => sum + file.size, 0), [selectedFiles]);',
    '  const selectedBytes = useMemo(() => selectedFiles.reduce((sum, file) => sum + file.size, 0) + nativeSelectedFiles.reduce((sum, file) => sum + file.size, 0), [selectedFiles, nativeSelectedFiles]);'
  );
}

// Native picker: avoid browser File.arrayBuffer for large files.
replaceBlock(
  '  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) =>',
  '\n\n  const uploadFiles = () => runBusy(async () => {',
  `  const pickNativeFiles = () => runBusy(async () => {
    if (!walletConnected) throw new Error("Connect wallet before uploading");
    const result = await bridge.invoke<{ ok: boolean; files: NativePickedFile[] }>("system:pickFiles");
    const picked = Array.isArray(result.files) ? result.files : [];
    if (!picked.length) return;
    setNativeSelectedFiles((current) => [...current, ...picked]);
    toast.success(String(picked.length) + " file(s) ready to upload");
  });

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => { void pickNativeFiles(); event.target.value = ""; };
`,
  'native file picker'
);

// Upload via p2p:uploadPath for native picked files. Keep old small fallback only for any existing browser-selected File[] state.
replaceBlock(
  '  const uploadFiles = () => runBusy(async () => {',
  '\n\n  const downloadFile = (file: P2PFile) =>',
  `  const uploadFiles = () => runBusy(async () => {
    if (!walletConnected) throw new Error("Connect wallet before uploading");
    const password = requireDrivePassword();
    if (uploadWouldExceedQuota) throw new Error("Storage quota exceeded. Upgrade your plan.");
    if (!nativeSelectedFiles.length && !selectedFiles.length) throw new Error("Select at least one file");
    const uploadedCount = nativeSelectedFiles.length + selectedFiles.length;

    for (const file of nativeSelectedFiles) {
      await bridge.invoke("p2p:uploadPath", {
        path: file.path,
        name: joinPath(currentPath, file.name),
        mimeType: file.mimeType || "application/octet-stream",
        isEncrypted: true,
        drivePassword: password,
      });
    }

    for (const file of selectedFiles) {
      if (file.size > 25 * 1024 * 1024) throw new Error("Large browser-file upload blocked. Use Choose files again so Chunknet can stream from disk safely.");
      await bridge.invoke("p2p:upload", {
        name: joinPath(currentPath, file.name),
        mimeType: file.type || "application/octet-stream",
        isEncrypted: true,
        drivePassword: password,
        bytes: await file.arrayBuffer(),
      });
    }

    setSelectedFiles([]);
    setNativeSelectedFiles([]);
    toast.success(\`Uploaded \${uploadedCount} file(s) to \${currentPath || "My Drive"}\`);
    await refreshAll();
  });
`,
  'streaming uploadFiles'
);

// Download must save to disk. No Blob/anchor for main Download button.
replaceBlock(
  '  const downloadFile = (file: P2PFile) =>',
  '\n\n  const openPreview = (file: P2PFile) =>',
  `  const downloadFile = (file: P2PFile) => runBusy(async () => {
    const payload = file.isEncrypted ? { hash: file.hash, drivePassword: requireDrivePassword() } : { hash: file.hash };
    const result = await bridge.invoke<DownloadToPathResult>("p2p:downloadToPath", payload);
    if (!result.canceled) toast.success("Download saved to disk");
  });
`,
  'save-to-disk downloadFile'
);

// Preview only for small images; large or non-image routes to downloadFile and stops there.
replaceBlock(
  '  const openPreview = (file: P2PFile) =>',
  '\n\n  const deleteFile = (file: P2PFile) =>',
  `  const openPreview = (file: P2PFile) => runBusy(async () => {
    if (!isImageFile(file) || file.size > 25 * 1024 * 1024) {
      await downloadFile(file);
      return;
    }
    const payload = file.isEncrypted ? { hash: file.hash, drivePassword: requireDrivePassword() } : { hash: file.hash };
    const result = await bridge.invoke<DownloadResult>("p2p:download", payload);
    if (result.savedToPath || result.canceled) return;
    const blob = new Blob([new Uint8Array(result.bytes)], { type: result.file.mimeType || "image/*" });
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(blob));
    setPreviewFile(file);
  });
`,
  'safe openPreview'
);

// UI: use native picker button, hide browser file input, count both file arrays.
src = src.replace(
  '<Input type="file" multiple onChange={handleFileSelect} disabled={!walletConnected || busy} className="max-w-xs" />',
  '<Button type="button" variant="outline" onClick={pickNativeFiles} disabled={!walletConnected || busy}>Choose files</Button><Input type="file" multiple onChange={handleFileSelect} disabled={!walletConnected || busy} className="hidden" />'
);
src = src.replace(
  'disabled={busy || !walletConnected || selectedFiles.length === 0 || uploadWouldExceedQuota}',
  'disabled={busy || !walletConnected || (selectedFiles.length === 0 && nativeSelectedFiles.length === 0) || uploadWouldExceedQuota}'
);
src = src.replace(
  'Selected: {selectedFiles.length} file(s), {formatBytes(selectedBytes)}',
  'Selected: {selectedFiles.length + nativeSelectedFiles.length} file(s), {formatBytes(selectedBytes)}'
);

// Prevent click bubbling from Download/Delete buttons triggering card preview/open and causing two dialogs.
src = src.replaceAll('onClick={() => downloadFile(file)}', 'onClick={(event) => { event.stopPropagation(); void downloadFile(file); }}');
src = src.replaceAll('onClick={() => deleteFile(file)}', 'onClick={(event) => { event.stopPropagation(); void deleteFile(file); }}');
src = src.replaceAll('onClick={() => downloadFile(previewFile)}', 'onClick={(event) => { event.stopPropagation(); void downloadFile(previewFile); }}');

fs.writeFileSync(file, src, 'utf8');
console.log('[fix-drive-mode] done');
