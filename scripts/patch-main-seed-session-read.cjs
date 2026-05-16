const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'electron', 'main-stable.js');
if (!fs.existsSync(file)) {
  console.warn('[main-seed-session-read] main-stable.js missing; skipping');
  process.exit(0);
}

let s = fs.readFileSync(file, 'utf8');

const oldBlock = "if (!walletState.encryptionSecret || activeWallet() !== identity) throw new Error('Seed Account is locked. Sign in with username + password, or recover with seed.');\n    return crypto.pbkdf2Sync(`${identity}:${walletState.encryptionSecret}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');";

const newBlock = "const seedSessionSecret = globalThis.__chunknetSeedSession?.get?.(identity) || walletState.encryptionSecret;\n    if (!seedSessionSecret || activeWallet() !== identity) throw new Error('Seed Account is locked. Sign in with username + password, or recover with seed.');\n    return crypto.pbkdf2Sync(`${identity}:${seedSessionSecret}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');";

if (s.includes('globalThis.__chunknetSeedSession?.get?.(identity)')) {
  console.log('[main-seed-session-read] already reads seed session from memory cache');
} else if (s.includes(oldBlock)) {
  s = s.replace(oldBlock, newBlock);
  fs.writeFileSync(file, s, 'utf8');
  console.log('[main-seed-session-read] main-stable reads seed session from memory cache');
} else {
  console.warn('[main-seed-session-read] seed derive block anchor not found; skipping');
}

try {
  require('./patch-seed-auth-state-signature.cjs');
} catch (error) {
  console.warn('[main-seed-session-read] seed auth state signature patch skipped:', error?.message || error);
}
