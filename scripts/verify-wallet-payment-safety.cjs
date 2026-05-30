const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const mainPath = path.join(root, 'electron', 'main.js');
const wrapperPath = path.join(root, 'electron', 'main-wrapper.js');
const planGuardPath = path.join(root, 'electron', 'wallet-plan-guard.js');
const streamUploadPath = path.join(root, 'electron', 'stream-upload-override.js');
const paypalPath = path.join(root, 'server', 'paypal-checkout.js');
const envExamplePath = path.join(root, '.env.example');

function readRequired(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing required file for wallet/payment verification: ${label}`);
  return fs.readFileSync(filePath, 'utf8');
}

function must(text, needle, label, failures) {
  if (!text.includes(needle)) failures.push(`Missing ${label}: ${needle}`);
}

function mustMatch(text, pattern, label, failures) {
  if (!pattern.test(text)) failures.push(`Missing or invalid ${label}`);
}

function after(text, marker) {
  const index = text.indexOf(marker);
  return index >= 0 ? text.slice(index) : '';
}

const main = readRequired(mainPath, 'electron/main.js');
const wrapper = readRequired(wrapperPath, 'electron/main-wrapper.js');
const planGuard = readRequired(planGuardPath, 'electron/wallet-plan-guard.js');
const streamUpload = readRequired(streamUploadPath, 'electron/stream-upload-override.js');
const paypal = readRequired(paypalPath, 'server/paypal-checkout.js');
const envExample = readRequired(envExamplePath, '.env.example');
const failures = [];

for (const [needle, label] of [
  ['function assertVerifiedWallet()', 'runtime verified identity guard'],
  ['Verified identity required. Connect wallet or sign in with Seed Account first.', 'verified identity error'],
  ['function assertWalletUploadAllowed(nextBytes = 0)', 'runtime quota guard'],
  ['Storage quota exceeded. Current plan:', 'quota exceeded runtime error'],
  ['const FREE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;', 'free quota definition'],
  ['const PLANS = {', 'runtime plan table'],
  ['tb1:', '1TB paid plan'],
  ['tb3:', '3TB paid plan'],
  ['tb7:', '7TB paid plan'],
  ['tb10:', '10TB paid plan'],
  ['async function verifyWalletLoginPayload', 'wallet login verification function'],
  ['verifyMessage({ address: normalizedAddress, message, signature })', 'wallet signature verification'],
  ['Wallet login signature expired. Reconnect wallet.', 'login max-age enforcement'],
  ['Wallet login timestamp is too far in the future', 'future timestamp protection'],
  ["ipcMain.handle('wallet:connect'", 'wallet connect handler'],
  ["ipcMain.handle('wallet:disconnect'", 'wallet disconnect handler'],
  ["ipcMain.handle('wallet:setPlan'", 'wallet setPlan handler'],
  ["ipcMain.handle('p2p:upload'", 'legacy single upload handler'],
  ['assertWalletUploadAllowed(originalBuffer.length)', 'legacy upload runtime quota check'],
  ['planId: walletState.planId', 'manifest records plan id'],
  ['persistWallet();', 'wallet persistence path'],
]) {
  must(main, needle, label, failures);
}

mustMatch(main, /ipcMain\.handle\('wallet:setPlan',[\s\S]*?assertVerifiedWallet\(\)/, 'wallet:setPlan requires verified identity', failures);
mustMatch(main, /ipcMain\.handle\('wallet:setPlan',[\s\S]*?if \(!PLANS\[planId\]\) throw new Error\('Unknown wallet plan'\)/, 'wallet:setPlan validates plan id', failures);
mustMatch(main, /ipcMain\.handle\('wallet:setPlan',[\s\S]*?paidUntil:[\s\S]*payload\.paidUntil/, 'wallet:setPlan records paidUntil metadata', failures);
mustMatch(main, /ipcMain\.handle\('wallet:setPlan',[\s\S]*?subscriptionTx:[\s\S]*payload\.txHash/, 'wallet:setPlan records payment tx metadata', failures);

for (const [needle, label] of [
  ["await import('./wallet-plan-guard.js')", 'wallet plan guard imported by wrapper'],
  ["await importPrimaryRuntime()", 'runtime import marker'],
]) {
  must(wrapper, needle, label, failures);
}
if (wrapper.indexOf("await import('./wallet-plan-guard.js')") > wrapper.indexOf('await importPrimaryRuntime()')) {
  failures.push('wallet-plan-guard must be imported before importPrimaryRuntime()');
}

for (const [needle, label] of [
  ['PLAN_UNLOCK_VERSION', 'plan unlock version'],
  ['plan-unlock-hmac-sha256-v1', 'plan unlock HMAC version'],
  ['function verifyPlanUnlock(payload = {})', 'plan unlock verifier'],
  ['crypto.createHmac(\'sha256\'', 'HMAC signing/verifying'],
  ['crypto.timingSafeEqual', 'timing-safe token compare'],
  ["if (planId === 'free') return;", 'free plan downgrade allowed without token'],
  ["if (channel !== 'wallet:setPlan')", 'only wraps wallet:setPlan'],
]) {
  must(planGuard, needle, label, failures);
}

const legacyUpload = after(main, "ipcMain.handle('p2p:upload'");
if (!legacyUpload.includes('assertWalletUploadAllowed(originalBuffer.length)')) {
  failures.push('Legacy p2p:upload must call assertWalletUploadAllowed(originalBuffer.length)');
}

const mainUploadFiles = after(main, "ipcMain.handle('p2p:uploadFiles'");
if (!mainUploadFiles.includes('assertVerifiedWallet()')) {
  failures.push('main.js p2p:uploadFiles must call assertVerifiedWallet()');
}
if (!mainUploadFiles.includes('assertWalletUploadAllowed(originalBuffer.length)')) {
  failures.push('main.js p2p:uploadFiles must call assertWalletUploadAllowed(originalBuffer.length)');
}

for (const [needle, label] of [
  ['assertVerifiedIdentity(w);', 'stream upload identity guard'],
  ['usedBytes(manifests(), ownerWallet) + stat.size > quotaBytes(w.planId)', 'stream upload quota guard'],
  ["ipcMain.handle('p2p:uploadFiles'", 'stream uploadFiles handler'],
  ["ipcMain.handle('p2p:uploadPath'", 'stream uploadPath handler'],
]) {
  must(streamUpload, needle, label, failures);
}

for (const [needle, label] of [
  ['function signPlanUnlock(payload)', 'payment unlock token signer'],
  ['function hasPayPalCredentials()', 'payment credential check'],
  ['async function createRealPayPalOrder', 'real order creation'],
  ['async function captureRealPayPalOrder', 'real payment capture'],
  ['PayPal payment not completed', 'payment completed status enforcement'],
  ['Subscription plan does not match selected app plan', 'payment plan matching'],
  ['Wallet does not match pending PayPal order', 'payment wallet matching'],
  ['const paidUntil = oneMonthFromNowSeconds();', 'paidUntil issuance after capture'],
  ['planUnlockToken,', 'server returns plan unlock token'],
]) {
  must(paypal, needle, label, failures);
}

for (const [needle, label] of [
  ['PAYPAL_CLIENT_ID=replace-with-paypal-client-id', 'PayPal client id placeholder'],
  ['PAYPAL_CLIENT_SECRET=replace-with-paypal-client-secret', 'PayPal client credential placeholder'],
  ['PAYPAL_ENV=sandbox', 'PayPal env placeholder'],
  ['P2P_PLAN_UNLOCK_SECRET=replace-with-long-random-plan-unlock-secret', 'Electron unlock key placeholder'],
  ['PLAN_UNLOCK_SECRET=replace-with-long-random-plan-unlock-secret', 'server unlock key placeholder'],
]) {
  must(envExample, needle, label, failures);
}

if (failures.length > 0) {
  console.error('[verify-wallet-payment-safety] failed: wallet/payment safety invariants are not enforced');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-wallet-payment-safety] ok: uploads are identity/quota gated and paid plan unlocks require signed server tokens');
