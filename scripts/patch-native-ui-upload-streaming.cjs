const fs = require('node:fs');

const p = 'client/src/NativeP2PApp.tsx';
if (!fs.existsSync(p)) process.exit(0);

let s = fs.readFileSync(p, 'utf8');
let changed = false;

function write(next) {
  if (next !== s) {
    s = next;
    changed = true;
  }
}

function replaceOnce(from, to) {
  if (s.includes(from)) write(s.replace(from, to));
}

// Repair a known JSX typo left by older patches: an extra closing brace after Delete button.
write(s.replace(/<Trash2 className="size-4" \/>Delete<\/Button>\}<\/div><select/g, '<Trash2 className="size-4" />Delete</Button></div><select'));
write(s.replace(/<Trash2 className="size-4" \/>Delete<\/Button>\}\s*<\/div><select/g, '<Trash2 className="size-4" />Delete</Button></div><select'));

// Make the bridge type aware of the native streaming upload channel.
replaceOnce(
  '"p2p:start" | "p2p:listFiles" | "p2p:upload" | "p2p:download"',
  '"p2p:start" | "p2p:listFiles" | "p2p:upload" | "p2p:uploadFiles" | "p2p:download"'
);

// Replace the old browser-RAM upload implementation with a native file picker upload.
const nativeUpload = 'const uploadFiles = () => runBusy(async () => { if (!walletConnected) throw new Error("Connect your wallet before uploading"); const password = getDrivePassword(); const targetFolder = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : ""; const result = await bridge.invoke<{ ok?: boolean; cancelled?: boolean; files?: P2PFile[] }>("p2p:uploadFiles", { folderPath: targetFolder, isEncrypted, drivePassword: password }); if (result?.cancelled) return; const uploaded = Array.isArray(result?.files) ? result.files : []; if (targetFolder && uploaded.length) setFileFolders((current) => ({ ...current, ...Object.fromEntries(uploaded.filter((file) => file.hash).map((file) => [file.hash, targetFolder])) })); setSelectedFiles([]); toast.success(`${uploaded.length || 1} file(s) stored safely`); await refreshAll(); });';
write(s.replace(/const uploadFiles = \(\) => runBusy\(async \(\) => \{[\s\S]*?\n\s*const downloadFile = /, nativeUpload + '\n  const downloadFile = '));

// Replace browser file inputs with a clear native-streaming message.
write(s.replace(/<Input type="file"[^>]*onChange=\{handleFileSelect\}[^>]*\/>/g, '<div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-300">Large-file safe mode is enabled. Press Choose & Store files to select files with the Windows picker. Files are streamed from disk instead of loaded into browser RAM.</div>'));

replaceOnce(
  '<p className="mt-1 text-sm text-zinc-500">or choose files manually below</p>',
  '<p className="mt-1 text-sm text-zinc-500">press Choose & Store files to choose files with native streaming</p>'
);
replaceOnce(
  '<p className="mt-1 text-sm text-zinc-500">click Encrypt & Upload to choose files with native streaming</p>',
  '<p className="mt-1 text-sm text-zinc-500">press Choose & Store files to choose files with native streaming</p>'
);
replaceOnce(
  '<p className="mt-1 text-sm text-zinc-500">press Encrypt & Upload to choose files with native streaming</p>',
  '<p className="mt-1 text-sm text-zinc-500">press Choose & Store files to choose files with native streaming</p>'
);

// The upload button must be clickable before files are selected, because selection now happens in Electron.
write(s.replace(/disabled=\{[^}]*!selectedFiles\.length[^}]*\}/g, 'disabled={!walletConnected || busy}'));
write(s.replace(/disabled=\{!walletConnected \|\| busy \|\| uploadWouldExceedQuota\}/g, 'disabled={!walletConnected || busy}'));
write(s.replace(/Encrypt\s*&\s*Upload/g, 'Choose & Store files'));
write(s.replace(/Choose\s*&\s*(Choose\s*&\s*)+Store files/g, 'Choose & Store files'));

if (s.includes('await file.arrayBuffer()')) {
  throw new Error('[patch-native-ui-upload-streaming] unsafe file.arrayBuffer upload path still present');
}
if (s.includes('Delete</Button>}')) {
  throw new Error('[patch-native-ui-upload-streaming] broken JSX extra brace after Delete button still present');
}
if (!s.includes('"p2p:uploadFiles"')) {
  throw new Error('[patch-native-ui-upload-streaming] p2p:uploadFiles channel missing');
}
if (!s.includes('bridge.invoke<{ ok?: boolean; cancelled?: boolean; files?: P2PFile[] }>("p2p:uploadFiles"')) {
  throw new Error('[patch-native-ui-upload-streaming] Native UI uploadFiles handler was not installed');
}

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-native-ui-upload-streaming] Native UI now uses p2p:uploadFiles streaming');
} else {
  console.log('[patch-native-ui-upload-streaming] Native UI streaming upload already installed');
}
