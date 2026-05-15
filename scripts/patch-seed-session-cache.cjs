const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'electron', 'seed-auth-cooldown-ipc.js');
let s = fs.readFileSync(file, 'utf8');

const oldFn = "function persistSession({ name, seed }) { const fp = hash(seedText(seed)); const id = `${PREFIX}${fp}`; const w = wallet(); writeJson(walletPath(), { ...w, connected: true, verified: true, authMode: 'seed', address: '', accountId: id, username: username(name), seedFingerprint: fp, connectedAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), encryptionSecret: seedText(seed), encryptionKeySource: KEY_SOURCE, planId: w.planId || 'free' }); return { ok: true, connected: true, verified: true, authMode: 'seed', address: id, accountId: id, username: username(name), seedFingerprint: fp, encryptionSecret: null, encryptionKeySource: KEY_SOURCE, minDrivePasswordLength: Number(process.env.P2P_MIN_DRIVE_PASSWORD_LENGTH || 12), plan: { id: w.planId || 'free', name: 'Free', quotaBytes: 5 * 1024 ** 3, priceUsd: 0 }, plans: [], usedBytes: 0, remainingBytes: 5 * 1024 ** 3 };\n}";

const newFn = "function persistSession({ name, seed }) { const fp = hash(seedText(seed)); const id = `${PREFIX}${fp}`; const w = wallet(); if (!globalThis.__chunknetSeedSession) globalThis.__chunknetSeedSession = new Map(); globalThis.__chunknetSeedSession.set(id, seedText(seed)); const { encryptionSecret, ...safeWallet } = w || {}; writeJson(walletPath(), { ...safeWallet, connected: true, verified: true, authMode: 'seed', address: '', accountId: id, username: username(name), seedFingerprint: fp, connectedAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), encryptionKeySource: KEY_SOURCE, planId: safeWallet.planId || 'free' }); return { ok: true, connected: true, verified: true, authMode: 'seed', address: id, accountId: id, username: username(name), seedFingerprint: fp, encryptionSecret: null, encryptionKeySource: KEY_SOURCE, minDrivePasswordLength: Number(process.env.P2P_MIN_DRIVE_PASSWORD_LENGTH || 12), plan: { id: safeWallet.planId || 'free', name: 'Free', quotaBytes: 5 * 1024 ** 3, priceUsd: 0 }, plans: [], usedBytes: 0, remainingBytes: 5 * 1024 ** 3 };\n}";

if (!s.includes('globalThis.__chunknetSeedSession')) {
  if (!s.includes(oldFn)) throw new Error('persistSession anchor not found');
  s = s.replace(oldFn, newFn);
  fs.writeFileSync(file, s, 'utf8');
}
console.log('[seed-session-cache] wallet file no longer stores seed session material');
