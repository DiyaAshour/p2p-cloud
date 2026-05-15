const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const mainPath = path.join(root, 'electron', 'main-stable.js');
const preloadPath = path.join(root, 'electron', 'preload.cjs');

function mustRead(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

function write(file, content) {
  fs.writeFileSync(file, content, 'utf8');
}

function replaceOnce(src, from, to, label) {
  if (src.includes(to)) return src;
  if (!src.includes(from)) throw new Error(`Patch anchor not found: ${label}`);
  return src.replace(from, to);
}

function patchMainStable() {
  let src = mustRead(mainPath);

  src = replaceOnce(src,
    "const ENCRYPTION_KEY_SOURCE = 'wallet-password-v1';\nconst KDF_ALGORITHM = 'pbkdf2-sha256';",
    "const ENCRYPTION_KEY_SOURCE = 'wallet-password-v1';\nconst SEED_ACCOUNT_KEY_SOURCE = 'seed-account-v1';\nconst SEED_ACCOUNT_PREFIX = 'seed:';\nconst KDF_ALGORITHM = 'pbkdf2-sha256';",
    'seed constants'
  );

  src = replaceOnce(src,
    "let walletPath = null;\nlet manifests = [];",
    "let walletPath = null;\nlet seedAccountsPath = null;\nlet manifests = [];",
    'seed accounts path state'
  );

  src = replaceOnce(src,
    "let walletState = { connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE };",
    "let walletState = { connected: false, verified: false, authMode: null, address: '', accountId: '', username: null, seedFingerprint: null, planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE };",
    'wallet state seed fields'
  );

  src = replaceOnce(src,
    "function normalizeWallet(address = '') { return String(address || '').trim().toLowerCase(); }\nfunction activeWallet() { return normalizeWallet(walletState.address); }\nfunction isValidWallet(address = '') { return /^0x[a-fA-F0-9]{40}$/.test(String(address).trim()); }",
    "function normalizeWallet(address = '') { return String(address || '').trim().toLowerCase(); }\nfunction normalizeUsername(username = '') { return String(username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, ''); }\nfunction normalizeSeed(seed = '') { return String(seed || '').trim().replace(/\\s+/g, ' ').toLowerCase(); }\nfunction seedFingerprint(seed = '') { return crypto.createHash('sha256').update(normalizeSeed(seed)).digest('hex'); }\nfunction seedAccountIdFromSeed(seed = '') { return `${SEED_ACCOUNT_PREFIX}${seedFingerprint(seed)}`; }\nfunction activeWallet() { return normalizeWallet(walletState.accountId || walletState.address); }\nfunction isValidWallet(address = '') { return /^0x[a-fA-F0-9]{40}$/.test(String(address).trim()); }\nfunction isSeedAccountId(value = '') { return /^seed:[a-f0-9]{64}$/.test(String(value || '').trim().toLowerCase()); }\nfunction keySourceForIdentity(identity = activeWallet()) { return isSeedAccountId(identity) ? SEED_ACCOUNT_KEY_SOURCE : ENCRYPTION_KEY_SOURCE; }\nfunction isVerifiedIdentity() { const id = activeWallet(); return Boolean(walletState.connected && walletState.verified && (isValidWallet(walletState.address) || isSeedAccountId(id))); }",
    'identity helpers'
  );

  src = replaceOnce(src,
    "function assertVerifiedWallet() { if (!walletState.connected || !walletState.verified || !isValidWallet(walletState.address)) throw new Error('Verified wallet required. Connect wallet first.'); }",
    "function assertVerifiedWallet() { if (!isVerifiedIdentity()) throw new Error('Verified identity required. Connect wallet or sign in with Seed Account first.'); }",
    'verified identity gate'
  );

  src = replaceOnce(src,
    "  walletPath = path.join(dataDir, 'wallet.json');\n  fs.mkdirSync(dataDir, { recursive: true });",
    "  walletPath = path.join(dataDir, 'wallet.json');\n  seedAccountsPath = path.join(dataDir, 'seed-accounts.json');\n  fs.mkdirSync(dataDir, { recursive: true });",
    'seed accounts file path'
  );

  src = replaceOnce(src,
    "  if (!fs.existsSync(walletPath)) fs.writeFileSync(walletPath, JSON.stringify(walletState, null, 2), 'utf8');\n}",
    "  if (!fs.existsSync(walletPath)) fs.writeFileSync(walletPath, JSON.stringify(walletState, null, 2), 'utf8');\n  if (!fs.existsSync(seedAccountsPath)) fs.writeFileSync(seedAccountsPath, JSON.stringify({ version: 1, accounts: [] }, null, 2), 'utf8');\n}",
    'seed accounts file init'
  );

  src = replaceOnce(src,
    "    walletState = { ...walletState, ...parsed, planId: PLANS[parsed?.planId] ? parsed.planId : 'free', encryptionSecret: undefined, encryptionKeySource: ENCRYPTION_KEY_SOURCE };",
    "    walletState = { ...walletState, ...parsed, planId: PLANS[parsed?.planId] ? parsed.planId : 'free', encryptionSecret: undefined, encryptionKeySource: parsed?.encryptionKeySource || ENCRYPTION_KEY_SOURCE };",
    'preserve key source'
  );

  src = replaceOnce(src,
    "  } catch { walletState = { connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE }; }",
    "  } catch { walletState = { connected: false, verified: false, authMode: null, address: '', accountId: '', username: null, seedFingerprint: null, planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE }; }",
    'wallet load fallback'
  );

  src = replaceOnce(src,
    "function persistWallet() { ensureDataDir(); const { encryptionSecret, loginSignature, ...safeWallet } = walletState; fs.writeFileSync(walletPath, JSON.stringify({ ...safeWallet, encryptionKeySource: ENCRYPTION_KEY_SOURCE }, null, 2), 'utf8'); }",
    "function persistWallet() { ensureDataDir(); const { encryptionSecret, loginSignature, ...safeWallet } = walletState; fs.writeFileSync(walletPath, JSON.stringify({ ...safeWallet, encryptionKeySource: safeWallet.encryptionKeySource || ENCRYPTION_KEY_SOURCE }, null, 2), 'utf8'); }",
    'persist key source'
  );

  src = replaceOnce(src,
    "function totalStoredBytesForWallet() { return walletManifests().reduce((sum, file) => sum + Number(file.size || 0), 0); }",
    "function totalStoredBytesForWallet() { return walletManifests().reduce((sum, file) => sum + Number(file.size || 0), 0); }\nfunction loadSeedAccounts() { ensureDataDir(); try { const parsed = JSON.parse(fs.readFileSync(seedAccountsPath, 'utf8')); return Array.isArray(parsed?.accounts) ? parsed.accounts : []; } catch { return []; } }\nfunction saveSeedAccounts(accounts = []) { ensureDataDir(); fs.writeFileSync(seedAccountsPath, JSON.stringify({ version: 1, accounts }, null, 2), 'utf8'); }\nfunction findSeedAccountByUsername(username = '') { const normalized = normalizeUsername(username); return loadSeedAccounts().find((account) => account.username === normalized) || null; }\nfunction passwordKey(password, salt) { return crypto.pbkdf2Sync(validateDrivePassword(password), Buffer.from(String(salt || ''), 'base64'), KDF_ITERATIONS, 32, 'sha256'); }\nfunction encryptSeedVault(seed, password) { const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12); const key = passwordKey(password, salt.toString('base64')); const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv); const ciphertext = Buffer.concat([cipher.update(normalizeSeed(seed), 'utf8'), cipher.final()]); return { algorithm: ENCRYPTION_ALGORITHM, kdf: KDF_ALGORITHM, kdfIterations: KDF_ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }; }\nfunction decryptSeedVault(account, password) { const vault = account?.seedVault; if (!vault?.ciphertext || !vault?.salt || !vault?.iv || !vault?.authTag) throw new Error('Seed account vault is missing or corrupted'); const key = passwordKey(password, vault.salt); const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(vault.iv, 'base64')); decipher.setAuthTag(Buffer.from(vault.authTag, 'base64')); return normalizeSeed(Buffer.concat([decipher.update(Buffer.from(vault.ciphertext, 'base64')), decipher.final()]).toString('utf8')); }\nfunction createSeedAccountSession({ username, seed, created = false }) { const normalizedSeed = normalizeSeed(seed); const fingerprint = seedFingerprint(normalizedSeed); const accountId = `${SEED_ACCOUNT_PREFIX}${fingerprint}`; walletState = { ...walletState, connected: true, verified: true, authMode: 'seed', address: '', accountId, username: normalizeUsername(username), seedFingerprint: fingerprint, connectedAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), encryptionSecret: normalizedSeed, encryptionKeySource: SEED_ACCOUNT_KEY_SOURCE, planId: PLANS[walletState.planId] ? walletState.planId : 'free' }; persistWallet(); return { ...walletSummary(), created, seed: null, recoveryRequired: false }; }\nfunction generateSeedPhrase() { return crypto.randomBytes(32).toString('hex'); }",
    'seed vault helpers'
  );

  src = replaceOnce(src,
    "function walletSummary() { const plan = PLANS[walletState.planId] || PLANS.free; const usedBytes = walletState.connected ? totalStoredBytesForWallet() : 0; return { ok: true, ...walletState, encryptionSecret: null, loginSignature: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE, minDrivePasswordLength: MIN_DRIVE_PASSWORD_LENGTH, address: activeWallet() || walletState.address, plan, plans: Object.values(PLANS), usedBytes, remainingBytes: Math.max(0, plan.quotaBytes - usedBytes), sync: lastSyncStatus }; }",
    "function walletSummary() { const plan = PLANS[walletState.planId] || PLANS.free; const usedBytes = walletState.connected ? totalStoredBytesForWallet() : 0; return { ok: true, ...walletState, encryptionSecret: null, loginSignature: null, encryptionKeySource: walletState.encryptionKeySource || keySourceForIdentity(), minDrivePasswordLength: MIN_DRIVE_PASSWORD_LENGTH, address: activeWallet() || walletState.address, accountId: activeWallet(), plan, plans: Object.values(PLANS), usedBytes, remainingBytes: Math.max(0, plan.quotaBytes - usedBytes), sync: lastSyncStatus }; }",
    'wallet summary seed account'
  );

  src = replaceOnce(src,
    "function deriveDriveKey({ ownerWallet = activeWallet(), drivePassword, salt }) {\n  const wallet = normalizeWallet(ownerWallet);\n  if (!isValidWallet(wallet)) throw new Error('Valid wallet address required for private file encryption.');\n  const password = validateDrivePassword(drivePassword);\n  const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt || ''), 'base64');\n  return crypto.pbkdf2Sync(`${wallet}:${password}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');\n}",
    "function deriveDriveKey({ ownerWallet = activeWallet(), drivePassword, salt }) {\n  const identity = normalizeWallet(ownerWallet);\n  const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt || ''), 'base64');\n  if (isSeedAccountId(identity)) {\n    if (!walletState.encryptionSecret || activeWallet() !== identity) throw new Error('Seed Account is locked. Sign in with username + password, or recover with seed.');\n    return crypto.pbkdf2Sync(`${identity}:${walletState.encryptionSecret}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');\n  }\n  if (!isValidWallet(identity)) throw new Error('Valid wallet or seed account required for private file encryption.');\n  const password = validateDrivePassword(drivePassword);\n  return crypto.pbkdf2Sync(`${identity}:${password}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');\n}",
    'derive drive key seed account'
  );

  src = replaceOnce(src,
    "      keySource: ENCRYPTION_KEY_SOURCE,",
    "      keySource: keySourceForIdentity(ownerWallet),",
    'dynamic encrypted file key source'
  );

  src = replaceOnce(src,
    "ipcMain.handle('wallet:status', async () => { ensureDataDir(); loadWallet(); loadManifests(); return walletSummary(); });",
    "ipcMain.handle('seed:status', async () => { ensureDataDir(); loadWallet(); return { ok: true, available: true, accounts: loadSeedAccounts().map((account) => ({ username: account.username, accountId: account.accountId, seedFingerprint: account.seedFingerprint, createdAt: account.createdAt })), wallet: walletSummary() }; });\nipcMain.handle('seed:create', async (_event, payload = {}) => { ensureDataDir(); const username = normalizeUsername(payload.username); if (!username || username.length < 3) throw new Error('Username must be at least 3 characters.'); const password = validateDrivePassword(payload.password); const accounts = loadSeedAccounts(); if (accounts.some((account) => account.username === username)) throw new Error('Username already exists on this device. Use login or recover.'); const seed = normalizeSeed(payload.seed || generateSeedPhrase()); const accountId = seedAccountIdFromSeed(seed); const account = { username, accountId, seedFingerprint: seedFingerprint(seed), seedVault: encryptSeedVault(seed, password), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), keySource: SEED_ACCOUNT_KEY_SOURCE }; accounts.push(account); saveSeedAccounts(accounts); createSeedAccountSession({ username, seed, created: true }); return { ...walletSummary(), created: true, seed }; });\nipcMain.handle('seed:login', async (_event, payload = {}) => { ensureDataDir(); const username = normalizeUsername(payload.username); const account = findSeedAccountByUsername(username); if (!account) throw new Error('Seed account not found on this device. Use recover/import with your seed.'); const seed = decryptSeedVault(account, payload.password); return createSeedAccountSession({ username, seed }); });\nipcMain.handle('seed:recover', async (_event, payload = {}) => { ensureDataDir(); const username = normalizeUsername(payload.username); if (!username || username.length < 3) throw new Error('Username must be at least 3 characters.'); const password = validateDrivePassword(payload.password); const seed = normalizeSeed(payload.seed); if (!seed || seed.length < 32) throw new Error('Recovery seed is required.'); const accountId = seedAccountIdFromSeed(seed); const nextAccount = { username, accountId, seedFingerprint: seedFingerprint(seed), seedVault: encryptSeedVault(seed, password), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), keySource: SEED_ACCOUNT_KEY_SOURCE }; const accounts = loadSeedAccounts().filter((account) => account.username !== username && account.accountId !== accountId); accounts.push(nextAccount); saveSeedAccounts(accounts); return createSeedAccountSession({ username, seed }); });\nipcMain.handle('wallet:status', async () => { ensureDataDir(); loadWallet(); loadManifests(); return walletSummary(); });",
    'seed ipc handlers'
  );

  src = replaceOnce(src,
    "ipcMain.handle('wallet:connect', async (_event, payload = {}) => { const address = normalizeWallet(payload.address); if (!isValidWallet(address)) throw new Error('Invalid wallet address. Expected 0x + 40 hex characters.'); const login = await verifyWalletLoginPayload(payload, address); const sameWallet = address === activeWallet(); walletState = { ...walletState, connected: true, verified: true, address, planId: sameWallet && PLANS[walletState.planId] ? walletState.planId : 'free', connectedAt: new Date().toISOString(), verifiedAt: login.signedAt, loginMessage: login.message, loginSignature: undefined, encryptionSecret: undefined, encryptionKeySource: ENCRYPTION_KEY_SOURCE }; persistWallet(); return walletSummary(); });",
    "ipcMain.handle('wallet:connect', async (_event, payload = {}) => { const address = normalizeWallet(payload.address); if (!isValidWallet(address)) throw new Error('Invalid wallet address. Expected 0x + 40 hex characters.'); const login = await verifyWalletLoginPayload(payload, address); const sameWallet = address === activeWallet(); walletState = { ...walletState, connected: true, verified: true, authMode: 'wallet', address, accountId: address, username: null, seedFingerprint: null, planId: sameWallet && PLANS[walletState.planId] ? walletState.planId : 'free', connectedAt: new Date().toISOString(), verifiedAt: login.signedAt, loginMessage: login.message, loginSignature: undefined, encryptionSecret: undefined, encryptionKeySource: ENCRYPTION_KEY_SOURCE }; persistWallet(); return walletSummary(); });",
    'wallet connect mode'
  );

  src = replaceOnce(src,
    "ipcMain.handle('wallet:disconnect', async () => { walletState = { ...walletState, connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, loginMessage: null, loginSignature: undefined, encryptionSecret: undefined, encryptionKeySource: ENCRYPTION_KEY_SOURCE }; persistWallet(); return walletSummary(); });",
    "ipcMain.handle('wallet:disconnect', async () => { walletState = { ...walletState, connected: false, verified: false, authMode: null, address: '', accountId: '', username: null, seedFingerprint: null, planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, loginMessage: null, loginSignature: undefined, encryptionSecret: undefined, encryptionKeySource: ENCRYPTION_KEY_SOURCE }; persistWallet(); return walletSummary(); });",
    'disconnect clears identity'
  );

  write(mainPath, src);
}

function patchPreload() {
  let src = mustRead(preloadPath);
  if (!src.includes("'seed:create'")) {
    src = src.replace(
      "  'wallet:setPlan',\n",
      "  'wallet:setPlan',\n  'seed:status',\n  'seed:create',\n  'seed:login',\n  'seed:recover',\n"
    );
  }
  write(preloadPath, src);
}

patchMainStable();
patchPreload();
console.log('[seed-account] enabled username + password + recovery seed identity layer');
