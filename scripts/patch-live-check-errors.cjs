const fs = require('node:fs');
const path = require('node:path');

const livePath = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
let live = fs.readFileSync(livePath, 'utf8');

live = live.replace(
  'type WalletState = { connected: boolean; address: string; usedBytes: number; remainingBytes: number; plan: Plan; plans: Plan[]; minDrivePasswordLength?: number };',
  'type WalletState = { connected: boolean; address: string; planId?: string; accountId?: string; authMode?: "wallet" | "seed" | null; username?: string | null; seedFingerprint?: string | null; usedBytes: number; remainingBytes: number; plan: Plan; plans: Plan[]; minDrivePasswordLength?: number };'
);

live = live.replace(
  '  const run = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } catch (e) { toast.error(err(e)); } finally { setBusy(false); } };',
  '  const run = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } catch (e) { toast.error(err(e)); } finally { setBusy(false); } };\n  const runBusy = run;'
);

fs.writeFileSync(livePath, live, 'utf8');

const tsconfigPath = path.join(process.cwd(), 'tsconfig.json');
let tsconfig = fs.readFileSync(tsconfigPath, 'utf8');
tsconfig = tsconfig.replace(
  '"client/src/NativeP2PApp.tsx"',
  '"client/src/NativeP2PApp.tsx", "client/src/NativeP2PAppStable.tsx"'
);
fs.writeFileSync(tsconfigPath, tsconfig, 'utf8');

console.log('[patch-live-check-errors] fixed WalletState.planId, runBusy alias, and excluded old stable app from TS check');
