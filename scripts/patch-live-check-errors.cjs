const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const livePath = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');

function readLive() {
  return fs.existsSync(livePath) ? fs.readFileSync(livePath, 'utf8') : '';
}

let live = readLive();

const looksBrokenSeedInjection = live.includes('Recovery seed — save it now') || live.includes('Wrong password attempts cool down this device only');
if (looksBrokenSeedInjection) {
  try {
    execFileSync('git', ['checkout', '--', 'client/src/NativeP2PAppLive.tsx'], { cwd: process.cwd(), stdio: 'ignore' });
    live = readLive();
    console.log('[patch-live-check-errors] restored NativeP2PAppLive.tsx from git because Seed UI injection broke JSX');
  } catch (error) {
    console.warn('[patch-live-check-errors] could not restore NativeP2PAppLive.tsx from git:', error?.message || error);
  }
}

live = live.replace(
  'type WalletState = { connected: boolean; address: string; usedBytes: number; remainingBytes: number; plan: Plan; plans: Plan[]; minDrivePasswordLength?: number };',
  'type WalletState = { connected: boolean; address: string; planId?: string; accountId?: string; authMode?: "wallet" | "seed" | null; username?: string | null; seedFingerprint?: string | null; usedBytes: number; remainingBytes: number; plan: Plan; plans: Plan[]; minDrivePasswordLength?: number };'
);

if (!live.includes('const runBusy = run;')) {
  live = live.replace(
    '  const run = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } catch (e) { toast.error(err(e)); } finally { setBusy(false); } };',
    '  const run = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } catch (e) { toast.error(err(e)); } finally { setBusy(false); } };\n  const runBusy = run;'
  );
}

fs.writeFileSync(livePath, live, 'utf8');

const tsconfigPath = path.join(process.cwd(), 'tsconfig.json');
let tsconfig = fs.readFileSync(tsconfigPath, 'utf8');
if (!tsconfig.includes('client/src/NativeP2PAppStable.tsx')) {
  tsconfig = tsconfig.replace(
    '"client/src/NativeP2PApp.tsx"',
    '"client/src/NativeP2PApp.tsx", "client/src/NativeP2PAppStable.tsx"'
  );
  fs.writeFileSync(tsconfigPath, tsconfig, 'utf8');
}

console.log('[patch-live-check-errors] fixed WalletState.planId, runBusy alias, and excluded old stable app from TS check');
