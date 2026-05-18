const fs = require('node:fs');

const file = 'scripts/patch-streaming-upload-download-final.cjs';

if (!fs.existsSync(file)) {
  console.log('[fix-streaming-final-script-syntax] skip missing file');
  process.exit(0);
}

let s = fs.readFileSync(file, 'utf8');
const before = s;

s = s.replace(
  "uploadReadFileSyncLeft: /readFileSync\\\\(filePath\\\\)/.test(s),",
  "uploadReadFileSyncLeft: s.includes('readFileSync(filePath)'),"
);

s = s.replace(
  "downloadBufferConcatLeft: /Buffer\\\\.concat\\\\(buffers\\\\)/.test(s),",
  "downloadBufferConcatLeft: s.includes('Buffer.concat(buffers)'),"
);

s = s.replace(
  "downloadWriteFileSyncLeft: /writeFileSync\\\\(save\\\\.filePath/.test(s),",
  "downloadWriteFileSyncLeft: s.includes('writeFileSync(save.filePath'),"
);

s = s.replace(
  "downloadWriteFileSyncLeft: /writeFileSync\\(save\\.filePath/.test(s),",
  "downloadWriteFileSyncLeft: s.includes('writeFileSync(save.filePath'),"
);

if (s !== before) {
  fs.writeFileSync(file, s, 'utf8');
  console.log('[fix-streaming-final-script-syntax] patched regex checks');
} else {
  console.log('[fix-streaming-final-script-syntax] ok');
}
