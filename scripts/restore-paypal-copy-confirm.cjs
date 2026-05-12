const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(process.cwd(), 'client', 'src');
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}
function replaceFunction(source, name, replacement) {
  const start = source.indexOf(`const ${name} =`);
  if (start < 0) return source;
  const nextConst = source.indexOf('\n  const ', start + 10);
  if (nextConst < 0) return source;
  return source.slice(0, start) + replacement + source.slice(nextConst + 1);
}
let changed = false;
for (const file of walk(srcDir)) {
  let source = fs.readFileSync(file, 'utf8');
  if (!source.includes('payWithPayPal')) continue;
  const before = source;

  source = source.replaceAll(' | "system:open-external"', '');
  source = source.replace(/\n  const openExternalUrl = async \(url\?: string\) => \{[\s\S]*?\n  \};\n/g, '\n');

  source = replaceFunction(source, 'payWithPayPal',
    'const payWithPayPal = (plan: WalletPlan) => run(async () => {\n' +
    '    if (!walletConnected || !wallet?.address) throw new Error("Connect wallet before payment");\n' +
    '    const response = await fetch(`${PAYPAL_SERVER_BASE}/paypal/create-order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: wallet.address, planId: plan.id }) });\n' +
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
    '  });\n'
  );

  source = replaceFunction(source, 'confirmPayPal',
    'const confirmPayPal = () => run(async () => {\n' +
    '    if (!pendingPayPal) throw new Error("No pending PayPal order");\n' +
    '    const response = await fetch(`${PAYPAL_SERVER_BASE}/paypal/capture-order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: pendingPayPal.orderId, planId: pendingPayPal.planId, wallet: wallet?.address }) });\n' +
    '    const data = await response.json().catch(() => ({}));\n' +
    '    if (!response.ok || !data.ok) throw new Error(data.error || "PayPal capture failed");\n' +
    '    const sub = data.subscription || data;\n' +
    '    const nextWallet = await api.invoke<WalletState>("wallet:setPlan" as any, { planId: sub.planId || pendingPayPal.planId, paidUntil: sub.paidUntil || data.paidUntil, quotaBytes: sub.quotaBytes || data.quotaBytes, txHash: sub.captureId || data.captureId || data.orderId || pendingPayPal.orderId });\n' +
    '    setWallet(nextWallet);\n' +
    '    localStorage.removeItem("peercloud.pending.paypal");\n' +
    '    setPendingPayPal(null);\n' +
    '    toast.success(`${nextWallet.plan.name} unlocked`);\n' +
    '    await refresh();\n' +
    '  });\n'
  );

  source = source
    .replaceAll('${PAYPAL_SERVER_BASE}/api/paypal/create-order', '${PAYPAL_SERVER_BASE}/paypal/create-order')
    .replaceAll('${PAYPAL_SERVER_BASE}/api/paypal/capture-order', '${PAYPAL_SERVER_BASE}/paypal/capture-order')
    .replaceAll('await openExternalUrl(approveUrl);', '')
    .replaceAll('window.open(approveUrl, "_blank");', '')
    .replaceAll('if (data.approveUrl) window.open(data.approveUrl, "_blank");', '');

  if (source !== before) {
    fs.writeFileSync(file, source, 'utf8');
    console.log(`[restore-paypal-copy-confirm] patched ${path.relative(process.cwd(), file)}`);
    changed = true;
  }
}
if (!changed) console.log('[restore-paypal-copy-confirm] no changes needed');
