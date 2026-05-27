const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const mainPath = path.join(root, 'electron', 'main.js');
const wrapperPath = path.join(root, 'electron', 'main-wrapper.js');
const planGuardPath = path.join(root, 'electron', 'wallet-plan-guard.js');
const paypalPath = path.join(root, 'server', 'paypal-checkout.js');
const envExamplePath = path.join(root, '.env.example');

function readRequired(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing required file for wallet/payment verification: ${label}`);
  return fs.readFileSync(filePath, 'utf8');
}

function assertIncludes(text, needle, label, failures) {
  if (!text.includes(needle)) failures.push(`Missing ${label}: ${needle}`);
}

function assertMatches(text, pattern, label, failures) {
  if (!pattern.test(text)) failures.push(`Missing or invalid ${label}`);
}

const main = readRequired(mainPath, 'electron/main.js');
const wrapper = readRequired(wrapperPath, 'electron/main-wrapper.js');
const planGuard = readRequired(planGuardPath, 'electron/wallet-plan-guard.js');
const paypal = readRequired(paypalPath, 'server/paypal-checkout.js');
const envExample = readRequired(envExamplePath, '.env.example');
const failures = [];

for (const [needle, label] of [
  ['function assertVerifiedWallet()', 'runtime verified wallet guard'],
  ['Verified identity required. Connect wallet or sign in with Seed Account first.', 'verified identity error'],
  ['function assertWalletUploadAllowed(nextBytes = 0)', 'upload quota guard'],
  ['assertVerifiedWallet(); const plan = PLANS[walletState.planId] || PLANS.free;', 'upload guard verifies identity before quota'],
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
  ["ipcMain.handle('p2p:upload'", 'single upload handler'],
  ['assertWalletUploadAllowed(originalBuffer.length)', 'single upload runtime quota check'],
  ['planId: walletState.planId', 'manifest records plan id'],
  ['persistWallet();', 'wallet persistence path'],
]) {
  assertIncludes(main, needle, label, failures);
}

assertMatches(main, /ipcMain\.handle\('wallet:setPlan',[\s\S]*?assertVerifiedWallet\(\)/, 'wallet:setPlan requires verified identity', failures);
assertMatches(main, /ipcMain\.handle\('wallet:setPlan',[\s\S]*?if \(!PLANS\[planId\]\) throw new Error\('Unknown wallet plan'\)/, 'wallet:setPlan validates plan id', failures);
assertMatches(main, /ipcMain\.handle\('wallet:setPlan',[\s\S]*?paidUntil:[\s\S]*payload\.paidUntil/, 'wallet:setPlan records paidUntil metadata', failures);
assertMatches(main, /ipcMain\.handle\('wallet:setPlan',[\s\S]*?subscriptionTx:[\s\S]*payload\.txHash/, 'wallet:setPlan records payment tx metadata', failures);

// Signed unlock guard must wrap wallet:setPlan before main.js registers handlers.
for (const [needle, label] of [
  ["await import('./wallet-plan-guard.js')", 'wallet plan guard imported by wrapper'],
  ["await importPrimaryRuntime()", 'runtime import marker'],
]) {
  assertIncludes(wrapper, needle, label, failures);
}
if (wrapper.indexOf("await import('./wallet-plan-guard.js')") > wrapper.indexOf('await importPrimaryRuntime()')) {
  failures.push('wallet-plan-guard must be imported before importPrimaryRuntime()');
}

for (const [needle, label] of [
  ['PLAN_UNLOCK_VERSION', 'plan unlock version'],
  ['plan-unlock-hmac-sha256-v1', 'plan unlock HMAC version'],
  ['function verifyPlanUnlock(payload = {})', 'plan unlock verifier'],
  ['Paid plan unlock is disabled: P2P_PLAN_UNLOCK_SECRET is not configured', 'paid plan disabled without secret'],
  ['Paid plan unlock requires a future paidUntil timestamp', 'future paidUntil guard'],
  ['Paid plan unlock token is missing or invalid', 'token format guard'],
  ['Paid plan unlock token verification failed', 'token verification failure'],
  ['crypto.createHmac(\'sha256\'', 'HMAC signing/verifying'],
  ['crypto.timingSafeEqual', 'timing-safe token compare'],
  ['if (planId === \'free\') return;', 'free plan downgrade allowed without token'],
  ["if (channel !== 'wallet:setPlan')", 'only wraps wallet:setPlan'],
]) {
  assertIncludes(planGuard, needle, label, failures);
}

// Upload-like handlers must not bypass the runtime upload guard.
const uploadHandlerMatches = [...main.matchAll(/ipcMain\.handle\('p2p:(?:upload|uploadFiles|uploadFolder|uploadPath)'[\s\S]*?\}\);/g)];
if (!uploadHandlerMatches.length) failures.push('No upload handlers found for wallet/payment gating verification');
for (const match of uploadHandlerMatches) {
  const handler = match[0];
  if (!handler.includes('assertWalletUploadAllowed(') && !handler.includes('assertVerifiedWallet()')) {
    failures.push('Upload handler found without assertWalletUploadAllowed/assertVerifiedWallet guard');
  }
}

for (const [needle, label] of [
  ['import crypto from \'node:crypto\';', 'PayPal crypto import'],
  ['const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID ||', 'PayPal client id env'],
  ['const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET ||', 'PayPal client secret env'],
  ['const PLAN_UNLOCK_VERSION = \'plan-unlock-hmac-sha256-v1\';', 'PayPal plan unlock version'],
  ['const PLAN_UNLOCK_SECRET = String(process.env.P2P_PLAN_UNLOCK_SECRET || process.env.PLAN_UNLOCK_SECRET || \'\').trim();', 'PayPal plan unlock secret'],
  ['function signPlanUnlock(payload)', 'PayPal plan unlock signer'],
  ['crypto.createHmac(\'sha256\', PLAN_UNLOCK_SECRET)', 'PayPal HMAC signer'],
  ['function hasPayPalCredentials()', 'PayPal credential check'],
  ['async function createRealPayPalOrder', 'real PayPal order creation'],
  ['async function captureRealPayPalOrder', 'real PayPal capture'],
  ['if (status && status !== \'COMPLETED\') throw new Error(`PayPal payment not completed: ${status}`);', 'PayPal completed status enforcement'],
  ['if (pending?.planId && pending.planId !== plan.id) throw new Error(\'Subscription plan does not match selected app plan\')', 'PayPal plan matching'],
  ['if (pending?.wallet && wallet && pending.wallet !== wallet) throw new Error(\'Wallet does not match pending PayPal order\')', 'PayPal wallet matching'],
  ['const paidUntil = oneMonthFromNowSeconds();', 'paidUntil issuance after capture'],
  ['const planUnlockToken = signPlanUnlock({ wallet: unlockWallet, planId: plan.id, paidUntil, orderId });', 'PayPal signed unlock token issuance'],
  ['planUnlockToken,', 'PayPal returns plan unlock token'],
]) {
  assertIncludes(paypal, needle, label, failures);
}

for (const [needle, label] of [
  ['PAYPAL_CLIENT_ID=replace-with-paypal-client-id', 'PayPal client id placeholder'],
  ['PAYPAL_CLIENT_SECRET=replace-with-paypal-client-secret', 'PayPal client secret placeholder'],
  ['PAYPAL_ENV=sandbox', 'PayPal env placeholder'],
  ['P2P_PLAN_UNLOCK_SECRET=replace-with-long-random-plan-unlock-secret', 'Electron plan unlock secret placeholder'],
  ['PLAN_UNLOCK_SECRET=replace-with-long-random-plan-unlock-secret', 'PayPal plan unlock secret placeholder'],
]) {
  assertIncludes(envExample, needle, label, failures);
}

if (failures.length > 0) {
  console.error('[verify-wallet-payment-safety] failed: wallet/payment safety invariants are not enforced');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-wallet-payment-safety] ok: uploads are identity/quota gated and paid plan unlocks require signed server tokens');
