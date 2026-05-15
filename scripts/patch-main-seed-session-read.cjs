const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'electron', 'main-stable.js');
let s = fs.readFileSync(file, 'utf8');

const oldBlock = "if (!walletState.encryptionSecret || activeWallet() !== identity) throw new Error('Seed Account is locked. Sign in with username + password, or recover with seed.');\n    return crypto.pbkdf2Sync(`${identity}:${walletState.encryptionSecret}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');";

const newBlock = "const seedSessionSecret = globalThis.__chunknetSeedSession?.get?.(identity) || walletState.encryptionSecret;\n    if (!seedSessionSecret || activeWallet() !== identity) throw new Error('Seed Account is locked. Sign in with username + password, or recover with seed.');\n    return crypto.pbkdf2Sync(`${identity}:${seedSessionSecret}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');";

if (!s.includes('globalThis.__chunknetSeedSession?.get?.(identity)')) {
  if (!s.includes(oldBlock)) throw new Error('seed derive block anchor not found');
  s = s.replace(oldBlock, newBlock);
  fs.writeFileSync(file, s, 'utf8');
}
console.log('[main-seed-session-read] main-stable reads seed session from memory cache');
