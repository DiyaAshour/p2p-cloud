const fs = require('node:fs');
const path = require('node:path');

const appFile = path.join(process.cwd(), 'client', 'src', 'NativeP2PApp.tsx');

if (!fs.existsSync(appFile)) {
  console.log('[patch-upgrade-paypal-ui] NativeP2PApp.tsx not found; skipping');
  process.exit(0);
}

let source = fs.readFileSync(appFile, 'utf8');
let changed = false;

function replaceOnce(find, replacement, label) {
  if (!source.includes(find)) {
    console.warn(`[patch-upgrade-paypal-ui] marker not found: ${label}`);
    return;
  }
  source = source.replace(find, replacement);
  changed = true;
}

// 1) Make Radix Tabs controlled so Upgrade buttons can jump to the Plans tab.
if (!source.includes('const [activeTab, setActiveTab] = useState("files")')) {
  replaceOnce(
    '  const [pendingPayPal, setPendingPayPal] = useState<PendingPayPal | null>(() => safeJson<PendingPayPal | null>("peercloud.pending.paypal", null));',
    '  const [pendingPayPal, setPendingPayPal] = useState<PendingPayPal | null>(() => safeJson<PendingPayPal | null>("peercloud.pending.paypal", null));\n  const [activeTab, setActiveTab] = useState("files");',
    'pendingPayPal state'
  );
}

if (!source.includes('<Tabs value={activeTab} onValueChange={setActiveTab}')) {
  replaceOnce(
    '<Tabs defaultValue="files" className="space-y-5">',
    '<Tabs value={activeTab} onValueChange={setActiveTab} defaultValue="files" className="space-y-5">',
    'Tabs defaultValue'
  );
}

// 2) Add a persistent Upgrade button to the header.
if (!source.includes('Upgrade</Button><Button variant={advancedMode')) {
  replaceOnce(
    '<Button variant="outline" onClick={() => void runBusy(refreshAll)} disabled={busy}><RefreshCw className="size-4" />Refresh</Button><Button variant={advancedMode ? "default" : "outline"} onClick={() => setAdvancedMode((value) => !value)}>',
    '<Button variant="outline" onClick={() => void runBusy(refreshAll)} disabled={busy}><RefreshCw className="size-4" />Refresh</Button><Button onClick={() => setActiveTab("plans")} disabled={busy}><Zap className="size-4" />Upgrade</Button><Button variant={advancedMode ? "default" : "outline"} onClick={() => setAdvancedMode((value) => !value)}>',
    'header Refresh button'
  );
}

// 3) Add an Upgrade call-to-action inside the storage card.
if (!source.includes('Manage storage / Upgrade')) {
  replaceOnce(
    '<p className="text-xs text-zinc-400">{formatBytes(wallet?.usedBytes ?? 0)} of {formatBytes(wallet?.plan?.quotaBytes ?? 0)} · {wallet?.plan?.name || "Free"}</p></CardContent></Card><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><FolderOpen className="size-4" />Folders</CardTitle></CardHeader>',
    '<p className="text-xs text-zinc-400">{formatBytes(wallet?.usedBytes ?? 0)} of {formatBytes(wallet?.plan?.quotaBytes ?? 0)} · {wallet?.plan?.name || "Free"}</p><Button className="w-full" size="sm" onClick={() => setActiveTab("plans")} disabled={busy}><Zap className="size-4" />Manage storage / Upgrade</Button></CardContent></Card><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><FolderOpen className="size-4" />Folders</CardTitle></CardHeader>',
    'storage card text'
  );
}

// 4) Add a homepage upgrade panel with direct PayPal buttons.
if (!source.includes('Upgrade storage with PayPal')) {
  const upgradePanel = `\n\n        <Card className="rounded-2xl border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-950">\n          <CardContent className="grid gap-4 p-5 lg:grid-cols-[1fr_auto] lg:items-center">\n            <div>\n              <div className="mb-2 flex flex-wrap items-center gap-2">\n                <Badge variant="secondary"><Zap className="mr-1 size-3" />Upgrade</Badge>\n                <span className="text-xs text-zinc-500">PayPal checkout enabled</span>\n              </div>\n              <h2 className="text-xl font-semibold">Upgrade storage with PayPal</h2>\n              <p className="mt-1 text-sm text-zinc-400">Current plan: {wallet?.plan?.name || "Free"}. Need more space? Pick a paid plan and confirm the PayPal order inside the app.</p>\n            </div>\n            <div className="flex flex-wrap gap-2 lg:justify-end">\n              {!walletConnected && <Button onClick={() => void connectWallet()} disabled={walletConnecting}><Wallet className="size-4" />Connect Wallet</Button>}\n              {(wallet?.plans || []).filter((plan) => plan.id !== "free").slice(0, 2).map((plan) => (\n                <Button key={plan.id} variant={wallet?.planId === plan.id ? "secondary" : "default"} onClick={() => payWithPayPal(plan)} disabled={busy || !walletConnected || wallet?.planId === plan.id}>\n                  {wallet?.planId === plan.id ? "Active" : `Pay $${plan.priceUsd}/mo`} · {plan.name}\n                </Button>\n              ))}\n              <Button variant="outline" onClick={() => setActiveTab("plans")}>See all plans</Button>\n            </div>\n          </CardContent>\n        </Card>`;

  replaceOnce(
    '\n\n        {pendingPayPal &&',
    `${upgradePanel}\n\n        {pendingPayPal &&`,
    'pendingPayPal panel insertion point'
  );
}

if (changed) {
  fs.writeFileSync(appFile, source, 'utf8');
  console.log('[patch-upgrade-paypal-ui] installed homepage Upgrade + PayPal UI');
} else {
  console.log('[patch-upgrade-paypal-ui] already installed or no changes needed');
}
