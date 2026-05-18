const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');

if (!fs.existsSync(file)) {
  console.warn('[seed-ui-runtime-reload] NativeP2PAppLive.tsx missing; skipping');
  process.exit(0);
}

let src = fs.readFileSync(file, 'utf8');
const before = src;

function replaceOnce(from, to, label) {
  if (src.includes(to)) {
    console.log(`[seed-ui-runtime-reload] already patched: ${label}`);
    return;
  }

  if (!src.includes(from)) {
    console.warn(`[seed-ui-runtime-reload] anchor not found: ${label}`);
    return;
  }

  src = src.replace(from, to);
  console.log(`[seed-ui-runtime-reload] patched: ${label}`);
}

replaceOnce(
  '      setWallet(await api.invoke<WalletState>("seed:login", { username, password: pw }));\n      await refresh();',
  '      const result = await api.invoke<WalletState>("seed:login", { username, password: pw });\n      setWallet(result);\n      await api.invoke("p2p:start");\n      await refresh();',
  'seed login reloads main runtime wallet state'
);

replaceOnce(
  '      setWallet(result);\n      await refresh();\n\n      if (result.seed) {',
  '      setWallet(result);\n      await api.invoke("p2p:start");\n      await refresh();\n\n      if (result.seed) {',
  'seed create reloads main runtime wallet state'
);

replaceOnce(
  '      setWallet(await api.invoke<WalletState>("seed:recover", { username, seed, password: pw }));\n      await refresh();',
  '      const result = await api.invoke<WalletState>("seed:recover", { username, seed, password: pw });\n      setWallet(result);\n      await api.invoke("p2p:start");\n      await refresh();',
  'seed recover reloads main runtime wallet state'
);

if (src !== before) {
  fs.writeFileSync(file, src, 'utf8');
  console.log('[seed-ui-runtime-reload] completed');
} else {
  console.log('[seed-ui-runtime-reload] no changes needed');
}
