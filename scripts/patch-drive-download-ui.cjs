const fs = require('node:fs');
const p = 'client/src/DriveP2PAppPassword.tsx';
let s = fs.readFileSync(p, 'utf8');
let changed = false;

s = s.replace(
  /type DownloadResult = \{ file: P2PFile; bytes: number\[\] \};/,
  () => { changed = true; return 'type DownloadResult = { ok?: boolean; cancelled?: boolean; file: P2PFile; savedPath?: string; bytes?: number[] };'; }
);

s = s.replace(
  /const download = \(file: P2PFile\) => run\(async \(\) => \{[\s\S]*?URL\.revokeObjectURL\(url\); \}\);/,
  () => { changed = true; return 'const download = (file: P2PFile) => run(async () => { if (file.isEncrypted) requirePassword(); const r = await electron.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword }); if (r?.cancelled) return; toast.success(r?.savedPath ? `Saved to ${r.savedPath}` : "Download complete"); });'; }
);

s = s.replace(
  /const open = \(file: P2PFile\) => run\(async \(\) => \{[\s\S]*?setPreview\(\{ file, url: URL\.createObjectURL\(blob\) \}\); \}\);/,
  () => { changed = true; return 'const open = (file: P2PFile) => run(async () => { await download(file); });'; }
);

if (s.includes('new Uint8Array(r.bytes)')) throw new Error('[patch-drive-download-ui] UI still expects bytes');
if (changed) fs.writeFileSync(p, s, 'utf8');
console.log(changed ? '[patch-drive-download-ui] patched UI download savedPath' : '[patch-drive-download-ui] already patched');
