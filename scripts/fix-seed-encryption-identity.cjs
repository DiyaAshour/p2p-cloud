const fs = require('node:fs');

const helpers = "function activeIdentity() { const wallet = activeWallet(); if (isValidWallet(wallet)) return wallet; const account = String(walletState.accountId || walletState.address || '').trim().toLowerCase(); if (walletState.authMode === 'seed' && account.startsWith('seed:')) return account; return account; }\nfunction isValidIdentity(identity = '') { const value = String(identity || '').trim().toLowerCase(); return isValidWallet(value) || value.startsWith('seed:'); }\nfunction isVerifiedIdentity() { return Boolean(walletState.connected && walletState.verified && isValidIdentity(activeIdentity())); }\nfunction assertVerifiedIdentity() { if (!isVerifiedIdentity()) throw new Error('Verified identity required. Connect wallet or sign in first.'); }";

for (const file of ['electron/main.js', 'electron/main-stable.js']) {
  if (!fs.existsSync(file)) continue;
  let s = fs.readFileSync(file, 'utf8');
  const before = s;
  if (!s.includes('function activeIdentity()')) s = s.replace('function assertVerifiedWallet()', `${helpers}\nfunction assertVerifiedWallet()`);
  s = s.replace("function deriveDriveKey({ ownerWallet = activeWallet(), drivePassword, salt }) {\n  const wallet = normalizeWallet(ownerWallet);\n  if (!isValidWallet(wallet)) throw new Error('Valid wallet address required for private file encryption.');", "function deriveDriveKey({ ownerWallet = activeIdentity(), drivePassword, salt }) {\n  const wallet = String(ownerWallet || activeIdentity()).trim().toLowerCase();\n  if (!isValidIdentity(wallet)) throw new Error('Valid wallet or seed identity required for private file encryption.');");
  s = s.replaceAll('assertVerifiedWallet();\n  const stat = fs.statSync(filePath);', 'assertVerifiedIdentity();\n  const stat = fs.statSync(filePath);');
  s = s.replaceAll('assertVerifiedWallet(); const plan = PLANS[walletState.planId] || PLANS.free;', 'assertVerifiedIdentity(); const plan = PLANS[walletState.planId] || PLANS.free;');
  s = s.replaceAll('const ownerWallet = activeWallet();', 'const ownerWallet = activeIdentity();');
  s = s.replaceAll('normalizeWallet(manifest.ownerWallet) === activeWallet()', 'String(manifest.ownerWallet || "").toLowerCase() === activeIdentity()');
  s = s.replaceAll('pullWalletManifests(activeWallet())', 'pullWalletManifests(activeIdentity())');
  if (s !== before) fs.writeFileSync(file, s, 'utf8');
  console.log(s === before ? `[seed-encryption-identity] ok ${file}` : `[seed-encryption-identity] patched ${file}`);
}
