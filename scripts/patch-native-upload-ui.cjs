const fs = require('node:fs');
const p = 'client/src/DriveP2PAppPassword.tsx';
let s = fs.readFileSync(p, 'utf8');
let changed = false;

function replaceOnce(from, to) {
  if (s.includes(from)) {
    s = s.replace(from, to);
    changed = true;
  }
}

replaceOnce('  | "p2p:upload"\n  | "p2p:download"', '  | "p2p:upload"\n  | "p2p:uploadFiles"\n  | "p2p:download"');

s = s.replace(
  /const upload = \(\) => run\(async \(\) => \{[\s\S]*?toast\.success\("Encrypted upload complete"\); \}\);/,
  () => {
    changed = true;
    return 'const upload = () => run(async () => { if (!connected) throw new Error("Connect wallet first"); requirePassword(); const r = await electron.invoke<{ ok?: boolean; cancelled?: boolean; files?: P2PFile[] }>("p2p:uploadFiles", { folderPath: path, isEncrypted: true, drivePassword }); if (r?.cancelled) return; setSelected([]); await refresh(); toast.success(`Encrypted upload complete${r?.files?.length ? `: ${r.files.length} file(s)` : ""}`); });';
  }
);

if (s.includes('await file.arrayBuffer()')) throw new Error('[patch-native-upload-ui] UI still reads full file into RAM');
if (s.includes('bytes: await')) throw new Error('[patch-native-upload-ui] UI still sends bytes through IPC');

if (changed) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-native-upload-ui] patched UI to use native streaming upload');
} else {
  console.log('[patch-native-upload-ui] native upload UI already patched');
}
