const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(file)) {
  console.log('[fix-paypal-button-final] NativeP2PAppLive.tsx not found');
  process.exit(0);
}

let source = fs.readFileSync(file, 'utf8');
let changed = false;
const mark = () => { changed = true; };

function replaceAllOnce(find, replacement) {
  if (source.includes(find)) {
    source = source.replaceAll(find, replacement);
    mark();
  }
}

function insertAfter(marker, text, label) {
  if (source.includes(text.trim().slice(0, 60))) return;
  const i = source.indexOf(marker);
  if (i < 0) {
    console.log(`[fix-paypal-button-final] marker not found: ${label}`);
    return;
  }
  source = source.slice(0, i + marker.length) + text + source.slice(i + marker.length);
  mark();
}

function replaceFunction(name, replacement) {
  const start = source.indexOf(`const ${name} =`);
  if (start < 0) return false;
  const next = source.indexOf('\n  const ', start + 12);
  if (next < 0) return false;
  source = source.slice(0, start) + replacement + source.slice(next + 1);
  mark();
  return true;
}

// Constants and types.
if (!source.includes('const PAYPAL_SERVER_BASE')) {
  source = source.replace(
    'const ALL_FILES = "All files";',
    'const PAYPAL_SERVER_BASE = import.meta.env.VITE_PAYPAL_SERVER_BASE || "http://127.0.0.1:8791";\nconst ALL_FILES = "All files";'
  );
  mark();
}

if (!source.includes('type PendingPayPal')) {
  source = source.replace(
    'type Summary =',
    'type PendingPayPal = { orderId: string; planId: string; approveUrl?: string };\ntype Summary ='
  );
  mark();
}

// Bridge channels need wallet:setPlan for confirm.
replaceAllOnce('"wallet:disconnect";', '"wallet:disconnect" | "wallet:setPlan";');
replaceAllOnce('"wallet:disconnect" | "wallet:setPlan" | "wallet:setPlan";', '"wallet:disconnect" | "wallet:setPlan";');

// Pending state.
if (!source.includes('const [pendingPayPal, setPendingPayPal]')) {
  insertAfter(
    'const [renameFolderValue, setRenameFolderValue] = useState("");',
    '\n  const [pendingPayPal, setPendingPayPal] = useState<PendingPayPal | null>(() => readJson<PendingPayPal | null>("peercloud.pending.paypal", null));',
    'rename folder state'
  );
}

// Payment helpers: copy link only, then confirm later.
const helpers =
  'const copyPaymentLink = async (url?: string) => {\n' +
  '    if (!url) throw new Error("No PayPal approval link returned");\n' +
  '    await navigator.clipboard.writeText(url);\n' +
  '    toast.success("PayPal link copied");\n' +
  '  };\n\n' +
  '  const payWithPayPal = (plan: Plan) => run(async () => {\n' +
  '    if (!walletConnected || !wallet?.address) throw new Error("Connect wallet before payment");\n' +
  '    const response = await fetch(`${PAYPAL_SERVER_BASE}/paypal/create-order`, {\n' +
  '      method: "POST",\n' +
  '      headers: { "content-type": "application/json" },\n' +
  '      body: JSON.stringify({ wallet: wallet.address, planId: plan.id }),\n' +
  '    });\n' +
  '    const data = await response.json().catch(() => ({}));\n' +
  '    if (!response.ok || !data.ok) throw new Error(data.error || "PayPal create-order failed");\n' +
  '    const approveUrl = data.approveUrl || data.approvalUrl || data.checkoutUrl;\n' +
  '    const pending = { orderId: data.orderId || data.id, planId: data.planId || plan.id, approveUrl };\n' +
  '    if (!pending.orderId) throw new Error("PayPal order id missing");\n' +
  '    if (!pending.approveUrl) throw new Error("PayPal approval link missing");\n' +
  '    localStorage.setItem("peercloud.pending.paypal", JSON.stringify(pending));\n' +
  '    setPendingPayPal(pending);\n' +
  '    await copyPaymentLink(approveUrl);\n' +
  '    toast.success("PayPal link copied. Paste it in your browser, pay, then click Confirm Payment.");\n' +
  '  });\n\n' +
  '  const confirmPayPal = () => run(async () => {\n' +
  '    if (!pendingPayPal) throw new Error("No pending PayPal order");\n' +
  '    const response = await fetch(`${PAYPAL_SERVER_BASE}/paypal/capture-order`, {\n' +
  '      method: "POST",\n' +
  '      headers: { "content-type": "application/json" },\n' +
  '      body: JSON.stringify({ orderId: pendingPayPal.orderId, planId: pendingPayPal.planId, wallet: wallet?.address }),\n' +
  '    });\n' +
  '    const data = await response.json().catch(() => ({}));\n' +
  '    if (!response.ok || !data.ok) throw new Error(data.error || "PayPal capture failed");\n' +
  '    const sub = data.subscription || data;\n' +
  '    const nextWallet = await api.invoke<WalletState>("wallet:setPlan", {\n' +
  '      planId: sub.planId || pendingPayPal.planId,\n' +
  '      paidUntil: sub.paidUntil || data.paidUntil,\n' +
  '      quotaBytes: sub.quotaBytes || data.quotaBytes,\n' +
  '      txHash: sub.captureId || data.captureId || data.orderId || pendingPayPal.orderId,\n' +
  '    });\n' +
  '    setWallet(nextWallet);\n' +
  '    localStorage.removeItem("peercloud.pending.paypal");\n' +
  '    setPendingPayPal(null);\n' +
  '    toast.success(`${nextWallet.plan.name} unlocked`);\n' +
  '    await refresh();\n' +
  '  });\n\n  ';

if (!replaceFunction('copyPaymentLink', helpers)) {
  if (!replaceFunction('payWithPayPal', helpers)) {
    insertAfter('const disconnectWallet = () => run(async () => { setWallet(await api.invoke<WalletState>("wallet:disconnect")); await refresh(); });', '\n\n  ' + helpers, 'disconnect wallet');
  }
}

// Ensure no auto-open remains.
replaceAllOnce('await openExternalUrl(approveUrl);', '');
replaceAllOnce('window.open(approveUrl, "_blank");', '');
replaceAllOnce('if (data.approveUrl) window.open(data.approveUrl, "_blank");', '');
replaceAllOnce('${PAYPAL_SERVER_BASE}/api/paypal/create-order', '${PAYPAL_SERVER_BASE}/paypal/create-order');
replaceAllOnce('${PAYPAL_SERVER_BASE}/api/paypal/capture-order', '${PAYPAL_SERVER_BASE}/paypal/capture-order');

// Pending card, visible after clicking Pay with PayPal.
if (!source.includes('Pending PayPal payment')) {
  const pendingCard =
    '<Card className="rounded-2xl border-amber-800 bg-amber-950/40"><CardContent className="flex flex-col gap-3 p-5 lg:flex-row lg:items-center lg:justify-between"><div><p className="font-semibold text-amber-100">Pending PayPal payment</p><p className="break-all text-sm text-amber-200/80">Order: {pendingPayPal.orderId}</p>{pendingPayPal.approveUrl && <p className="break-all text-xs text-amber-200/70">{pendingPayPal.approveUrl}</p>}</div><div className="flex flex-wrap gap-2"><Button onClick={confirmPayPal} disabled={busy}>Confirm Payment</Button>{pendingPayPal.approveUrl && <Button variant="outline" onClick={() => void run(async () => copyPaymentLink(pendingPayPal.approveUrl))}>Copy Link</Button>}<Button variant="ghost" onClick={() => { localStorage.removeItem("peercloud.pending.paypal"); setPendingPayPal(null); }}>Cancel</Button></div></CardContent></Card>';
  insertAfter('</section>', '{pendingPayPal && ' + pendingCard + '}', 'stats section');
}

// Make plan buttons definitely call the helper.
replaceAllOnce('onClick={() => payWithPayPal(plan as any)}', 'onClick={() => payWithPayPal(plan)}');
replaceAllOnce('onClick={() => payWithPayPal(plan)} disabled={busy || !walletConnected || wallet?.plan?.id === plan.id}', 'onClick={() => payWithPayPal(plan)} disabled={busy || !walletConnected || wallet?.plan?.id === plan.id}');

if (changed) {
  fs.writeFileSync(file, source, 'utf8');
  console.log('[fix-paypal-button-final] PayPal button flow installed');
} else {
  console.log('[fix-paypal-button-final] PayPal button flow already installed');
}
