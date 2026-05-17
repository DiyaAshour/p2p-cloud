const fs = require('node:fs');

const p = 'client/src/NativeP2PAppLive.tsx';
let s = fs.readFileSync(p, 'utf8');
const before = s;

s = s.replace('  const walletConnected = Boolean(wallet?.connected && (wallet.accountId || wallet.address));\n  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";', '  const walletConnected = Boolean(wallet?.connected && wallet?.authMode !== "seed" && (wallet.accountId || wallet.address));\n  const seedConnected = Boolean(wallet?.connected && wallet?.authMode === "seed" && (wallet.accountId || wallet.username || wallet.seedFingerprint));\n  const identityConnected = Boolean(walletConnected || seedConnected);\n  const identityLabel = seedConnected ? `Seed: ${wallet?.username || short(wallet?.accountId || wallet?.address || "")}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";');
s = s.replace('  const seedConnected = Boolean(wallet?.authMode === "seed" && (wallet.accountId || wallet.username || wallet.seedFingerprint));\n  const identityConnected = Boolean(walletConnected || seedConnected);\n  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";', '  const seedConnected = Boolean(wallet?.connected && wallet?.authMode === "seed" && (wallet.accountId || wallet.username || wallet.seedFingerprint));\n  const identityConnected = Boolean(walletConnected || seedConnected);\n  const identityLabel = seedConnected ? `Seed: ${wallet?.username || short(wallet?.accountId || wallet?.address || "")}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";');

if (!s.includes('const [activeTab, setActiveTab]')) s = s.replace('  const [view, setView] = useState<View>("personal");', '  const [view, setView] = useState<View>("personal");\n  const [activeTab, setActiveTab] = useState<"files" | "upload" | "admin">("files");');
s = s.replace('<Tabs value={view === "admin" ? "admin" : "files"} onValueChange={(tab) => { if (tab === "admin") setView("admin"); }}>', '<Tabs value={activeTab} onValueChange={(tab) => { const nextTab = tab as "files" | "upload" | "admin"; setActiveTab(nextTab); if (nextTab === "admin") setView("admin"); }}>');
s = s.replaceAll('walletConnected={walletConnected}', 'walletConnected={identityConnected}');
s = s.replaceAll('!walletConnected', '!identityConnected');
s = s.replace('  const disconnectWallet = () => run(async () => {\n    setWallet(await api.invoke<WalletState>("wallet:disconnect"));\n    await refresh();\n  });', '  const disconnectWallet = () => run(async () => {\n    const nextWallet = await api.invoke<WalletState>("wallet:disconnect");\n    setWallet(nextWallet);\n    setDrivePassword("");\n    setFiles([]);\n    setActiveFolder(ALL_FILES);\n    await refresh();\n  });');
fs.writeFileSync(p, s, 'utf8');
console.log(s === before ? '[fix-live-clicks] UI already patched' : '[fix-live-clicks] patched upload tab, upload button, and disconnect UI');
if (s.includes('<Tabs value={view === "admin" ? "admin" : "files"}') || s.includes('!walletConnected') || s.includes('const identityLabel = wallet?.authMode === "seed"')) process.exit(1);

const identityHelpers = "function activeIdentity() { const wallet = activeWallet(); if (isValidWallet(wallet)) return wallet; const account = String(walletState.accountId || walletState.address || '').trim().toLowerCase(); if (walletState.authMode === 'seed' && account.startsWith('seed:')) return account; return account; }\nfunction isValidIdentity(identity = '') { const value = String(identity || '').trim().toLowerCase(); return isValidWallet(value) || value.startsWith('seed:'); }\nfunction normalizeIdentity(identity = '') { const value = String(identity || '').trim().toLowerCase(); return isValidIdentity(value) ? value : ''; }\nfunction isVerifiedIdentity() { return Boolean(walletState.connected && walletState.verified && isValidIdentity(activeIdentity())); }\nfunction assertVerifiedIdentity() { if (!isVerifiedIdentity()) throw new Error('Verified identity required. Connect wallet or sign in first.'); }";
function removeIdentityHelpers(source) {
  let next = source;
  for (let i = 0; i < 8; i += 1) {
    const beforeRemove = next;
    next = next.replace(/\n?function activeIdentity\(\) \{[\s\S]*?\}\nfunction isValidIdentity\(identity = ''\) \{[\s\S]*?\}\nfunction normalizeIdentity\(identity = ''\) \{[\s\S]*?\}\nfunction isVerifiedIdentity\(\) \{[\s\S]*?\}\nfunction assertVerifiedIdentity\(\) \{[\s\S]*?\}\n?/m, '\n');
    next = next.replace(/\n?function activeIdentity\(\) \{[\s\S]*?\}\nfunction isValidIdentity\(identity = ''\) \{[\s\S]*?\}\nfunction isVerifiedIdentity\(\) \{[\s\S]*?\}\nfunction assertVerifiedIdentity\(\) \{[\s\S]*?\}\n?/m, '\n');
    next = next.replace(/\n?function isVerifiedIdentity\(\) \{[\s\S]*?\}\nfunction assertVerifiedIdentity\(\) \{[\s\S]*?\}\n?/m, '\n');
    if (next === beforeRemove) break;
  }
  return next;
}

const deriveDriveKeyReplacement = `function deriveDriveKey({ ownerWallet = activeIdentity(), drivePassword, salt }) {
  const wallet = normalizeIdentity(ownerWallet || activeIdentity());
  if (!isValidIdentity(wallet)) throw new Error('Valid wallet or seed identity required for private file encryption.');
  const password = validateDrivePassword(drivePassword);
  const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt || ''), 'base64');
  return crypto.pbkdf2Sync(`${'${wallet}:${password}'}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');
}`;

for (const file of ['electron/main.js', 'electron/main-stable.js']) {
  if (!fs.existsSync(file)) continue;
  let m = fs.readFileSync(file, 'utf8');
  const oldLine = "walletState = { ...walletState, connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, loginMessage: null, loginSignature: undefined, encryptionSecret: undefined, encryptionKeySource: ENCRYPTION_KEY_SOURCE };";
  const newLine = "walletState = { connected: false, verified: false, address: '', accountId: '', authMode: null, username: null, seedFingerprint: null, planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, loginMessage: null, loginSignature: undefined, encryptionSecret: undefined, encryptionKeySource: ENCRYPTION_KEY_SOURCE };";
  if (m.includes(oldLine)) m = m.replace(oldLine, newLine);
  m = m.replace("ipcMain.handle('wallet:status', async () => walletSummary());", "ipcMain.handle('wallet:status', async () => { loadWallet(); return walletSummary(); });");
  m = m.replace("ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => { if (!walletState.connected || !walletState.verified) return [];", "ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => { loadWallet(); if (!walletState.connected || !walletState.verified) return [];");
  m = removeIdentityHelpers(m);
  m = m.replace('function assertVerifiedWallet()', `${identityHelpers}\nfunction assertVerifiedWallet()`);
  m = m.replace(/function deriveDriveKey\([^)]*\) \{[\s\S]*?return crypto\.pbkdf2Sync\([^;]+;\n\}/m, deriveDriveKeyReplacement);
  if (!m.includes("function deriveDriveKey({ ownerWallet = activeIdentity()")) {
    m = m.replace("function deriveDriveKey({ ownerWallet = activeWallet(), drivePassword, salt }) {\n  const wallet = normalizeWallet(ownerWallet);\n  if (!isValidWallet(wallet)) throw new Error('Valid wallet address required for private file encryption.');", "function deriveDriveKey({ ownerWallet = activeIdentity(), drivePassword, salt }) {\n  const wallet = normalizeIdentity(ownerWallet || activeIdentity());\n  if (!isValidIdentity(wallet)) throw new Error('Valid wallet or seed identity required for private file encryption.');");
  }
  m = m.replace(/function encryptPrivateBuffer\(plainBuffer, ownerWallet = activeWallet\(\), drivePassword\)/g, 'function encryptPrivateBuffer(plainBuffer, ownerWallet = activeIdentity(), drivePassword)');
  m = m.replace('function walletOwnsManifest(manifest) { return normalizeWallet(manifest.ownerWallet) === activeWallet(); }', 'function walletOwnsManifest(manifest) { return normalizeIdentity(manifest.ownerWallet) === activeIdentity(); }');
  m = m.replace('function walletSummary() { const plan = PLANS[walletState.planId] || PLANS.free; const usedBytes = walletState.connected ? totalStoredBytesForWallet() : 0; return { ok: true, ...walletState, encryptionSecret: null, loginSignature: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE, minDrivePasswordLength: MIN_DRIVE_PASSWORD_LENGTH, address: activeWallet() || walletState.address, plan, plans: Object.values(PLANS), usedBytes, remainingBytes: Math.max(0, plan.quotaBytes - usedBytes), sync: lastSyncStatus }; }', 'function walletSummary() { const plan = PLANS[walletState.planId] || PLANS.free; const usedBytes = walletState.connected ? totalStoredBytesForWallet() : 0; const identity = activeIdentity(); return { ok: true, ...walletState, encryptionSecret: null, loginSignature: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE, minDrivePasswordLength: MIN_DRIVE_PASSWORD_LENGTH, accountId: identity || walletState.accountId || walletState.address, address: isValidWallet(identity) ? identity : walletState.address, plan, plans: Object.values(PLANS), usedBytes, remainingBytes: Math.max(0, plan.quotaBytes - usedBytes), sync: lastSyncStatus }; }');
  m = m.replace('function assertWalletUploadAllowed(nextBytes = 0) { assertVerifiedWallet(); const plan = PLANS[walletState.planId] || PLANS.free;', 'function assertWalletUploadAllowed(nextBytes = 0) { assertVerifiedIdentity(); const plan = PLANS[walletState.planId] || PLANS.free;');
  m = m.replace("if (!isManifestSyncEnabled() || !walletState.connected || !walletState.address) return { ok: false, skipped: true };", "if (!isManifestSyncEnabled() || !walletState.connected || !activeIdentity()) return { ok: false, skipped: true };");
  m = m.replaceAll('assertVerifiedWallet();\n  const stat = fs.statSync(filePath);', 'assertVerifiedIdentity();\n  const stat = fs.statSync(filePath);');
  m = m.replaceAll('assertVerifiedWallet(); const plan = PLANS[walletState.planId] || PLANS.free;', 'assertVerifiedIdentity(); const plan = PLANS[walletState.planId] || PLANS.free;');
  m = m.replaceAll('const ownerWallet = activeWallet();', 'const ownerWallet = activeIdentity();');
  m = m.replaceAll('normalizeWallet(manifest.ownerWallet) === activeWallet()', 'normalizeIdentity(manifest.ownerWallet) === activeIdentity()');
  m = m.replaceAll('pullWalletManifests(activeWallet())', 'pullWalletManifests(activeIdentity())');
  m = m.replaceAll('await syncDelete(activeWallet(), manifest.hash)', 'await syncDelete(activeIdentity(), manifest.hash)');
  if (m.includes('Valid wallet address required for private file encryption')) {
    console.error(`[fix-live-clicks] stale wallet-only encryption guard remains in ${file}`);
    process.exit(1);
  }
  fs.writeFileSync(file, m, 'utf8');
  console.log(`[fix-live-clicks] patched ${file} seed identity ownership/encryption/session helpers`);
}
