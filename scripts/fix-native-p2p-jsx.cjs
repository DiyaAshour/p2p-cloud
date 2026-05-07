const fs = require('node:fs');

const file = 'client/src/NativeP2PApp.tsx';
let src = fs.readFileSync(file, 'utf8');
const before = src;

src = src.replace(
  '{visibleFiles.map((file) => <Card ',
  '{visibleFiles.map((file) => (<Card '
);

src = src.replace(
  '</Card>)}</div>{visibleFiles.length === 0 &&',
  '</Card>))}</div>{visibleFiles.length === 0 &&'
);

src = src.replace(
  'type P2PChannel = "p2p:start" | "p2p:listFiles" | "p2p:upload" | "p2p:download"',
  'type P2PChannel = "p2p:start" | "p2p:listFiles" | "p2p:upload" | "p2p:uploadFiles" | "p2p:download"'
);

src = src.replace(
  'type DownloadResult = { ok: boolean; file: P2PFile; bytes: number[] };',
  'type DownloadResult = { ok: boolean; file: P2PFile; savedPath?: string; cancelled?: boolean };'
);

src = src.replace(
  /const uploadFiles = \(\) => runBusy\(async \(\) => \{[\s\S]*?toast\.success\("Files stored safely"\); await refreshAll\(\); \}\);/,
  () => 'const uploadFiles = () => runBusy(async () => { if (!walletConnected) throw new Error("Connect your wallet before uploading"); if (uploadWouldExceedQuota) throw new Error("Storage quota exceeded. Upgrade your plan."); const password = getDrivePassword(); const targetFolder = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : ""; const result = await bridge.invoke<{ ok?: boolean; cancelled?: boolean; files?: P2PFile[] }>("p2p:uploadFiles", { folderPath: targetFolder, isEncrypted, drivePassword: password }); if (result?.cancelled) return; const uploadedHashes = Array.isArray(result?.files) ? result.files.map((file) => file.hash).filter(Boolean) : []; if (targetFolder && uploadedHashes.length) setFileFolders((current) => ({ ...current, ...Object.fromEntries(uploadedHashes.map((hash) => [hash, targetFolder])) })); setSelectedFiles([]); toast.success(`Files stored safely${uploadedHashes.length ? `: ${uploadedHashes.length}` : ""}`); await refreshAll(); });'
);

src = src.replace(
  /const downloadFile = \(file: P2PFile\) => runBusy\(async \(\) => \{[\s\S]*?toast\.success\("Download verified"\); \}\);/,
  () => 'const downloadFile = (file: P2PFile) => runBusy(async () => { const password = file.isEncrypted ? getDrivePassword() : null; const result = await bridge.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword: password }); if (result?.cancelled) return; toast.success(result?.savedPath ? `Download complete: ${result.savedPath}` : "Download complete"); });'
);

src = src.replace(
  /const previewImage = \(file: P2PFile\) => runBusy\(async \(\) => \{[\s\S]*?setPreviewName\(result\.file\.name\); \}\);/,
  () => 'const previewImage = (_file: P2PFile) => runBusy(async () => { toast.info("Preview for encrypted large files is disabled in RAM-safe mode. Use Download to save the file safely."); });'
);

const forbidden = [
  'await file.arrayBuffer()',
  'bytes: await',
  'new Uint8Array(result.bytes)',
  'result.bytes',
];
for (const token of forbidden) {
  if (src.includes(token)) throw new Error(`[fix-native-p2p-jsx] NativeP2PApp still contains RAM-unsafe token: ${token}`);
}

if (src === before) {
  console.log('No NativeP2PApp patch needed. File already looks patched.');
} else {
  fs.writeFileSync(file, src, 'utf8');
  console.log('Patched NativeP2PApp JSX and RAM-safe upload/download UI.');
}
