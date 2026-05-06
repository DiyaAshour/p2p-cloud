const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function write(rel, content) {
  fs.writeFileSync(path.join(root, rel), content, 'utf8');
  console.log(`[fix-download-paths] patched ${rel}`);
}

function stopLegacyBlobAfterSaveToPath(src) {
  const patterns = [
    'const result = await bridge.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword: password }); if (previewUrl) URL.revokeObjectURL(previewUrl); const blob =',
    'const result = await bridge.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword: password }); const blob =',
    'const result = await bridge.invoke<DownloadResult>("p2p:download", payload);\n    const blob =',
  ];
  for (const pattern of patterns) {
    if (!src.includes(pattern)) continue;
    const replacement = pattern.replace('const blob =', 'if ((result as any).savedToPath || (result as any).canceled) return; const blob =');
    src = src.replaceAll(pattern, replacement);
  }
  return src;
}

function patchNativeP2PApp() {
  const rel = 'client/src/NativeP2PApp.tsx';
  let src = read(rel);

  if (!src.includes('"p2p:downloadToPath"')) src = src.replace('"p2p:download" |', '"p2p:download" | "p2p:downloadToPath" |');
  if (!src.includes('type DownloadToPathResult')) {
    src = src.replace('type DownloadResult = { ok: boolean; file: P2PFile; bytes: number[] };', 'type DownloadResult = { ok: boolean; file: P2PFile; bytes: number[] };\ntype DownloadToPathResult = { ok: boolean; canceled?: boolean; path?: string };');
  }

  const downloadStart = src.indexOf('  const downloadFile = (file: P2PFile) => runBusy(async () => {');
  const previewStart = src.indexOf('  const previewImage = (file: P2PFile) => runBusy(async () => {', downloadStart);
  if (downloadStart !== -1 && previewStart !== -1) {
    const replacement = '  const downloadFile = (file: P2PFile) => runBusy(async () => { const password = file.isEncrypted ? getDrivePassword() : null; const result = await bridge.invoke<DownloadToPathResult>("p2p:downloadToPath", { hash: file.hash, drivePassword: password }); if (!result.canceled) toast.success("Download saved to disk"); });\n';
    src = src.slice(0, downloadStart) + replacement + src.slice(previewStart);
  }

  const previewBlockStart = src.indexOf('  const previewImage = (file: P2PFile) => runBusy(async () => {');
  const previewEnd = src.indexOf('  const closePreview = () =>', previewBlockStart);
  if (previewBlockStart !== -1 && previewEnd !== -1) {
    const replacement = '  const previewImage = (file: P2PFile) => runBusy(async () => { if (!isImageFile(file)) return; if (file.size > 25 * 1024 * 1024) { await downloadFile(file); return; } const password = file.isEncrypted ? getDrivePassword() : null; const result = await bridge.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword: password }); if ((result as any).savedToPath || (result as any).canceled) return; if (previewUrl) URL.revokeObjectURL(previewUrl); const blob = new Blob([new Uint8Array(result.bytes)], { type: result.file.mimeType || "image/*" }); setPreviewUrl(URL.createObjectURL(blob)); setPreviewName(result.file.name); });\n';
    src = src.slice(0, previewBlockStart) + replacement + src.slice(previewEnd);
  }

  src = stopLegacyBlobAfterSaveToPath(src);
  write(rel, src);
}

function patchDriveP2PApp() {
  const rel = 'client/src/DriveP2PApp.tsx';
  if (!fs.existsSync(path.join(root, rel))) return;
  let src = read(rel);

  if (!src.includes('| "p2p:downloadToPath"')) src = src.replace('  | "p2p:download"\n', '  | "p2p:download"\n  | "p2p:downloadToPath"\n');
  if (!src.includes('type DownloadToPathResult')) {
    src = src.replace('type DownloadResult = { ok: boolean; file: P2PFile; bytes: number[] };', 'type DownloadResult = { ok: boolean; file: P2PFile; bytes: number[] };\ntype DownloadToPathResult = { ok: boolean; canceled?: boolean; path?: string };');
  }

  const downloadStart = src.indexOf('  const downloadFile = (file: P2PFile) => runBusy(async () => {');
  const openPreviewStart = src.indexOf('  const openPreview = (file: P2PFile) => runBusy(async () => {', downloadStart);
  if (downloadStart !== -1 && openPreviewStart !== -1) {
    const replacement = '  const downloadFile = (file: P2PFile) => runBusy(async () => {\n    const payload = file.isEncrypted ? { hash: file.hash, drivePassword: requireDrivePassword() } : { hash: file.hash };\n    const result = await bridge.invoke<DownloadToPathResult>("p2p:downloadToPath", payload);\n    if (!result.canceled) toast.success("Download saved to disk");\n  });\n\n';
    src = src.slice(0, downloadStart) + replacement + src.slice(openPreviewStart);
  }

  const previewStart = src.indexOf('  const openPreview = (file: P2PFile) => runBusy(async () => {');
  const deleteStart = src.indexOf('  const deleteFile = (file: P2PFile) => runBusy(async () => {', previewStart);
  if (previewStart !== -1 && deleteStart !== -1) {
    const replacement = '  const openPreview = (file: P2PFile) => runBusy(async () => {\n    if (!isImageFile(file) || file.size > 25 * 1024 * 1024) {\n      await downloadFile(file);\n      return;\n    }\n    const payload = file.isEncrypted ? { hash: file.hash, drivePassword: requireDrivePassword() } : { hash: file.hash };\n    const result = await bridge.invoke<DownloadResult>("p2p:download", payload);\n    if ((result as any).savedToPath || (result as any).canceled) return;\n    const blob = new Blob([new Uint8Array(result.bytes)], { type: result.file.mimeType || "image/*" });\n    if (previewUrl) URL.revokeObjectURL(previewUrl);\n    setPreviewUrl(URL.createObjectURL(blob));\n    setPreviewFile(file);\n  });\n\n';
    src = src.slice(0, previewStart) + replacement + src.slice(deleteStart);
  }

  src = stopLegacyBlobAfterSaveToPath(src);
  write(rel, src);
}

function patchMainLegacyGuard() {
  const rel = 'electron/main.js';
  let src = read(rel);
  const throwingGuard = "  if (Number(manifest.storedSize || manifest.size || 0) > 50 * 1024 * 1024) throw new Error('Large downloads must use p2p:downloadToPath. Use the Download button, not Preview.');\n";
  const routingGuard = "  if (Number(manifest.storedSize || manifest.size || 0) > 50 * 1024 * 1024) {\n    const saved = await downloadFileToPathPayload(payload);\n    return { ok: true, file: manifest, bytes: [], savedToPath: saved?.path || null, canceled: Boolean(saved?.canceled) };\n  }\n";

  if (src.includes(throwingGuard)) {
    src = src.replace(throwingGuard, routingGuard);
    write(rel, src);
    return;
  }
  if (src.includes(routingGuard)) {
    console.log('[fix-download-paths] legacy large download routing already applied');
    return;
  }

  const needle = "  const orderedChunks = [...(manifest.chunks || [])].sort((a, b) => a.index - b.index);";
  const handlerIndex = src.indexOf("ipcMain.handle('p2p:download'");
  const needleIndex = src.indexOf(needle, handlerIndex);
  if (handlerIndex !== -1 && needleIndex !== -1) {
    src = src.slice(0, needleIndex) + routingGuard + src.slice(needleIndex);
    write(rel, src);
  } else {
    console.log('[fix-download-paths] legacy routing target missing');
  }
}

patchNativeP2PApp();
patchDriveP2PApp();
patchMainLegacyGuard();
console.log('[fix-download-paths] done');
