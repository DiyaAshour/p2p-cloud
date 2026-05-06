const fs = require('node:fs');
const p = 'electron/main.js';
let s = fs.readFileSync(p, 'utf8');
const oldLine = "  return { ok: true, file: manifest, bytes: Array.from(plain), progress: transferProgress.download };";
const newLine = "  return { ok: true, file: manifest, bytes: Array.from(plain), progress: transferProgress.download };";
if (!s.includes(oldLine)) {
  console.log('[patch-download-memory] target line not found');
  process.exit(0);
}
console.log('[patch-download-memory] download handler still returns bytes; manual streaming patch required');
