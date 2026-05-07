const fs = require('node:fs');

const p = 'client/src/NativeP2PApp.tsx';
if (!fs.existsSync(p)) process.exit(0);

let s = fs.readFileSync(p, 'utf8');
let changed = false;

function replaceOnce(from, to) {
  if (s.includes(from)) {
    s = s.replace(from, to);
    changed = true;
  }
}

replaceOnce(
  '"p2p:start" | "p2p:listFiles" | "p2p:upload" | "p2p:download"',
  '"p2p:start" | "p2p:listFiles" | "p2p:upload" | "p2p:uploadFiles" | "p2p:download"'
);

replaceOnce(
  'const uploadFiles = () => runBusy(async () => { if (!walletConnected) throw new Error("Connect your wallet before uploading"); if (uploadWouldExceedQuota) throw new Error("Storage quota exceeded. Upgrade your plan."); if (!selectedFiles.length) throw new Error("Select at least one file"); const password = getDrivePassword(); const targetFolder = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : ""; const uploadedHashes: string[] = []; for (const file of selectedFiles) { const result = await bridge.invoke<{ file?: P2PFile }>("p2p:upload", { name: file.name, mimeType: file.type || "application/octet-stream", isEncrypted, drivePassword: password, bytes: await file.arrayBuffer() }); if (result?.file?.hash) uploadedHashes.push(result.file.hash); } if (targetFolder && uploadedHashes.length) setFileFolders((current) => ({ ...current, ...Object.fromEntries(uploadedHashes.map((hash) => [hash, targetFolder])) })); setSelectedFiles([]); toast.success("Files stored safely"); await refreshAll(); });',
  'const uploadFiles = () => runBusy(async () => { if (!walletConnected) throw new Error("Connect your wallet before uploading"); const password = getDrivePassword(); const targetFolder = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : ""; const result = await bridge.invoke<{ ok?: boolean; cancelled?: boolean; files?: P2PFile[] }>("p2p:uploadFiles", { folderPath: targetFolder, isEncrypted, drivePassword: password }); if (result?.cancelled) return; const uploaded = Array.isArray(result?.files) ? result.files : []; if (targetFolder && uploaded.length) setFileFolders((current) => ({ ...current, ...Object.fromEntries(uploaded.filter((file) => file.hash).map((file) => [file.hash, targetFolder])) })); setSelectedFiles([]); toast.success(`${uploaded.length || 1} file(s) stored safely`); await refreshAll(); });'
);

replaceOnce(
  '<Input type="file" multiple onChange={handleFileSelect} disabled={!walletConnected || busy} />',
  '<div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-300">Large-file safe mode is enabled. Click Encrypt & Upload to select files with the native picker; files are streamed from disk instead of loaded into browser RAM.</div>'
);

replaceOnce(
  '<p className="mt-1 text-sm text-zinc-500">or choose files manually below</p>',
  '<p className="mt-1 text-sm text-zinc-500">click Encrypt & Upload to choose files with native streaming</p>'
);

replaceOnce(
  'disabled={!walletConnected || busy || !selectedFiles.length || uploadWouldExceedQuota}',
  'disabled={!walletConnected || busy}'
);

if (s.includes('await file.arrayBuffer()')) {
  throw new Error('[patch-native-ui-upload-streaming] unsafe file.arrayBuffer upload path still present');
}

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-native-ui-upload-streaming] Native UI now uses p2p:uploadFiles streaming');
} else {
  console.log('[patch-native-ui-upload-streaming] Native UI streaming upload already installed');
}
