const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'client', 'src', 'NativeP2PApp.tsx');
let src = fs.readFileSync(file, 'utf8');

const oldPreview = '  const previewImage = (file: P2PFile) => runBusy(async () => { if (!isImageFile(file)) return; const password = file.isEncrypted ? getDrivePassword() : null; const result = await bridge.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword: password }); if (previewUrl) URL.revokeObjectURL(previewUrl); const blob = new Blob([new Uint8Array(result.bytes)], { type: result.file.mimeType || "image/*" }); setPreviewUrl(URL.createObjectURL(blob)); setPreviewName(result.file.name); });';

const newPreview = '  const previewImage = (file: P2PFile) => runBusy(async () => { if (!isImageFile(file)) return; if (file.size > 25 * 1024 * 1024) { toast.info("Large image preview is disabled. Use Download to save it safely."); await downloadFile(file); return; } const password = file.isEncrypted ? getDrivePassword() : null; const result = await bridge.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword: password }); if (previewUrl) URL.revokeObjectURL(previewUrl); const blob = new Blob([new Uint8Array(result.bytes)], { type: result.file.mimeType || "image/*" }); setPreviewUrl(URL.createObjectURL(blob)); setPreviewName(result.file.name); });';

if (src.includes(newPreview)) {
  console.log('[fix-large-preview] already applied');
  process.exit(0);
}

if (!src.includes(oldPreview)) {
  const start = src.indexOf('  const previewImage = (file: P2PFile) => runBusy(async () => {');
  const end = src.indexOf('  const closePreview = () =>', start);
  if (start === -1 || end === -1) {
    throw new Error('Could not find previewImage block');
  }
  src = src.slice(0, start) + newPreview + '\n' + src.slice(end);
} else {
  src = src.replace(oldPreview, newPreview);
}

fs.writeFileSync(file, src, 'utf8');
console.log('[fix-large-preview] patched client/src/NativeP2PApp.tsx');
