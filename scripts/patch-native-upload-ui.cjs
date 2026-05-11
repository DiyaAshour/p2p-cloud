const fs = require('node:fs');

const files = ['client/src/DriveP2PAppPassword.tsx', 'client/src/NativeP2PApp.tsx'];
let anyChanged = false;

function patchChannelUnion(s) {
  return s
    .replace(/"p2p:upload"\s*\|\s*"p2p:download"/g, '"p2p:upload" | "p2p:uploadFiles" | "p2p:download"')
    .replace(/\| "p2p:upload"\n\s*\| "p2p:download"/g, '| "p2p:upload"\n  | "p2p:uploadFiles"\n  | "p2p:download"')
    .replace(/type P2PChannel = ([^;]*?)"p2p:upload"([^;]*?);/s, (m) => m.includes('"p2p:uploadFiles"') ? m : m.replace('"p2p:upload"', '"p2p:upload" | "p2p:uploadFiles"'));
}

function safeUploadCanceledCheck() {
  return 'const uploadCancelled = (error: unknown) => { const message = error instanceof Error ? error.message : String(error || ""); return message.includes("__TRANSFER_CANCELLED_UPLOAD__") || message.includes("TRANSFER_CANCELLED_UPLOAD") || message.toLowerCase().includes("upload canceled") || message.toLowerCase().includes("upload cancelled") || message.toLowerCase().includes("transfer canceled") || message.toLowerCase().includes("transfer cancelled"); };';
}

function ensureUploadCancelledHelper(s) {
  if (s.includes('const uploadCancelled = (error: unknown) =>')) return s;
  const marker = 'function errorMessage(error: unknown)';
  const idx = s.indexOf(marker);
  if (idx !== -1) return s.slice(0, idx) + safeUploadCanceledCheck() + '\n\n' + s.slice(idx);
  return safeUploadCanceledCheck() + '\n\n' + s;
}

function nativeUploadFunction() {
  return 'const uploadFiles = () => runBusy(async () => { if (!walletConnected) throw new Error("Connect your wallet before uploading"); if (uploadWouldExceedQuota) throw new Error("Storage quota exceeded. Upgrade your plan."); const password = getDrivePassword(); const targetFolder = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : ""; try { const result = await bridge.invoke<{ ok?: boolean; cancelled?: boolean; files?: P2PFile[] }>("p2p:uploadFiles", { folderPath: targetFolder, isEncrypted, drivePassword: password }); if (result?.cancelled) { toast("Upload canceled"); return; } const uploadedHashes = (result?.files || []).map((file) => file.hash).filter(Boolean); if (targetFolder && uploadedHashes.length) setFileFolders((current) => ({ ...current, ...Object.fromEntries(uploadedHashes.map((hash) => [hash, targetFolder])) })); setSelectedFiles([]); toast.success(`Files stored safely${result?.files?.length ? `: ${result.files.length} file(s)` : ""}`); await refreshAll(); } catch (error) { if (uploadCancelled(error)) { toast("Upload canceled"); return; } throw error; } });';
}

function patchDriveApp(s) {
  let changed = false;
  const before = s;
  s = patchChannelUnion(s);
  s = ensureUploadCancelledHelper(s);
  if (s !== before) changed = true;

  s = s.replace(
    /const upload = \(\) => run\(async \(\) => \{[\s\S]*?toast\.success\([^;]*\); \}\);/,
    () => {
      changed = true;
      return 'const upload = () => run(async () => { if (!connected) throw new Error("Connect wallet first"); requirePassword(); try { const r = await electron.invoke<{ ok?: boolean; cancelled?: boolean; files?: P2PFile[] }>("p2p:uploadFiles", { folderPath: path, isEncrypted: true, drivePassword }); if (r?.cancelled) { toast("Upload canceled"); return; } setSelected([]); await refresh(); toast.success(`Encrypted upload complete${r?.files?.length ? `: ${r.files.length} file(s)` : ""}`); } catch (error) { if (uploadCancelled(error)) { toast("Upload canceled"); return; } throw error; } });';
    }
  );

  return { s, changed };
}

function patchNativeApp(s) {
  let changed = false;
  const before = s;
  s = patchChannelUnion(s);
  s = ensureUploadCancelledHelper(s);
  if (s !== before) changed = true;

  s = s.replace(
    /type DownloadResult = \{ ok: boolean; file: P2PFile; bytes: number\[\] \};/,
    () => {
      changed = true;
      return 'type DownloadResult = { ok?: boolean; cancelled?: boolean; file: P2PFile; savedPath?: string; bytes?: number[] };';
    }
  );

  const replacement = nativeUploadFunction();
  const uploadStart = s.indexOf('const uploadFiles = () => runBusy(async () => {');
  if (uploadStart !== -1) {
    const nextMarker = s.indexOf('\n  const downloadFile =', uploadStart);
    if (nextMarker !== -1) {
      const current = s.slice(uploadStart, nextMarker);
      if (current !== replacement) {
        s = s.slice(0, uploadStart) + replacement + s.slice(nextMarker);
        changed = true;
      }
    }
  } else if (!s.includes('const uploadFiles = () =>')) {
    throw new Error('[patch-native-upload-ui] could not find uploadFiles function in NativeP2PApp.tsx');
  }

  if (s.includes('Upload encrypted files') && !s.includes('RAM-safe mode')) {
    s = s.replace('Upload encrypted files', 'Upload encrypted files · RAM-safe mode');
    changed = true;
  }

  return { s, changed };
}

for (const p of files) {
  if (!fs.existsSync(p)) continue;
  const original = fs.readFileSync(p, 'utf8');
  const { s, changed } = p.endsWith('NativeP2PApp.tsx') ? patchNativeApp(original) : patchDriveApp(original);

  if (p.endsWith('NativeP2PApp.tsx')) {
    const uploadStart = s.indexOf('const uploadFiles = () => runBusy(async () => {');
    const downloadStart = s.indexOf('\n  const downloadFile =', uploadStart);
    const uploadScope = uploadStart === -1 ? '' : s.slice(uploadStart, downloadStart === -1 ? s.length : downloadStart);
    if (uploadScope.includes('await file.arrayBuffer()')) throw new Error(`[patch-native-upload-ui] ${p} uploadFiles still reads full file into RAM`);
    if (!uploadScope.includes('p2p:uploadFiles')) throw new Error(`[patch-native-upload-ui] ${p} uploadFiles is missing native streaming upload channel`);
  }

  if (!s.includes('p2p:uploadFiles')) throw new Error(`[patch-native-upload-ui] ${p} is missing native streaming upload channel`);

  if (changed) {
    fs.writeFileSync(p, s, 'utf8');
    anyChanged = true;
    console.log(`[patch-native-upload-ui] patched ${p} to use safe native streaming upload`);
  }
}

console.log(anyChanged ? '[patch-native-upload-ui] safe native upload UI patches applied' : '[patch-native-upload-ui] safe native upload UI already patched');
