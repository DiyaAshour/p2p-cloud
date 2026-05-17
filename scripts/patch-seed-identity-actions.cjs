const fs = require('node:fs');
const path = require('node:path');

const livePath = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(livePath)) {
  console.warn('[seed-identity-actions] NativeP2PAppLive.tsx not found');
  process.exit(0);
}

let src = fs.readFileSync(livePath, 'utf8');
const before = src;

function replaceLineContaining(source, needle, replacementLines) {
  const lines = source.split(/\r?\n/);
  const idx = lines.findIndex((line) => line.includes(needle));
  if (idx === -1) return source;
  const replacement = Array.isArray(replacementLines) ? replacementLines : [replacementLines];
  lines.splice(idx, 1, ...replacement);
  return lines.join('\n');
}

if (!src.includes('const identityConnected = Boolean(walletConnected || seedConnected);')) {
  src = replaceLineContaining(src, 'const walletConnected = Boolean(wallet?.connected', [
    '  const walletConnected = Boolean(wallet?.connected && wallet?.authMode !== "seed" && (wallet.accountId || wallet.address));',
    '  const seedConnected = Boolean(wallet?.authMode === "seed" && (wallet.accountId || wallet.username || wallet.seedFingerprint));',
    '  const identityConnected = Boolean(walletConnected || seedConnected);',
  ]);
}

const identityLabelLine = '  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";';
if (!src.includes(identityLabelLine)) {
  src = replaceLineContaining(src, 'const identityLabel = wallet?.authMode === "seed"', identityLabelLine);
}

src = src.replace(/walletConnected=\{walletConnected\}/g, 'walletConnected={identityConnected}');
src = src.replace(/if \(!walletConnected\) throw new Error\("Connect wallet or sign in with Seed Account before uploading"\);/g, 'if (!identityConnected) throw new Error("Connect wallet or sign in with Seed Account before uploading");');
src = src.replace(/if \(!walletConnected\) throw new Error\("Connect wallet before importing a shared link\."\);/g, 'if (!identityConnected) throw new Error("Sign in before importing a shared link.");');
src = src.replace(/disabled=\{busy \|\| !walletConnected\}>Save to My Drive/g, 'disabled={busy || !identityConnected}>Save to My Drive');

const oldDisconnect = `  const disconnectWallet = () => run(async () => {
    setWallet(await api.invoke<WalletState>("wallet:disconnect"));
    await refresh();
  });`;
const newDisconnect = `  const disconnectWallet = () => run(async () => {
    const nextWallet = await api.invoke<WalletState>("wallet:disconnect");
    setWallet(nextWallet);
    setDrivePassword("");
    setFiles([]);
    setActiveFolder(ALL_FILES);
    await refresh();
  });`;
if (src.includes(oldDisconnect)) src = src.replace(oldDisconnect, newDisconnect);

src = src.replace(
  '          <IdentityAccountCard api={api} busy={busy} identityLabel={identityLabel} walletConnected={walletConnected} onWallet={setWallet} onRefresh={refresh} onDisconnect={disconnectWallet} />',
  '          <IdentityAccountCard api={api} busy={busy} identityLabel={identityLabel} walletConnected={identityConnected} onWallet={setWallet} onRefresh={refresh} onDisconnect={disconnectWallet} />'
);

const staleTokens = [
  'if (!walletConnected) throw new Error("Connect wallet or sign in with Seed Account before uploading")',
  'walletConnected={walletConnected}',
].filter((token) => src.includes(token));

if (src !== before) {
  fs.writeFileSync(livePath, src, 'utf8');
  console.log('[seed-identity-actions] patched upload, shared link, and disconnect to use identityConnected');
} else {
  console.log('[seed-identity-actions] already patched');
}

if (staleTokens.length) {
  console.warn('[seed-identity-actions] stale wallet-only UI tokens remain:', staleTokens.join(', '));
  process.exitCode = 1;
}
