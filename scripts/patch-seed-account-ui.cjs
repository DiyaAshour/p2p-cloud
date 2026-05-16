const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const appPath = path.join(root, 'client', 'src', 'NativeP2PAppLive.tsx');

if (!fs.existsSync(appPath)) {
  console.warn('[seed-account-ui] NativeP2PAppLive.tsx missing; skipping UI patch');
  process.exit(0);
}

const src = fs.readFileSync(appPath, 'utf8');
if (src.includes('Recovery seed — save it now') || src.includes('Wrong password attempts cool down this device only')) {
  console.warn('[seed-account-ui] broken/fragile Seed UI injection detected. patch-live-check-errors will restore NativeP2PAppLive.tsx before TypeScript check.');
} else {
  console.log('[seed-account-ui] skipped fragile UI injection for now; backend Seed Account IPC remains enabled');
}

process.exit(0);
