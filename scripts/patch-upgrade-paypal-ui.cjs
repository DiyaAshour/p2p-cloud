const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(process.cwd(), 'client', 'src');

function walk(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.(tsx|jsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function patchCheckErrors() {
  const livePath = path.join(srcDir, 'NativeP2PAppLive.tsx');
  if (fs.existsSync(livePath)) {
    let live = fs.readFileSync(livePath, 'utf8');
    const oldWallet = 'type WalletState = { connected: boolean; address: string; usedBytes: number; remainingBytes: number; plan: Plan; plans: Plan[]; minDrivePasswordLength?: number };';
    const newWallet = 'type WalletState = { connected: boolean; address: string; planId?: string; accountId?: string; authMode?: "wallet" | "seed" | null; username?: string | null; seedFingerprint?: string | null; usedBytes: number; remainingBytes: number; plan: Plan; plans: Plan[]; minDrivePasswordLength?: number };';
    if (live.includes(oldWallet)) live = live.replace(oldWallet, newWallet);
    if (!live.includes('const runBusy = run;') && live.includes('const run = async (work: () => Promise<void>) =>')) {
      const line = '  const run = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } catch (e) { toast.error(err(e)); } finally { setBusy(false); } };';
      live = live.replace(line, `${line}\n  const runBusy = run;`);
    }
    fs.writeFileSync(livePath, live, 'utf8');
  }

  const tsconfigPath = path.join(process.cwd(), 'tsconfig.json');
  if (fs.existsSync(tsconfigPath)) {
    let tsconfig = fs.readFileSync(tsconfigPath, 'utf8');
    if (!tsconfig.includes('client/src/NativeP2PAppStable.tsx')) {
      tsconfig = tsconfig.replace('"client/src/NativeP2PApp.tsx"', '"client/src/NativeP2PApp.tsx", "client/src/NativeP2PAppStable.tsx"');
      fs.writeFileSync(tsconfigPath, tsconfig, 'utf8');
    }
  }
}

patchCheckErrors();

const candidates = walk(srcDir)
  .map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }))
  .filter(({ source }) =>
    source.includes('Chunknet Drive') ||
    source.includes('Encrypted storage that stays close to you') ||
    (source.includes('My Files') && source.includes('Upload') && source.includes('Storage'))
  );

if (!candidates.length) {
  console.warn('[patch-upgrade-paypal-ui] active drive UI file not found; skipping');
  process.exit(0);
}

const target = candidates[0];
const appFile = target.file;
let source = target.source;
let changed = false;

function mark() { changed = true; }
function replace(find, replacement, label) {
  if (!source.includes(find)) {
    console.warn(`[patch-upgrade-paypal-ui] marker not found: ${label}`);
    return false;
  }
  source = source.replace(find, replacement);
  mark();
  return true;
}
function insertAfter(marker, addition, label) {
  if (source.includes(addition.trim().slice(0, 80))) return true;
  const i = source.indexOf(marker);
  if (i < 0) {
    console.warn(`[patch-upgrade-paypal-ui] marker not found: ${label}`);
    return false;
  }
  source = source.slice(0, i + marker.length) + addition + source.slice(i + marker.length);
  mark();
  return true;
}

// Repair older injected output if present.
if (source.includes('disabled={walletConnecting}')) {
  source = source.replaceAll('disabled={walletConnecting}', 'disabled={busy}');
  mark();
}

if (!source.includes('function safeJson')) {
  const helper = '\nfunction safeJson<T>(key: string, fallback: T): T { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }\n';
  if (source.includes('function formatBytes')) {
    source = source.replace('function formatBytes', `${helper}\nfunction formatBytes`);
  } else {
    const marker = 'export default function';
    source = source.replace(marker, `${helper}\n${marker}`);
  }
  mark();
}

if (!source.includes('const PAYPAL_SERVER_BASE')) {
  if (source.includes('const ALL_FILES =')) {
    source = source.replace('const ALL_FILES =', 'const PAYPAL_SERVER_BASE = import.meta.env.VITE_PAYPAL_SERVER_BASE || "http://127.0.0.1:8791";\nconst ALL_FILES =');
  } else {
    const marker = 'export default function';
    source = source.replace(marker, 'const PAYPAL_SERVER_BASE = import.meta.env.VITE_PAYPAL_SERVER_BASE || "http://127.0.0.1:8791";\n\n' + marker);
  }
  mark();
}

if (!source.includes('type PendingPayPal')) {
  if (source.includes('type WalletConnectResult')) {
    source = source.replace('type WalletConnectResult', 'type PendingPayPal = { orderId: string; planId: string; approveUrl?: string };\ntype WalletConnectResult');
  } else {
    source = source.replace('declare global', 'type PendingPayPal = { orderId: string; planId: string; approveUrl?: string };\n\ndeclare global');
  }
  mark();
}

if (!source.includes('const [activeTab, setActiveTab]')) {
  const marker = 'const [pendingPayPal, setPendingPayPal]';
  const fallback = 'const [busy, setBusy]';
  const stateMarker = source.includes(marker) ? marker : fallback;
  const i = source.indexOf(stateMarker);
  if (i >= 0) {
    const eol = source.indexOf('\n', i);
    source = source.slice(0, eol + 1) + '  const [activeTab, setActiveTab] = useState("files");\n' + source.slice(eol + 1);
    mark();
  }
}

if (!source.includes('const [pendingPayPal, setPendingPayPal]')) {
  const i = source.indexOf('const [activeTab, setActiveTab]');
  if (i >= 0) {
    const eol = source.indexOf('\n', i);
    source = source.slice(0, eol + 1) + '  const [pendingPayPal, setPendingPayPal] = useState<PendingPayPal | null>(() => safeJson<PendingPayPal | null>("peercloud.pending.paypal", null));\n' + source.slice(eol + 1);
    mark();
  }
}

if (!source.includes('const payWithPayPal =')) {
  const marker = 'const logoutAuth =';
  const i = source.indexOf(marker);
  if (i >= 0) {
    const helpers = '  const copyPaymentLink = async (url?: string) => { if (!url) throw new Error("No PayPal payment link available"); await navigator.clipboard.writeText(url); toast.success("Payment link copied"); };\n' +
      '  const payWithPayPal = (plan: WalletPlan) => runBusy(async () => { if (!walletConnected || !wallet?.address) throw new Error("Connect wallet before payment"); const response = await fetch(`${PAYPAL_SERVER_BASE}/api/paypal/create-order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: wallet.address, planId: plan.id }) }); const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || "PayPal create-order failed"); const pending = { orderId: data.orderId, planId: plan.id, approveUrl: data.approveUrl }; localStorage.setItem("peercloud.pending.paypal", JSON.stringify(pending)); setPendingPayPal(pending); await copyPaymentLink(data.approveUrl); toast.success("PayPal order created. Open the copied link, pay, then confirm."); });\n' +
      '  const confirmPayPal = () => runBusy(async () => { if (!pendingPayPal) throw new Error("No pending PayPal order"); const response = await fetch(`${PAYPAL_SERVER_BASE}/api/paypal/capture-order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: pendingPayPal.orderId }) }); const data = await response.json(); if (!response.ok || !data.ok || !data.subscription) throw new Error(data.error || "PayPal capture failed"); const sub = data.subscription; const nextWallet = await bridge.invoke<WalletState>("wallet:setPlan", { planId: sub.planId, paidUntil: sub.paidUntil, quotaBytes: sub.quotaBytes, txHash: sub.captureId }); setWallet(nextWallet); localStorage.removeItem("peercloud.pending.paypal"); setPendingPayPal(null); toast.success(`${nextWallet.plan.name} unlocked`); await refreshAll(); });\n';
    source = source.slice(0, i) + helpers + source.slice(i);
    mark();
  }
}

if (!source.includes('<Tabs value={activeTab} onValueChange={setActiveTab}')) {
  source = source.replace('<Tabs defaultValue="files"', '<Tabs value={activeTab} onValueChange={setActiveTab} defaultValue="files"');
  mark();
}

if (!source.includes('>Upgrade</Button>')) {
  insertAfter('<Button variant="outline" onClick={() => void runBusy(refreshAll)} disabled={busy}><RefreshCw className="size-4" />Refresh</Button>', '<Button onClick={() => setActiveTab("plans")} disabled={busy}><Zap className="size-4" />Upgrade</Button>', 'header refresh button');
}

if (!source.includes('Manage storage / Upgrade')) {
  insertAfter('· {wallet?.plan?.name || "Free"}</p>', '<Button className="w-full" size="sm" onClick={() => setActiveTab("plans")} disabled={busy}><Zap className="size-4" />Manage storage / Upgrade</Button>', 'storage plan text');
}

if (!source.includes('<TabsTrigger value="plans">Plans</TabsTrigger>')) {
  insertAfter('<TabsTrigger value="upload">Upload</TabsTrigger>', '<TabsTrigger value="plans">Plans</TabsTrigger>', 'upload tab trigger');
}

if (!source.includes('Upgrade storage with PayPal')) {
  const panel = '\n\n        <Card className="rounded-2xl border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-950">\n' +
    '          <CardContent className="grid gap-4 p-5 lg:grid-cols-[1fr_auto] lg:items-center">\n' +
    '            <div><Badge variant="secondary"><Zap className="mr-1 size-3" />Upgrade</Badge><h2 className="mt-2 text-xl font-semibold">Upgrade storage with PayPal</h2><p className="mt-1 text-sm text-zinc-400">Current plan: {wallet?.plan?.name || "Free"}. Choose more space and confirm the PayPal order inside the app.</p></div>\n' +
    '            <div className="flex flex-wrap gap-2 lg:justify-end">\n' +
    '              {!walletConnected && <Button onClick={() => void connectWallet()} disabled={busy}><Wallet className="size-4" />Connect Wallet</Button>}\n' +
    '              {(wallet?.plans || []).filter((plan) => plan.id !== "free").slice(0, 2).map((plan) => <Button key={plan.id} onClick={() => payWithPayPal(plan)} disabled={busy || !walletConnected || wallet?.planId === plan.id}>{wallet?.planId === plan.id ? "Active" : "Pay $" + plan.priceUsd + "/mo"} · {plan.name}</Button>)}\n' +
    '              <Button variant="outline" onClick={() => setActiveTab("plans")}>See all plans</Button>\n' +
    '            </div>\n' +
    '          </CardContent>\n' +
    '        </Card>';
  if (!replace('</section>\n\n        {pendingPayPal &&', `</section>${panel}\n\n        {pendingPayPal &&`, 'before pending PayPal')) {
    replace('</section>\n\n        <Tabs', `</section>${panel}\n\n        <Tabs`, 'before tabs');
  }
}

if (!source.includes('Pending PayPal payment')) {
  const pending = '\n\n        {pendingPayPal && <Card className="rounded-2xl border-amber-800 bg-amber-950/40"><CardContent className="flex flex-col gap-3 p-5 lg:flex-row lg:items-center lg:justify-between"><div><p className="font-semibold text-amber-100">Pending PayPal payment</p><p className="break-all text-sm text-amber-200/80">Order: {pendingPayPal.orderId}</p></div><div className="flex flex-wrap gap-2"><Button onClick={confirmPayPal} disabled={busy}>Confirm Payment</Button>{pendingPayPal.approveUrl && <Button variant="outline" onClick={() => void runBusy(async () => copyPaymentLink(pendingPayPal.approveUrl))}>Copy Link</Button>}<Button variant="ghost" onClick={() => { localStorage.removeItem("peercloud.pending.paypal"); setPendingPayPal(null); }}>Cancel</Button></div></CardContent></Card>}';
  replace('<Tabs', `${pending}\n\n        <Tabs`, 'tabs start for pending PayPal card');
}

if (!source.includes('<TabsContent value="plans"')) {
  const plans = '\n\n          <TabsContent value="plans"><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardHeader><CardTitle>Upgrade storage</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{(wallet?.plans || []).map((plan) => <Card key={plan.id} className="rounded-2xl border-zinc-800 bg-zinc-950"><CardContent className="space-y-3 p-5"><div><p className="text-lg font-semibold">{plan.name}</p><p className="text-sm text-zinc-400">{formatBytes(plan.quotaBytes)}</p></div><p className="text-2xl font-bold">${plan.priceUsd}/mo</p>{plan.id === "free" ? <Button variant="outline" disabled={wallet?.planId === plan.id} onClick={() => setPlan("free")}>{wallet?.planId === plan.id ? "Current" : "Use Free"}</Button> : <Button onClick={() => payWithPayPal(plan)} disabled={busy || !walletConnected || wallet?.planId === plan.id}>{wallet?.planId === plan.id ? "Current Plan" : "Pay with PayPal"}</Button>}</CardContent></Card>)}</CardContent></Card></TabsContent>';
  replace('\n        </Tabs>', `${plans}\n        </Tabs>`, 'tabs close');
}

patchCheckErrors();

if (changed) {
  fs.writeFileSync(appFile, source, 'utf8');
  console.log(`[patch-upgrade-paypal-ui] installed Upgrade + PayPal UI in ${path.relative(process.cwd(), appFile)}`);
} else {
  console.log(`[patch-upgrade-paypal-ui] already installed in ${path.relative(process.cwd(), appFile)}`);
}
