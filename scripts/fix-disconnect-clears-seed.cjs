const fs = require('node:fs');
const path = require('node:path');

for (const rel of ['electron/main.js', 'electron/main-stable.js']) {
  const file = path.join(process.cwd(), rel);
  if (!fs.existsSync(file)) continue;
  let s = fs.readFileSync(file, 'utf8');
  const before = s;
  s = s.replace(
    "walletState = { ...walletState, connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, loginMessage: null, loginSignature: undefined, encryptionSecret: undefined, encryptionKeySource: ENCRYPTION_KEY_SOURCE };",
    "walletState = { connected: false, verified: false, address: '', accountId: '', authMode: null, username: null, seedFingerprint: null, planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, loginMessage: null, loginSignature: undefined, encryptionSecret: undefined, encryptionKeySource: ENCRYPTION_KEY_SOURCE };"
  );
  if (s !== before) {
    fs.writeFileSync(file, s, 'utf8');
    console.log(`[disconnect-seed-cleanup] patched ${rel}`);
  } else {
    console.log(`[disconnect-seed-cleanup] ok ${rel}`);
  }
}
