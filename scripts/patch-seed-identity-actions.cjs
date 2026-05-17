const fs = require('node:fs');
const path = require('node:path');

const livePath = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(livePath)) {
  console.warn('[seed-identity-actions] NativeP2PAppLive.tsx not found');
  process.exit(0);
}

let src = fs.readFileSync(livePath, 'utf8');
const before = src;

src = src.replace(
  '  const walletConnected = Boolean(wallet?.connected && (wallet.accountId || wallet.address));\n  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";',
  '  const walletConnected = Boolean(wallet?.connected && wallet?.authMode !== "seed" && (wallet.accountId || wallet.address));\n  const seedConnected = Boolean(wallet?.authMode === "seed" && (wallet.accountId || wallet.username || wallet.seedFingerprint));\n  const identityConnected = Boolean(walletConnected || seedConnected);\n  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";'
);

if (!src.includes('const identityConnected = Boolean(walletConnected || seedConnected);')) {
  src = src.replace(
    '  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";',
    '  const seedConnected = Boolean(wallet?.authMode === "seed" && (wallet.accountId || wallet.username || wallet.seedFingerprint));\n  const identityConnected = Boolean(walletConnected || seedConnected);\n  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";'
  );
}

src = src.replace(/walletConnected=\{walletConnected\}/g, 'walletConnected={identityConnected}');
src = src.replace(/if \(!walletConnected\) throw new Error\("Connect wallet or sign in with Seed Account before uploading"\);/g, 'if (!identityConnected) throw new Error("Connect wallet or sign in with Seed Account before uploading");');
src = src.replace(/if \(!walletConnected\) throw new Error\("Connect wallet before importing a shared link\."\);/g, 'if (!identityConnected) throw new Error("Sign in before importing a shared link.");');
src = src.replace(/disabled=\{busy \|\| !walletConnected\}>Save to My Drive/g, 'disabled={busy || !identityConnected}>Save to My Drive');

src = src.replace(
  '  const disconnectWallet = () => run(async () => {\n    setWallet(await api.invoke<WalletState>("wallet:disconnect"));\n    await refresh();\n  });',
  '  const disconnectWallet = () => run(async () => {\n    const nextWallet = await api.invoke<WalletState>("wallet:disconnect");\n    setWallet(nextWallet);\n    setDrivePassword("");\n    setFiles([]);\n    setActiveFolder(ALL_FILES);\n    await refresh();\n  });'
);

src = src.replace(
  '          <IdentityAccountCard api={api} busy={busy} identityLabel={identityLabel} walletConnected={walletConnected} onWallet={setWallet} onRefresh={refresh} onDisconnect={disconnectWallet} />',
  '          <IdentityAccountCard api={api} busy={busy} identityLabel={identityLabel} walletConnected={identityConnected} onWallet={setWallet} onRefresh={refresh} onDisconnect={disconnectWallet} />'
);

if (src !== before) {
  fs.writeFileSync(livePath, src, 'utf8');
  console.log('[seed-identity-actions] patched upload, shared link, and disconnect to use identityConnected');
} else {
  console.log('[seed-identity-actions] already patched');
}
