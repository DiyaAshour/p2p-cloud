const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const preferredPath = path.join(root, 'client', 'src', 'NativeP2PAppLive.tsx');
const fallbackPath = path.join(root, 'client', 'src', 'NativeP2PApp.tsx');
const appPath = fs.existsSync(preferredPath) ? preferredPath : fallbackPath;

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return fs.readFileSync(file, 'utf8');
}
function write(file, content) { fs.writeFileSync(file, content, 'utf8'); }
function replaceOnce(src, from, to, label) {
  if (src.includes(to)) return src;
  if (!src.includes(from)) {
    console.warn(`[seed-account-ui] patch anchor not found, skipping: ${label}`);
    return src;
  }
  return src.replace(from, to);
}

let src = read(appPath);

src = replaceOnce(src,
  '  | "wallet:status" | "wallet:connect" | "wallet:disconnect"\n',
  '  | "wallet:status" | "wallet:connect" | "wallet:disconnect"\n  | "seed:status" | "seed:create" | "seed:login" | "seed:recover"\n',
  'seed IPC channel types'
);

src = replaceOnce(src,
  'type WalletState = { connected: boolean; address: string; usedBytes: number; remainingBytes: number; plan: Plan; plans: Plan[]; minDrivePasswordLength?: number };',
  'type WalletState = { connected: boolean; address: string; accountId?: string; authMode?: "wallet" | "seed" | null; username?: string | null; seedFingerprint?: string | null; usedBytes: number; remainingBytes: number; plan: Plan; plans: Plan[]; minDrivePasswordLength?: number };\ntype SeedAuthResult = WalletState & { seed?: string; created?: boolean };',
  'wallet state seed fields type'
);

src = replaceOnce(src,
  '  const [drivePassword, setDrivePassword] = useState("");\n',
  '  const [drivePassword, setDrivePassword] = useState("");\n  const [seedUsername, setSeedUsername] = useState("");\n  const [seedPassword, setSeedPassword] = useState("");\n  const [seedRecovery, setSeedRecovery] = useState("");\n  const [generatedSeed, setGeneratedSeed] = useState("");\n  const [seedSaved, setSeedSaved] = useState(false);\n  const [seedMode, setSeedMode] = useState<"login" | "create" | "recover">("login");\n',
  'seed account state'
);

src = replaceOnce(src,
  '  const walletConnected = Boolean(wallet?.connected && wallet.address);\n',
  '  const walletConnected = Boolean(wallet?.connected && wallet.address);\n  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.address)}` : walletConnected ? short(wallet?.address) : "Guest";\n',
  'identity label'
);

src = replaceOnce(src,
  '  const connectWallet = () => run(async () => { const address = window.prompt("Wallet address 0x...")?.trim(); if (!address) return; setWallet(await api.invoke<WalletState>("wallet:connect", { address })); await refresh(); });\n  const disconnectWallet = () => run(async () => { setWallet(await api.invoke<WalletState>("wallet:disconnect")); await refresh(); });\n',
  '  const connectWallet = () => run(async () => { const address = window.prompt("Wallet address 0x...")?.trim(); if (!address) return; setGeneratedSeed(""); setSeedSaved(false); setWallet(await api.invoke<WalletState>("wallet:connect", { address })); await refresh(); });\n  const disconnectWallet = () => run(async () => { setGeneratedSeed(""); setSeedSaved(false); setWallet(await api.invoke<WalletState>("wallet:disconnect")); await refresh(); });\n  const createSeedAccount = () => run(async () => { if (generatedSeed && !seedSaved) throw new Error("Save your recovery seed first, then confirm it."); const username = seedUsername.trim(); const password = seedPassword.trim(); if (!username || !password) throw new Error("Username and password are required."); const result = await api.invoke<SeedAuthResult>("seed:create", { username, password }); setWallet(result); setGeneratedSeed(result.seed || ""); setSeedSaved(false); setSeedRecovery(""); await refresh(); toast.success("Seed Account created. Save your recovery seed now."); });\n  const loginSeedAccount = () => run(async () => { const username = seedUsername.trim(); const password = seedPassword.trim(); if (!username || !password) throw new Error("Username and password are required."); const result = await api.invoke<SeedAuthResult>("seed:login", { username, password }); setGeneratedSeed(""); setSeedSaved(false); setWallet(result); await refresh(); toast.success("Signed in with Seed Account. Wrong tries only cool down this device."); });\n  const recoverSeedAccount = () => run(async () => { const username = seedUsername.trim(); const password = seedPassword.trim(); const seed = seedRecovery.trim(); if (!username || !password || !seed) throw new Error("Username, new password, and recovery seed are required."); const result = await api.invoke<SeedAuthResult>("seed:recover", { username, password, seed }); setGeneratedSeed(""); setSeedSaved(false); setWallet(result); await refresh(); toast.success("Seed Account recovered and password reset on this device"); });\n',
  'seed account actions'
);

src = src.replaceAll('Connect your wallet before uploading', 'Connect wallet or sign in with Seed Account before uploading');

const accountCard = '<Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardContent className="space-y-4 p-5"><p className="text-sm text-zinc-400">Account</p><p className="truncate font-medium">{walletConnected ? short(wallet?.address) : "Guest"}</p>{walletConnected ? <Button variant="outline" onClick={disconnectWallet} disabled={busy}>Disconnect Wallet</Button> : <Button onClick={connectWallet} disabled={busy}><Wallet className="size-4" />Connect Wallet</Button>}</CardContent></Card>';
const accountCardReplacement = '<Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardContent className="space-y-4 p-5"><p className="text-sm text-zinc-400">Identity</p><p className="truncate font-medium">{identityLabel}</p><p className="text-xs text-zinc-500">{wallet?.authMode === "seed" ? short(wallet?.seedFingerprint || wallet?.address || "") : walletConnected ? "Wallet identity" : "No identity connected"}</p>{walletConnected ? <Button variant="outline" onClick={disconnectWallet} disabled={busy}>Disconnect</Button> : <Button onClick={connectWallet} disabled={busy}><Wallet className="size-4" />Connect Wallet</Button>}</CardContent></Card><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardHeader><CardTitle className="text-base"><KeyRound className="mr-2 inline size-4" />Seed Account</CardTitle></CardHeader><CardContent className="space-y-3"><div className="grid grid-cols-3 gap-1 rounded-xl bg-zinc-950 p-1 text-xs"><button type="button" onClick={() => setSeedMode("login")} className={`rounded-lg px-2 py-2 ${seedMode === "login" ? "bg-zinc-800" : "text-zinc-500"}`}>Login</button><button type="button" onClick={() => setSeedMode("create")} className={`rounded-lg px-2 py-2 ${seedMode === "create" ? "bg-zinc-800" : "text-zinc-500"}`}>Create</button><button type="button" onClick={() => setSeedMode("recover")} className={`rounded-lg px-2 py-2 ${seedMode === "recover" ? "bg-zinc-800" : "text-zinc-500"}`}>Recover</button></div><p className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400">Wrong password attempts cool down this device only. Another device is not affected. You can always recover with your seed.</p><Input value={seedUsername} onChange={(e) => setSeedUsername(e.target.value)} placeholder="Username" /><Input type="password" value={seedPassword} onChange={(e) => setSeedPassword(e.target.value)} placeholder={seedMode === "recover" ? "New password" : "Password"} />{seedMode === "recover" && <textarea value={seedRecovery} onChange={(e) => setSeedRecovery(e.target.value)} placeholder="Paste recovery seed" className="min-h-24 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none" />}{seedMode === "create" && <p className="text-xs text-amber-300">After create, save the recovery seed. Without it, forgotten passwords cannot be recovered.</p>}{generatedSeed && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3"><p className="text-xs font-medium text-amber-200">Recovery seed — save it now</p><p className="mt-2 break-all rounded-lg bg-zinc-950 p-2 text-xs text-zinc-200">{generatedSeed}</p><Button className="mt-2 w-full" size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(generatedSeed).then(() => toast.success("Seed copied"))}>Copy seed</Button><label className="mt-3 flex items-start gap-2 text-xs text-amber-100"><Checkbox checked={seedSaved} onCheckedChange={(v) => setSeedSaved(Boolean(v))} /><span>I saved this recovery seed. I understand it is required to recover forgotten passwords.</span></label></div>}<Button className="w-full" variant={seedMode === "login" ? "default" : "outline"} onClick={seedMode === "create" ? createSeedAccount : seedMode === "recover" ? recoverSeedAccount : loginSeedAccount} disabled={busy || Boolean(generatedSeed && !seedSaved)}>{generatedSeed && !seedSaved ? "Confirm seed saved first" : seedMode === "create" ? "Create Seed Account" : seedMode === "recover" ? "Recover Account" : "Login with Seed"}</Button></CardContent></Card>';

if (src.includes(accountCardReplacement)) {
  // already patched
} else if (src.includes(accountCard)) {
  src = src.replace(accountCard, accountCardReplacement);
} else {
  console.warn('[seed-account-ui] account card anchor not found; UI may already be customized, skipping card injection');
}

src = src.replaceAll('{walletConnected ? short(wallet?.address) : "Guest view"}', '{identityLabel}');

write(appPath, src);
console.log(`[seed-account-ui] patch completed for ${path.relative(root, appPath)}`);
