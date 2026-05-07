const fs = require('node:fs');

const files = ['client/src/DriveP2PAppPassword.tsx', 'client/src/NativeP2PApp.tsx'];
let anyChanged = false;

function patchChannelUnion(s) {
  return s
    .replace(/"p2p:upload"\s*\|\s*"p2p:download"/g, '"p2p:upload" | "p2p:uploadFiles" | "p2p:download"')
    .replace(/\| "p2p:upload"\n\s*\| "p2p:download"/g, '| "p2p:upload"\n  | "p2p:uploadFiles"\n  | "p2p:download"');
}

function patchDriveApp(s) {
  let changed = false;
  const before = s;
  s = patchChannelUnion(s);
  if (s !== before) changed = true;

  s = s.replace(
    /const upload = \(\) => run\(async \(\) => \{[\s\S]*?toast\.success\("Encrypted upload complete"\); \}\);/,
    () => {
      changed = true;
      return 'const upload = () => run(async () => { if (!connected) throw new Error("Connect wallet first"); requirePassword(); const r = await electron.invoke<{ ok?: boolean; cancelled?: boolean; files?: P2PFile[] }>("p2p:uploadFiles", { folderPath: path, isEncrypted: true, drivePassword }); if (r?.cancelled) return; setSelected([]); await refresh(); toast.success(`Encrypted upload complete${r?.files?.length ? `: ${r.files.length} file(s)` : ""}`); });';
    }
  );

  return { s, changed };
}

function patchNativeApp(s) {
  let changed = false;
  const before = s;
  s = patchChannelUnion(s);
  if (s !== before) changed = true;

  s = s.replace(
    /type DownloadResult = \{ ok: boolean; file: P2PFile; bytes: number\[\] \};/,
    () => {
      changed = true;
      return 'type DownloadResult = { ok?: boolean; cancelled?: boolean; file: P2PFile; savedPath?: string };';
    }
  );

  s = s.replace(
    /const uploadFiles = \(\) => runBusy\(async \(\) => \{[\s\S]*?toast\.success\("Files stored safely"\); await refreshAll\(\); \}\);/,
    () => {
      changed = true;
      return 'const uploadFiles = () => runBusy(async () => { if (!walletConnected) throw new Error("Connect your wallet before uploading"); const password = getDrivePassword(); const targetFolder = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : ""; const result = await bridge.invoke<{ ok?: boolean; cancelled?: boolean; files?: P2PFile[] }>("p2p:uploadFiles", { folderPath: targetFolder, isEncrypted, drivePassword: password }); if (result?.cancelled) return; setSelectedFiles([]); toast.success(`Files stored safely${result?.files?.length ? `: ${result.files.length} file(s)` : ""}`); await refreshAll(); });';
    }
  );

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

  if (s.includes('await file.arrayBuffer()')) throw new Error(`[patch-native-upload-ui] ${p} still reads full file into RAM`);
  if (s.includes('bytes: await')) throw new Error(`[patch-native-upload-ui] ${p} still sends bytes through IPC`);
  if (!s.includes('p2p:uploadFiles')) throw new Error(`[patch-native-upload-ui] ${p} is missing native streaming upload channel`);

  if (changed) {
    fs.writeFileSync(p, s, 'utf8');
    anyChanged = true;
    console.log(`[patch-native-upload-ui] patched ${p} to use native streaming upload`);
  }
}

console.log(anyChanged ? '[patch-native-upload-ui] native upload UI patches applied' : '[patch-native-upload-ui] native upload UI already patched');
