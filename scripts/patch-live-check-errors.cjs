const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const livePath = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
const mainStablePath = path.join(process.cwd(), 'electron', 'main-stable.js');

function readLive() { return fs.existsSync(livePath) ? fs.readFileSync(livePath, 'utf8') : ''; }
function ensureLineAfter(source, anchor, line) { if (source.includes(line)) return source; if (!source.includes(anchor)) return source; return source.replace(anchor, `${anchor}${line}\n`); }
function replaceAny(source, replacements) { for (const [from, to] of replacements) if (source.includes(from)) return source.replace(from, to); return source; }
function removeEarlySeedImport() {
  if (!fs.existsSync(mainStablePath)) return;
  let main = fs.readFileSync(mainStablePath, 'utf8');
  const before = main;
  main = main.replace("import './seed-auth-cooldown-ipc.js';\n", '');
  main = main.replace("import './seed-auth-cooldown-ipc.js';\r\n", '');
  if (main !== before) {
    fs.writeFileSync(mainStablePath, main, 'utf8');
    console.log('[patch-live-check-errors] removed early seed-auth import from main-stable; main-wrapper registers it after p2p');
  }
}
function restoreCleanLive() {
  try {
    execFileSync('git', ['checkout', '--', 'client/src/NativeP2PAppLive.tsx'], { cwd: process.cwd(), stdio: 'ignore' });
    console.log('[patch-live-check-errors] restored NativeP2PAppLive.tsx from git before patching');
  } catch (error) {
    console.warn('[patch-live-check-errors] could not restore NativeP2PAppLive.tsx:', error?.message || error);
  }
}
function replaceIdentityCard(source) {
  const replacement = '          <IdentityAccountCard api={api} busy={busy} identityLabel={identityLabel} walletConnected={identityConnected} onWallet={setWallet} onRefresh={refresh} onDisconnect={disconnectWallet} />';
  if (source.includes('<IdentityAccountCard api={api}')) return source.replace(/walletConnected=\{walletConnected\}/g, 'walletConnected={identityConnected}');
  const identityCardRegex = /          <Card className="rounded-2xl border-zinc-800 bg-zinc-900">\r?\n            <CardContent className="space-y-4 p-5">\r?\n              <p className="text-sm text-zinc-400">Identity<\/p>[\s\S]*?            <\/CardContent>\r?\n          <\/Card>/;
  if (identityCardRegex.test(source)) return source.replace(identityCardRegex, replacement);
  console.warn('[patch-live-check-errors] Identity card block not found; leaving original Identity card unchanged');
  return source;
}
function patchSeedIdentityConnection(source) {
  let live = source;
  live = live.replace(
    '  const walletConnected = Boolean(wallet?.connected && (wallet.accountId || wallet.address));\n  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";',
    '  const walletConnected = Boolean(wallet?.connected && wallet?.authMode !== "seed" && (wallet.accountId || wallet.address));\n  const seedConnected = Boolean(wallet?.authMode === "seed" && (wallet.accountId || wallet.username || wallet.seedFingerprint));\n  const identityConnected = Boolean(walletConnected || seedConnected);\n  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";'
  );
  if (!live.includes('const identityConnected = Boolean(walletConnected || seedConnected);')) {
    live = live.replace(
      '  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";',
      '  const seedConnected = Boolean(wallet?.authMode === "seed" && (wallet.accountId || wallet.username || wallet.seedFingerprint));\n  const identityConnected = Boolean(walletConnected || seedConnected);\n  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";'
    );
  }
  live = live.replace(/walletConnected=\{walletConnected\}/g, 'walletConnected={identityConnected}');
  live = live.replace(/if \(!walletConnected\) throw new Error\("Connect wallet or sign in with Seed Account before uploading"\);/g, 'if (!identityConnected) throw new Error("Connect wallet or sign in with Seed Account before uploading");');
  live = live.replace(/if \(!walletConnected\) throw new Error\("Connect wallet before importing a shared link\."\);/g, 'if (!identityConnected) throw new Error("Sign in before importing a shared link.");');
  live = live.replace(/disabled=\{busy \|\| !walletConnected\}>Save to My Drive/g, 'disabled={busy || !identityConnected}>Save to My Drive');
  live = live.replace(
    '  const disconnectWallet = () => run(async () => {\n    setWallet(await api.invoke<WalletState>("wallet:disconnect"));\n    await refresh();\n  });',
    '  const disconnectWallet = () => run(async () => {\n    const nextWallet = await api.invoke<WalletState>("wallet:disconnect");\n    setWallet(nextWallet);\n    setDrivePassword("");\n    setFiles([]);\n    setActiveFolder(ALL_FILES);\n    await refresh();\n  });'
  );
  return live;
}

removeEarlySeedImport();
restoreCleanLive();
let live = readLive();

if (!live.includes('import CompanyOfflineJoinPanel from "./CompanyOfflineJoinPanel";')) live = live.replace('import { toast } from "sonner";', 'import { toast } from "sonner";\nimport CompanyOfflineJoinPanel from "./CompanyOfflineJoinPanel";');
if (!live.includes('import IdentityAccountCard from "./IdentityAccountCard";')) live = live.replace('import { toast } from "sonner";', 'import { toast } from "sonner";\nimport IdentityAccountCard from "./IdentityAccountCard";');

live = live.replace('type WalletState = { connected: boolean; address: string; usedBytes: number; remainingBytes: number; plan: Plan; plans: Plan[]; minDrivePasswordLength?: number };', 'type WalletState = { connected: boolean; address: string; planId?: string; accountId?: string; authMode?: "wallet" | "seed" | null; username?: string | null; seedFingerprint?: string | null; usedBytes: number; remainingBytes: number; plan: Plan; plans: Plan[]; minDrivePasswordLength?: number };');
live = ensureLineAfter(live, '  | "p2p:uploadFiles"\n', '  | "p2p:importSharedLink"');
live = ensureLineAfter(live, '  | "company:createWorkspace"\n', '  | "company:deleteWorkspace"');
live = live.replace('type Bridge = { invoke: <T>(channel: Channel, payload?: unknown) => Promise<T> };', 'type Bridge = { invoke: <T>(channel: string, payload?: unknown) => Promise<T> };');

if (!live.includes('function encodeSharedManifest')) live = live.replace('function protection(file: P2PFile) {', 'function encodeSharedManifest(file: P2PFile) { return btoa(unescape(encodeURIComponent(JSON.stringify(file)))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); }\nfunction protection(file: P2PFile) {');
if (!live.includes('const runBusy = run;')) live = live.replace('  const run = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } catch (e) { toast.error(err(e)); } finally { setBusy(false); } };', '  const run = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } catch (e) { toast.error(err(e)); } finally { setBusy(false); } };\n  const runBusy = run;');
if (!live.includes('const [activeTab, setActiveTab] = useState<"files" | "upload" | "admin">("files");')) live = live.replace('  const [view, setView] = useState<View>("personal");', '  const [view, setView] = useState<View>("personal");\n  const [activeTab, setActiveTab] = useState<"files" | "upload" | "admin">("files");');
if (!live.includes('const [sharedLinkInput, setSharedLinkInput] = useState(" ".trim());')) live = live.replace('  const [search, setSearch] = useState("");', '  const [search, setSearch] = useState("");\n  const [sharedLinkInput, setSharedLinkInput] = useState(" ".trim());');

live = patchSeedIdentityConnection(live);
live = replaceIdentityCard(live);
live = patchSeedIdentityConnection(live);

const start = live.indexOf('  const connectWallet = () => run(async () => {');
const endMarker = '\n  const disconnectWallet';
const end = start >= 0 ? live.indexOf(endMarker, start) : -1;
if (start >= 0 && end > start) live = live.slice(0, start) + '  const connectWallet = () => run(async () => { throw new Error("Use the Identity card wallet input."); });' + live.slice(end);

live = live.replace('<Tabs value={view === "admin" ? "admin" : "files"} onValueChange={(tab) => { if (tab === "admin") setView("admin"); }}>', '<Tabs value={activeTab} onValueChange={(tab) => { const nextTab = tab as "files" | "upload" | "admin"; setActiveTab(nextTab); if (nextTab === "admin") setView("admin"); }}>');
const folderBlock = '    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const personalFolderKeys = new Set(personalFiles.map((file) => file.hash));\n    const personalScopedFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith("personal:folder:") || personalFolderKeys.has(key)).map(([, folder]) => folder).filter(Boolean);\n    const companyScopedPrefix = activeWorkspace ? `company:${activeWorkspace.workspaceId}:folder:` : "company:none:folder:";\n    const companyScopedFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith(companyScopedPrefix)).map(([, folder]) => folder).filter(Boolean);\n    const sourceFolders = view === "company" || view === "admin" ? [...workspaceFolders, ...companyScopedFolders] : personalScopedFolders;\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];\n  }, [fileFolders, activeWorkspace, personalFiles, view]);';
live = replaceAny(live, [['    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const localFolders = Object.values(fileFolders).filter(Boolean);\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set([...localFolders, ...workspaceFolders])).sort()];\n  }, [fileFolders, activeWorkspace]);', folderBlock], ['    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const personalFolderKeys = new Set(personalFiles.map((file) => file.hash));\n    const localFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith("folder:") || personalFolderKeys.has(key)).map(([, folder]) => folder).filter(Boolean);\n    const sourceFolders = view === "company" || view === "admin" ? workspaceFolders : localFolders;\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];\n  }, [fileFolders, activeWorkspace, personalFiles, view]);', folderBlock]]);
live = replaceAny(live, [['  const createFolder = () => {\n    const folder = newFolder.trim();\n    if (!folder) return;\n    setFileFolders((current) => ({ ...current, [`folder:${folder}`]: folder }));\n    setActiveFolder(folder);\n    setNewFolder("");\n  };', '  const createFolder = () => {\n    const folder = newFolder.trim();\n    if (!folder) return;\n    const key = (view === "company" || view === "admin") && activeWorkspace ? `company:${activeWorkspace.workspaceId}:folder:${folder}` : `personal:folder:${folder}`;\n    setFileFolders((current) => ({ ...current, [key]: folder }));\n    setActiveFolder(folder);\n    setNewFolder("");\n  };']]);
if (!live.includes('const importSharedLink = () => run(async () =>')) live = live.replace('  const upload = () => run(async () => {', '  const importSharedLink = () => run(async () => {\n    if (!identityConnected) throw new Error("Sign in before importing a shared link.");\n    const link = sharedLinkInput.trim();\n    if (!link) throw new Error("Paste a Chunknet share link first.");\n    const result = await api.invoke<{ file?: P2PFile }>("p2p:importSharedLink", { link });\n    setSharedLinkInput("");\n    setView("personal");\n    setActiveTab("files");\n    await refresh();\n    toast.success(result?.file?.name ? `${result.file.name} saved to My Drive` : "Shared file saved to My Drive");\n  });\n  const upload = () => run(async () => {');
if (!live.includes('const deleteWorkspace = () => run(async () =>')) live = live.replace('  const inviteMember = () => run(async () => {', '  const deleteWorkspace = () => run(async () => {\n    if (!activeWorkspace) throw new Error("Select a company first");\n    if (localRole !== "owner") throw new Error("Only the company owner can delete this workspace.");\n    if (workspaceNameInput.trim() !== activeWorkspace.name) throw new Error("Type the company name in the Company name field before deleting.");\n    await api.invoke("company:deleteWorkspace", { workspaceId: activeWorkspace.workspaceId });\n    setWorkspaceNameInput("");\n    setActiveWorkspaceId("");\n    setView("personal");\n    setActiveTab("files");\n    await refresh();\n    toast.success("Company archived. Encrypted chunks were not deleted.");\n  });\n  const inviteMember = () => run(async () => {');
live = live.replace('const confirmName = window.prompt(`Type ${activeWorkspace.name} to delete this company. Files/chunks will stay encrypted; only the workspace manifest is archived.`)?.trim();\n    if (confirmName !== activeWorkspace.name) throw new Error("Company delete cancelled. Name did not match.");', 'if (workspaceNameInput.trim() !== activeWorkspace.name) throw new Error("Type the company name in the Company name field before deleting.");');
if (!live.includes('Shared link')) live = live.replace('<div className="relative">\n                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />\n                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files, folders, company, hash" className="pl-9" />\n              </div>', '{view === "shared" && <Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardHeader><CardTitle><Share2 className="mr-2 inline size-5" />Get from link</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-zinc-400">Paste a Chunknet share link, then save the shared public file into My Drive.</p><div className="flex flex-col gap-2 md:flex-row"><Input value={sharedLinkInput} onChange={(event) => setSharedLinkInput(event.target.value)} placeholder="chunknet://file/..." /><Button onClick={importSharedLink} disabled={busy || !identityConnected}>Save to My Drive</Button></div><p className="text-xs text-zinc-500">Private encrypted share links will require Share Key support in the next step.</p></CardContent></Card>}<div className="relative">\n                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />\n                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files, folders, company, hash" className="pl-9" />\n              </div>');
live = live.replace('  const share = (file: P2PFile) => {\n    const link = `chunknet://file/${file.rootHash || file.hash}`;\n    void navigator.clipboard.writeText(link).then(() => toast.success("Share link copied"));\n  };', '  const share = (file: P2PFile) => {\n    const root = file.rootHash || file.hash;\n    const link = file.isEncrypted ? `chunknet://file/${root}` : `chunknet://file/${root}?manifest=${encodeSharedManifest(file)}`;\n    void navigator.clipboard.writeText(link).then(() => toast.success(file.isEncrypted ? "Private link copied. Share Key support comes next." : "Share link copied with manifest"));\n  };');
if (!live.includes('Delete company')) live = live.replace('<div className="flex flex-col gap-2 md:flex-row"><Input value={workspaceNameInput} onChange={(event) => setWorkspaceNameInput(event.target.value)} placeholder="Company name" /><Button onClick={createWorkspace}><Building2 className="size-4" />Create company</Button></div>', '<div className="flex flex-col gap-2 md:flex-row"><Input value={workspaceNameInput} onChange={(event) => setWorkspaceNameInput(event.target.value)} placeholder="Company name" /><Button onClick={createWorkspace}><Building2 className="size-4" />Create company</Button></div>{activeWorkspace && <div className="rounded-2xl border border-red-900/60 bg-red-950/20 p-4"><p className="font-medium text-red-200">Danger zone</p><p className="mt-1 text-sm text-red-200/70">To delete, type the exact company name in the Company name field. Delete archives the company manifest only.</p><Button className="mt-3" variant="destructive" onClick={deleteWorkspace} disabled={busy || localRole !== "owner"}><Trash2 className="size-4" />Delete company</Button></div>}');
if (!live.includes('CompanyOfflineJoinPanel api={api as never}')) live = live.replace('</TabsContent>\n          </Tabs>', '<Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardHeader><CardTitle>Offline invitations</CardTitle></CardHeader><CardContent><CompanyOfflineJoinPanel api={api as never} activeWorkspace={activeWorkspace} busy={busy} onDone={refresh} /></CardContent></Card>\n            </TabsContent>\n          </Tabs>');
if (live.includes('window.prompt(')) console.warn('[patch-live-check-errors] warning: window.prompt still exists in NativeP2PAppLive'); else console.log('[patch-live-check-errors] no window.prompt remains in NativeP2PAppLive');
fs.writeFileSync(livePath, live, 'utf8');
const tsconfigPath = path.join(process.cwd(), 'tsconfig.json');
let tsconfig = fs.readFileSync(tsconfigPath, 'utf8');
if (!tsconfig.includes('client/src/NativeP2PAppStable.tsx')) { tsconfig = tsconfig.replace('"client/src/NativeP2PApp.tsx"', '"client/src/NativeP2PApp.tsx", "client/src/NativeP2PAppStable.tsx"'); fs.writeFileSync(tsconfigPath, tsconfig, 'utf8'); }
console.log('[patch-live-check-errors] patched clean NativeP2PAppLive and kept p2p startup isolated from seed-auth');
