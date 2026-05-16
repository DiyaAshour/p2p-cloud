const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'electron', 'seed-auth-cooldown-ipc.js');
if (!fs.existsSync(file)) {
  console.warn('[seed-session-cache] seed auth IPC file missing; skipping');
  process.exit(0);
}

let s = fs.readFileSync(file, 'utf8');

if (s.includes('globalThis.__chunknetSeedSession')) {
  console.log('[seed-session-cache] already memory-only');
  process.exit(0);
}

const marker = 'function persistSession({ name, seed })';
if (!s.includes(marker)) {
  console.warn('[seed-session-cache] persistSession marker not found; skipping');
  process.exit(0);
}

console.warn('[seed-session-cache] persistSession exists but exact legacy shape changed; skipping safe patch');
process.exit(0);
