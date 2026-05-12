const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(file)) {
  console.log('[fix-empty-plans-tab] NativeP2PAppLive.tsx not found');
  process.exit(0);
}

let source = fs.readFileSync(file, 'utf8');
let changed = false;

if (!source.includes('<TabsTrigger value="plans">Plans</TabsTrigger>')) {
  source = source.replace('<TabsTrigger value="upload">Upload</TabsTrigger>', '<TabsTrigger value="upload">Upload</TabsTrigger><TabsTrigger value="plans">Plans</TabsTrigger>');
  changed = true;
}

if (!source.includes('<TabsContent value="plans"')) {
  const plansContent = '<TabsContent value="plans"><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardHeader><CardTitle>Upgrade storage</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{(wallet?.plans || []).filter((plan) => plan.id !== "free").map((plan) => <Card key={plan.id} className="rounded-2xl border-zinc-800 bg-zinc-950"><CardContent className="space-y-3 p-5"><div><p className="text-lg font-semibold">{plan.name}</p><p className="text-sm text-zinc-400">{bytes(plan.quotaBytes)}</p></div><p className="text-2xl font-bold">${plan.priceUsd}/mo</p><Button onClick={() => payWithPayPal(plan as any)} disabled={busy || !walletConnected || wallet?.plan?.id === plan.id}>{wallet?.plan?.id === plan.id ? "Current Plan" : "Pay with PayPal"}</Button></CardContent></Card>)}</CardContent></Card></TabsContent>';

  const uploadEnd = '</TabsContent></Tabs></section></main></div>;';
  if (source.includes(uploadEnd)) {
    source = source.replace(uploadEnd, `</TabsContent>${plansContent}</Tabs></section></main></div>;`);
    changed = true;
  } else {
    const fallback = '</Tabs></section></main></div>;';
    if (source.includes(fallback)) {
      source = source.replace(fallback, `${plansContent}</Tabs></section></main></div>;`);
      changed = true;
    } else {
      console.warn('[fix-empty-plans-tab] could not find Tabs closing marker');
    }
  }
}

if (changed) {
  fs.writeFileSync(file, source, 'utf8');
  console.log('[fix-empty-plans-tab] installed Plans tab content');
} else {
  console.log('[fix-empty-plans-tab] Plans tab content already exists');
}
