const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const mainPath = path.join(root, 'electron', 'main.js');
const ignoredDirs = new Set(['.git', 'node_modules', '.pnpm-store', 'dist', 'release', 'coverage']);

function readRequired(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing required file for encryption verification: ${label}`);
  return fs.readFileSync(filePath, 'utf8');
}

function assertIncludes(text, needle, label, failures) {
  if (!text.includes(needle)) failures.push(`Missing ${label}: ${needle}`);
}

function assertMatches(text, pattern, label, failures) {
  if (!pattern.test(text)) failures.push(`Missing or invalid ${label}`);
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) walk(absolute, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(cjs|mjs|js|jsx|ts|tsx)$/.test(entry.name)) continue;
    files.push({ absolute, relative });
  }
  return files;
}

const main = readRequired(mainPath, 'electron/main.js');
const failures = [];

for (const [needle, label] of [
  ["const ENCRYPTION_ALGORITHM = 'aes-256-gcm';", 'AES-256-GCM encryption algorithm'],
  ["const ENCRYPTION_KEY_SOURCE = 'wallet-password-v1';", 'stable wallet/password key source'],
  ["const KDF_ALGORITHM = 'pbkdf2-sha256';", 'PBKDF2-SHA256 KDF marker'],
  ['const KDF_ITERATIONS = 310000;', 'KDF iteration floor'],
  ['const MIN_DRIVE_PASSWORD_LENGTH = Number(process.env.P2P_MIN_DRIVE_PASSWORD_LENGTH || 12);', 'minimum drive password length'],
  ['function validateDrivePassword(drivePassword)', 'drive password validator'],
  ['if (password.length < MIN_DRIVE_PASSWORD_LENGTH)', 'drive password length check'],
  ['async function deriveDriveKey', 'async key derivation'],
  ['crypto.pbkdf2(`${identity}:${password}`, saltBuffer, KDF_ITERATIONS, 32, \'sha256\'', 'async PBKDF2 key derivation'],
  ['async function encryptPrivateBuffer', 'private buffer encryption'],
  ['crypto.randomBytes(16)', 'random salt'],
  ['crypto.randomBytes(12)', 'GCM IV'],
  ['crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv)', 'AES-GCM cipher'],
  ['cipher.getAuthTag().toString(\'base64\')', 'GCM auth tag persistence'],
  ['originalHash: hashBufferHex(plainBuffer)', 'original plaintext hash metadata'],
  ['async function decryptPrivateBuffer', 'private buffer decryption'],
  ['crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(manifest.encryption.iv, \'base64\'))', 'AES-GCM decipher'],
  ['decipher.setAuthTag(Buffer.from(manifest.encryption.authTag, \'base64\'))', 'GCM auth tag verification'],
  ['Private file integrity failed after decrypt', 'post-decrypt integrity check'],
  ['function persistWallet() { ensureDataDir(); const { encryptionSecret, loginSignature, ...safeWallet } = walletState;', 'wallet persistence strips secrets'],
  ['encryptionSecret: undefined', 'wallet load strips encryption secret'],
]) {
  assertIncludes(main, needle, label, failures);
}

assertMatches(main, /if \(manifest\.encryption\.keySource !== ENCRYPTION_KEY_SOURCE\) throw new Error\(`This file was encrypted with an older key source/, 'rejects old encryption key source', failures);
assertMatches(main, /if \(manifest\.encryption\.originalHash && hashBufferHex\(plain\) !== manifest\.encryption\.originalHash\)/, 'post-decrypt hash verification', failures);

const forbiddenPatterns = [
  { name: 'AES-CBC must not be used for private file encryption', pattern: /aes-256-cbc|aes-192-cbc|aes-128-cbc/i },
  { name: 'DES/3DES must not be used', pattern: /des-ede|des-cbc|createCipheriv\(['"]des/i },
  { name: 'deprecated createCipher/createDecipher must not be used', pattern: /crypto\.createCipher\(|crypto\.createDecipher\(/ },
  { name: 'pbkdf2Sync must not block Electron main thread', pattern: /pbkdf2Sync\(/ },
  { name: 'private encryption secrets must not be persisted under encryptionSecret JSON key', pattern: /JSON\.stringify\([^\n]*encryptionSecret/ },
];

for (const file of walk(path.join(root, 'electron'))) {
  const text = fs.readFileSync(file.absolute, 'utf8');
  for (const rule of forbiddenPatterns) {
    if (rule.pattern.test(text)) failures.push(`${file.relative}: ${rule.name}`);
  }
}

if (failures.length > 0) {
  console.error('[verify-encryption-safety] failed: encryption/key safety invariants are not enforced');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-encryption-safety] ok: private files use authenticated encryption, stable KDF metadata, and wallet secrets are not persisted');
