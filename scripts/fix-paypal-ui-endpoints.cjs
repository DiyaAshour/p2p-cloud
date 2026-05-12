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

function replaceFunction(source, name, replacement) {
  const start = source.indexOf(`const ${name} =`);
  if (start < 0) return source;
  const nextConst = source.indexOf('\n  const ', start + 10);
  if (nextConst < 0) return source;
  return source.slice(0, start) + replacement + source.slice(nextConst + 1);
}

let changedAny = false;
for (const file of walk(srcDir)) {
  let source = fs.readFileSync(file, 'utf8');
  if (!source.includes('payWithPayPal') && !source.includes('PAYPAL_SERVER_BASE') && !source.includes('Upgrade storage with PayPal')) continue;

  const before = source;

  if (!source.includes('"system:open-external"')) {
    source = source.replace('"wallet:disconnect";', '"wallet:disconnect" | "wallet:setPlan" | "system:open-external";');
    source = source.replace('"wallet:disconnect" | "wallet:setPlan" | "system:open-external" | "wallet:setPlan"', '"wallet:disconnect" | "wallet:setPlan" | "system:open-external"');
  }

  if (!source.includes('const openExternalUrl =')) {
    const insertBefore = source.indexOf('const copyPaymentLink =');
    if (insertBefore >= 0) {
      const helper =
        '  const openExternalUrl = async (url?: string) => {\n' +
        '    if (!url) throw new Error("No PayPal approval link returned");\n' +
        '    try { await api.invoke("system:open-external" as any, { url }); }\n' +
        '    catch { window.open(url, "_blank"); }\n' +
        '  };\n';
      source = source.slice(0, insertBefore) + helper + source.slice(insertBefore);
    }
  }

  source = replaceFunction(source, 'payWithPayPal',
    'const payWithPayPal = (plan: WalletPlan) => run(async () => {\n' +
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
    '    localStorage.setItem("peercloud.pending.paypal", JSON.stringify(pending));\n' +
    '    setPendingPayPal(pending);\n' +
    '    await copyPaymentLink(approveUrl);\n' +
    '    await openExternalUrl(approveUrl);\n' +
    '    toast.success("PayPal opened. Finish payment, then click Confirm Payment.");\n' +
    '  });\n'
  );

  source = replaceFunction(source, 'confirmPayPal',
    'const confirmPayPal = () => run(async () => {\n' +
    '    if (!pendingPayPal) throw new Error("No pending PayPal order");\n' +
    '    const response = await fetch(`${PAYPAL_SERVER_BASE}/paypal/capture-order`, {\n' +
    '      method: "POST",\n' +
    '      headers: { "content-type": "application/json" },\n' +
    '      body: JSON.stringify({ orderId: pendingPayPal.orderId, planId: pendingPayPal.planId, wallet: wallet?.address }),\n' +
    '    });\n' +
    '    const data = await response.json().catch(() => ({}));\n' +
    '    if (!response.ok || !data.ok) throw new Error(data.error || "PayPal capture failed");\n' +
    '    const sub = data.subscription || data;\n' +
    '    const nextWallet = await api.invoke<WalletState>("wallet:setPlan" as any, {\n' +
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
    '  });\n'
  );

  source = source
    .replaceAll('${PAYPAL_SERVER_BASE}/api/paypal/create-order', '${PAYPAL_SERVER_BASE}/paypal/create-order')
    .replaceAll('${PAYPAL_SERVER_BASE}/api/paypal/capture-order', '${PAYPAL_SERVER_BASE}/paypal/capture-order')
    .replaceAll('disabled={walletConnecting}', 'disabled={busy}')
    .replaceAll('window.open(data.approveUrl, "_blank")', 'openExternalUrl(data.approveUrl)')
    .replaceAll('window.open(approveUrl, "_blank")', 'openExternalUrl(approveUrl)');

  if (source !== before) {
    fs.writeFileSync(file, source, 'utf8');
    console.log(`[fix-paypal-ui-endpoints] patched ${path.relative(process.cwd(), file)}`);
    changedAny = true;
  }
}

if (!changedAny) console.log('[fix-paypal-ui-endpoints] no PayPal UI endpoint changes needed');
