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

let changedAny = false;
for (const file of walk(srcDir)) {
  let source = fs.readFileSync(file, 'utf8');
  if (!source.includes('PAYPAL_SERVER_BASE') && !source.includes('payWithPayPal') && !source.includes('capture-order')) continue;

  const before = source;
  source = source
    .replaceAll('${PAYPAL_SERVER_BASE}/api/paypal/create-order', '${PAYPAL_SERVER_BASE}/paypal/create-order')
    .replaceAll('${PAYPAL_SERVER_BASE}/api/paypal/capture-order', '${PAYPAL_SERVER_BASE}/paypal/capture-order')
    .replaceAll('if (!response.ok || !data.ok || !data.subscription) throw new Error(data.error || "PayPal capture failed"); const sub = data.subscription;', 'if (!response.ok || !data.ok) throw new Error(data.error || "PayPal capture failed"); const sub = data.subscription || data;')
    .replaceAll('await copyPaymentLink(data.approveUrl); toast.success("PayPal order created. Open the copied link, pay, then confirm.");', 'await copyPaymentLink(data.approveUrl); if (data.approveUrl) window.open(data.approveUrl, "_blank"); toast.success("PayPal order created. Open PayPal, pay, then confirm.");')
    .replaceAll('await copyPaymentLink(data.approveUrl); toast.success("PayPal order created");', 'await copyPaymentLink(data.approveUrl); if (data.approveUrl) window.open(data.approveUrl, "_blank"); toast.success("PayPal order created. Open PayPal, pay, then confirm.");');

  if (source !== before) {
    fs.writeFileSync(file, source, 'utf8');
    console.log(`[fix-paypal-ui-endpoints] patched ${path.relative(process.cwd(), file)}`);
    changedAny = true;
  }
}

if (!changedAny) console.log('[fix-paypal-ui-endpoints] no PayPal UI endpoint changes needed');
