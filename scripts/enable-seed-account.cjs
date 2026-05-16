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
  if (!src.includes(from)) {
    console.warn(`[seed-account] patch anchor not found, skipping: ${label}`);
    return src;
  }
  return src.replace(from, to);
}

function ensureAfter(src, marker, addition, label) {
  if (src.includes(addition.trim().slice(0, 80))) return src;
  const index = src.indexOf(marker);
  if (index < 0) {
    console.warn(`[seed-account] insertion marker not found, skipping: ${label}`);
    return src;
  }
  return src.slice(0, index + marker.length) + addition + src.slice(index + marker.length);
}

function patchMainStable() {
  let src = mustRead(mainPath);

  if (!src.includes("const SEED_ACCOUNT_KEY_SOURCE = 'seed-account-v1';")) {
    src = ensureAfter(
      src,
      "const ENCRYPTION_KEY_SOURCE = 'wallet-password-v1';",
      "\nconst SEED_ACCOUNT_KEY_SOURCE = 'seed-account-v1';\nconst SEED_ACCOUNT_PREFIX = 'seed:';",
      'seed constants'
    );
  }

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
    "function walletSummary() { const plan = PLANS[walletState.planId] || PLANS.free; const usedBytes = walletState.connected ? totalStoredBytesForWallet() : 0; return { ok: true, ...walletState, encryptionSecret: null, loginSignature: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE, minDrivePasswordLength: MIN_DRIVE_PASSWORD_LENGTH, address: activeWallet() || walletState.address, plan, plans: Object.values(PLANS), usedBytes, remainingBytes: Math.max(0, plan.quotaBytes - usedBytes), sync: lastSyncStatus }; }",
    "function walletSummary() { const plan = PLANS[walletState.planId] || PLANS.free; const usedBytes = walletState.connected ? totalStoredBytesForWallet() : 0; return { ok: true, ...walletState, encryptionSecret: null, loginSignature: null, encryptionKeySource: walletState.encryptionKeySource || keySourceForIdentity(), minDrivePasswordLength: MIN_DRIVE_PASSWORD_LENGTH, address: activeWallet() || walletState.address, accountId: activeWallet(), plan, plans: Object.values(PLANS), usedBytes, remainingBytes: Math.max(0, plan.quotaBytes - usedBytes), sync: lastSyncStatus }; }",
    'wallet summary seed account'
  );

  src = replaceOnce(src,
    "function deriveDriveKey({ ownerWallet = activeWallet(), drivePassword, salt }) {\n  const wallet = normalizeWallet(ownerWallet);\n  if (!isValidWallet(wallet)) throw new Error('Valid wallet address required for private file encryption.');\n  const password = validateDrivePassword(drivePassword);\n  const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt || ''), 'base64');\n  return crypto.pbkdf2Sync(`${wallet}:${password}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');\n}",
    "function deriveDriveKey({ ownerWallet = activeWallet(), drivePassword, salt }) {\n  const identity = normalizeWallet(ownerWallet);\n  const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt || ''), 'base64');\n  if (isSeedAccountId(identity)) {\n    const seedSessionSecret = globalThis.__chunknetSeedSession?.get?.(identity) || walletState.encryptionSecret;\n    if (!seedSessionSecret || activeWallet() !== identity) throw new Error('Seed Account is locked. Sign in with username + password, or recover with seed.');\n    return crypto.pbkdf2Sync(`${identity}:${seedSessionSecret}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');\n  }\n  if (!isValidWallet(identity)) throw new Error('Valid wallet or seed account required for private file encryption.');\n  const password = validateDrivePassword(drivePassword);\n  return crypto.pbkdf2Sync(`${identity}:${password}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');\n}",
    'derive drive key seed account'
  );

  src = replaceOnce(src,
    "      keySource: ENCRYPTION_KEY_SOURCE,",
    "      keySource: keySourceForIdentity(ownerWallet),",
    'dynamic encrypted file key source'
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
console.log('[seed-account] patch completed');
