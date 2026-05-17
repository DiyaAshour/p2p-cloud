const fs = require('node:fs');
const p = 'client/src/NativeP2PAppLive.tsx';
let s = fs.readFileSync(p, 'utf8');
const before = s;

s = s.replace('  const walletConnected = Boolean(wallet?.connected && (wallet.accountId || wallet.address));\n  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";', '  const walletConnected = Boolean(wallet?.connected && wallet?.authMode !== "seed" && (wallet.accountId || wallet.address));\n  const seedConnected = Boolean(wallet?.authMode === "seed" && (wallet.accountId || wallet.username || wallet.seedFingerprint));\n  const identityConnected = Boolean(walletConnected || seedConnected);\n  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";');

if (!s.includes('const [activeTab, setActiveTab]')) s = s.replace('  const [view, setView] = useState<View>("personal");', '  const [view, setView] = useState<View>("personal");\n  const [activeTab, setActiveTab] = useState<"files" | "upload" | "admin">("files");');
s = s.replace('<Tabs value={view === "admin" ? "admin" : "files"} onValueChange={(tab) => { if (tab === "admin") setView("admin"); }}>', '<Tabs value={activeTab} onValueChange={(tab) => { const nextTab = tab as "files" | "upload" | "admin"; setActiveTab(nextTab); if (nextTab === "admin") setView("admin"); }}>');
s = s.replaceAll('walletConnected={walletConnected}', 'walletConnected={identityConnected}');
s = s.replaceAll('!walletConnected', '!identityConnected');
s = s.replace('  const disconnectWallet = () => run(async () => {\n    setWallet(await api.invoke<WalletState>("wallet:disconnect"));\n    await refresh();\n  });', '  const disconnectWallet = () => run(async () => {\n    const nextWallet = await api.invoke<WalletState>("wallet:disconnect");\n    setWallet(nextWallet);\n    setDrivePassword("");\n    setFiles([]);\n    setActiveFolder(ALL_FILES);\n    await refresh();\n  });');

fs.writeFileSync(p, s, 'utf8');
console.log(s === before ? '[fix-live-clicks] already patched' : '[fix-live-clicks] patched upload tab, upload button, and disconnect');
if (s.includes('<Tabs value={view === "admin" ? "admin" : "files"}') || s.includes('!walletConnected')) process.exit(1);
