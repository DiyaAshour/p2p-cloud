const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const livePath = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');

function readLive() {
  return fs.existsSync(livePath) ? fs.readFileSync(livePath, 'utf8') : '';
}

function ensureLineAfter(source, anchor, line) {
  if (source.includes(line)) return source;
  if (!source.includes(anchor)) {
    console.warn(`[patch-live-check-errors] anchor not found for line: ${line}`);
    return source;
  }
  return source.replace(anchor, `${anchor}${line}\n`);
}

function replaceAny(source, replacements, label) {
  for (const [from, to] of replacements) {
    if (source.includes(from)) return source.replace(from, to);
  }
  console.warn(`[patch-live-check-errors] replacement anchor not found: ${label}`);
  return source;
}

let live = readLive();

const looksBrokenSeedInjection = live.includes('Recovery seed — save it now') || live.includes('Wrong password attempts cool down this device only');
if (looksBrokenSeedInjection) {
  try {
    execFileSync('git', ['checkout', '--', 'client/src/NativeP2PAppLive.tsx'], { cwd: process.cwd(), stdio: 'ignore' });
    live = readLive();
    console.log('[patch-live-check-errors] restored NativeP2PAppLive.tsx from git because Seed UI injection broke JSX');
  } catch (error) {
    console.warn('[patch-live-check-errors] could not restore NativeP2PAppLive.tsx from git:', error?.message || error);
  }
}

if (!live.includes('import CompanyOfflineJoinPanel from "./CompanyOfflineJoinPanel";')) {
  live = live.replace('import { toast } from "sonner";', 'import { toast } from "sonner";\nimport CompanyOfflineJoinPanel from "./CompanyOfflineJoinPanel";');
}

live = live.replace(
  'type WalletState = { connected: boolean; address: string; usedBytes: number; remainingBytes: number; plan: Plan; plans: Plan[]; minDrivePasswordLength?: number };',
  'type WalletState = { connected: boolean; address: string; planId?: string; accountId?: string; authMode?: "wallet" | "seed" | null; username?: string | null; seedFingerprint?: string | null; usedBytes: number; remainingBytes: number; plan: Plan; plans: Plan[]; minDrivePasswordLength?: number };'
);

live = ensureLineAfter(live, '  | "p2p:uploadFiles"\n', '  | "p2p:importSharedLink"');
live = ensureLineAfter(live, '  | "company:createWorkspace"\n', '  | "company:deleteWorkspace"');

live = live.replace(
  'type Bridge = { invoke: <T>(channel: Channel, payload?: unknown) => Promise<T> };',
  'type Bridge = { invoke: <T>(channel: string, payload?: unknown) => Promise<T> };'
);

if (!live.includes('function encodeSharedManifest')) {
  live = live.replace(
    'function protection(file: P2PFile) {',
    'function encodeSharedManifest(file: P2PFile) { return btoa(unescape(encodeURIComponent(JSON.stringify(file)))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); }\nfunction protection(file: P2PFile) {'
  );
}

if (!live.includes('const runBusy = run;')) {
  live = live.replace(
    '  const run = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } catch (e) { toast.error(err(e)); } finally { setBusy(false); } };',
    '  const run = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } catch (e) { toast.error(err(e)); } finally { setBusy(false); } };\n  const runBusy = run;'
  );
}

if (!live.includes('const [activeTab, setActiveTab] = useState<"files" | "upload" | "admin">("files");')) {
  live = live.replace(
    '  const [view, setView] = useState<View>("personal");',
    '  const [view, setView] = useState<View>("personal");\n  const [activeTab, setActiveTab] = useState<"files" | "upload" | "admin">("files");'
  );
}

if (!live.includes('const [sharedLinkInput, setSharedLinkInput] = useState(" ".trim());')) {
  live = live.replace(
    '  const [search, setSearch] = useState("");',
    '  const [search, setSearch] = useState("");\n  const [sharedLinkInput, setSharedLinkInput] = useState(" ".trim());'
  );
}

if (!live.includes('const [walletAddressInput, setWalletAddressInput] = useState(" ".trim());')) {
  live = live.replace(
    '  const [drivePassword, setDrivePassword] = useState("");',
    '  const [drivePassword, setDrivePassword] = useState("");\n  const [walletAddressInput, setWalletAddressInput] = useState(" ".trim());\n  const [seedMode, setSeedMode] = useState<"login" | "create" | "recover">("login");\n  const [seedUsername, setSeedUsername] = useState(" ".trim());\n  const [seedPassword, setSeedPassword] = useState(" ".trim());\n  const [seedRecovery, setSeedRecovery] = useState(" ".trim());\n  const [generatedSeed, setGeneratedSeed] = useState(" ".trim());\n  const [seedSaved, setSeedSaved] = useState(false);'
  );
}

live = live.replace(
  '<Tabs value={view === "admin" ? "admin" : "files"} onValueChange={(tab) => { if (tab === "admin") setView("admin"); }}>',
  '<Tabs value={activeTab} onValueChange={(tab) => { const nextTab = tab as "files" | "upload" | "admin"; setActiveTab(nextTab); if (nextTab === "admin") setView("admin"); }}>'
);

const folderBlock = '    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const personalFolderKeys = new Set(personalFiles.map((file) => file.hash));\n    const personalScopedFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith("personal:folder:") || personalFolderKeys.has(key)).map(([, folder]) => folder).filter(Boolean);\n    const companyScopedPrefix = activeWorkspace ? `company:${activeWorkspace.workspaceId}:folder:` : "company:none:folder:";\n    const companyScopedFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith(companyScopedPrefix)).map(([, folder]) => folder).filter(Boolean);\n    const sourceFolders = view === "company" || view === "admin" ? [...workspaceFolders, ...companyScopedFolders] : personalScopedFolders;\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];\n  }, [fileFolders, activeWorkspace, personalFiles, view]);';

live = replaceAny(live, [
  ['    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const localFolders = Object.values(fileFolders).filter(Boolean);\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set([...localFolders, ...workspaceFolders])).sort()];\n  }, [fileFolders, activeWorkspace]);', folderBlock],
  ['    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const personalFolderKeys = new Set(personalFiles.map((file) => file.hash));\n    const localFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith("folder:") || personalFolderKeys.has(key)).map(([, folder]) => folder).filter(Boolean);\n    const sourceFolders = view === "company" || view === "admin" ? workspaceFolders : localFolders;\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];\n  }, [fileFolders, activeWorkspace, personalFiles, view]);', folderBlock],
], 'folder scope block');

live = replaceAny(live, [
  ['  const createFolder = () => {\n    const folder = newFolder.trim();\n    if (!folder) return;\n    setFileFolders((current) => ({ ...current, [`folder:${folder}`]: folder }));\n    setActiveFolder(folder);\n    setNewFolder("");\n  };', '  const createFolder = () => {\n    const folder = newFolder.trim();\n    if (!folder) return;\n    const key = (view === "company" || view === "admin") && activeWorkspace ? `company:${activeWorkspace.workspaceId}:folder:${folder}` : `personal:folder:${folder}`;\n    setFileFolders((current) => ({ ...current, [key]: folder }));\n    setActiveFolder(folder);\n    setNewFolder("");\n  };'],
], 'createFolder scoped storage');

live = replaceAny(live, [
  ['  const connectWallet = () => run(async () => {\n    const address = window.prompt("Wallet address 0x...")?.trim();\n    if (!address) return;\n    setWallet(await api.invoke<WalletState>("wallet:connect", { address }));\n    await refresh();\n  });', '  const connectWallet = () => run(async () => {\n    const address = walletAddressInput.trim();\n    if (!address) throw new Error("Enter wallet address first.");\n    setWallet(await api.invoke<WalletState>("wallet:connect", { address }));\n    setWalletAddressInput("");\n    setGeneratedSeed("");\n    setSeedSaved(false);\n    await refresh();\n  });'],
], 'wallet prompt removal');

if (!live.includes('const seedAuth = () => run(async () =>')) {
  live = live.replace(
    '  const disconnectWallet = () => run(async () => {\n    setWallet(await api.invoke<WalletState>("wallet:disconnect"));\n    await refresh();\n  });',
    '  const disconnectWallet = () => run(async () => {\n    setWallet(await api.invoke<WalletState>("wallet:disconnect"));\n    setGeneratedSeed("");\n    setSeedSaved(false);\n    await refresh();\n  });\n  const seedAuth = () => run(async () => {\n    const username = seedUsername.trim();\n    const password = seedPassword.trim();\n    if (!username || !password) throw new Error("Username and password are required.");\n    if (generatedSeed && !seedSaved) throw new Error("Save and confirm your recovery seed first.");\n    const channel = seedMode === "create" ? "seed:create" : seedMode === "recover" ? "seed:recover" : "seed:login";\n    const payload = seedMode === "recover" ? { username, password, seed: seedRecovery.trim() } : { username, password };\n    if (seedMode === "recover" && !seedRecovery.trim()) throw new Error("Recovery seed is required.");\n    const result = await api.invoke<WalletState & { seed?: string; created?: boolean }>(channel, payload);\n    setWallet(result);\n    setGeneratedSeed(result.seed || "");\n    setSeedSaved(false);\n    if (!result.seed) { setSeedPassword(""); setSeedRecovery(""); }\n    await refresh();\n    toast.success(seedMode === "create" ? "Seed Account created. Save your recovery seed." : seedMode === "recover" ? "Seed Account recovered." : "Signed in with Seed Account.");\n  });'
  );
}

if (!live.includes('const importSharedLink = () => run(async () =>')) {
  live = live.replace(
    '  const upload = () => run(async () => {',
    '  const importSharedLink = () => run(async () => {\n    if (!walletConnected) throw new Error("Connect wallet before importing a shared link.");\n    const link = sharedLinkInput.trim();\n    if (!link) throw new Error("Paste a Chunknet share link first.");\n    const result = await api.invoke<{ file?: P2PFile }>("p2p:importSharedLink", { link });\n    setSharedLinkInput("");\n    setView("personal");\n    setActiveTab("files");\n    await refresh();\n    toast.success(result?.file?.name ? `${result.file.name} saved to My Drive` : "Shared file saved to My Drive");\n  });\n  const upload = () => run(async () => {'
  );
}

if (!live.includes('const deleteWorkspace = () => run(async () =>')) {
  live = live.replace(
    '  const inviteMember = () => run(async () => {',
    '  const deleteWorkspace = () => run(async () => {\n    if (!activeWorkspace) throw new Error("Select a company first");\n    if (localRole !== "owner") throw new Error("Only the company owner can delete this workspace.");\n    const confirmName = window.prompt(`Type ${activeWorkspace.name} to delete this company. Files/chunks will stay encrypted; only the workspace manifest is archived.`)?.trim();\n    if (confirmName !== activeWorkspace.name) throw new Error("Company delete cancelled. Name did not match.");\n    await api.invoke("company:deleteWorkspace", { workspaceId: activeWorkspace.workspaceId });\n    setActiveWorkspaceId("");\n    setView("personal");\n    setActiveTab("files");\n    await refresh();\n    toast.success("Company archived. Encrypted chunks were not deleted.");\n  });\n  const inviteMember = () => run(async () => {'
  );
}

if (!live.includes('Shared link')) {
  live = live.replace(
    '<div className="relative">\n                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />\n                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files, folders, company, hash" className="pl-9" />\n              </div>',
    '{view === "shared" && <Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardHeader><CardTitle><Share2 className="mr-2 inline size-5" />Get from link</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-zinc-400">Paste a Chunknet share link, then save the shared public file into My Drive.</p><div className="flex flex-col gap-2 md:flex-row"><Input value={sharedLinkInput} onChange={(event) => setSharedLinkInput(event.target.value)} placeholder="chunknet://file/..." /><Button onClick={importSharedLink} disabled={busy || !walletConnected}>Save to My Drive</Button></div><p className="text-xs text-zinc-500">Private encrypted share links will require Share Key support in the next step.</p></CardContent></Card>}<div className="relative">\n                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />\n                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files, folders, company, hash" className="pl-9" />\n              </div>'
  );
}

live = live.replace(
  '  const share = (file: P2PFile) => {\n    const link = `chunknet://file/${file.rootHash || file.hash}`;\n    void navigator.clipboard.writeText(link).then(() => toast.success("Share link copied"));\n  };',
  '  const share = (file: P2PFile) => {\n    const root = file.rootHash || file.hash;\n    const link = file.isEncrypted ? `chunknet://file/${root}` : `chunknet://file/${root}?manifest=${encodeSharedManifest(file)}`;\n    void navigator.clipboard.writeText(link).then(() => toast.success(file.isEncrypted ? "Private link copied. Share Key support comes next." : "Share link copied with manifest"));\n  };'
);

if (!live.includes('Seed Account')) {
  live = live.replace(
    '<Card className="rounded-2xl border-zinc-800 bg-zinc-900">\n            <CardContent className="space-y-4 p-5">\n              <p className="text-sm text-zinc-400">Identity</p>\n              <p className="truncate font-medium">{identityLabel}</p>\n              {walletConnected ? (\n                <Button variant="outline" onClick={disconnectWallet} disabled={busy}>Disconnect</Button>\n              ) : (\n                <Button onClick={connectWallet} disabled={busy}><Wallet className="size-4" />Connect Wallet</Button>\n              )}\n            </CardContent>\n          </Card>',
    '<Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardContent className="space-y-4 p-5"><p className="text-sm text-zinc-400">Identity</p><p className="truncate font-medium">{identityLabel}</p>{walletConnected ? <Button variant="outline" onClick={disconnectWallet} disabled={busy}>Disconnect</Button> : <div className="space-y-2"><Input value={walletAddressInput} onChange={(event) => setWalletAddressInput(event.target.value)} placeholder="Wallet address 0x..." /><Button className="w-full" onClick={connectWallet} disabled={busy}><Wallet className="size-4" />Connect Wallet</Button></div>}<div className="border-t border-zinc-800 pt-4"><p className="mb-2 text-sm font-medium">Seed Account</p><div className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-zinc-950 p-1 text-xs"><button type="button" onClick={() => setSeedMode("login")} className={`rounded-lg px-2 py-2 ${seedMode === "login" ? "bg-zinc-800" : "text-zinc-500"}`}>Login</button><button type="button" onClick={() => setSeedMode("create")} className={`rounded-lg px-2 py-2 ${seedMode === "create" ? "bg-zinc-800" : "text-zinc-500"}`}>Create</button><button type="button" onClick={() => setSeedMode("recover")} className={`rounded-lg px-2 py-2 ${seedMode === "recover" ? "bg-zinc-800" : "text-zinc-500"}`}>Recover</button></div><div className="space-y-2"><Input value={seedUsername} onChange={(event) => setSeedUsername(event.target.value)} placeholder="Username" /><Input type="password" value={seedPassword} onChange={(event) => setSeedPassword(event.target.value)} placeholder={seedMode === "recover" ? "New password" : "Password"} />{seedMode === "recover" && <Input value={seedRecovery} onChange={(event) => setSeedRecovery(event.target.value)} placeholder="Recovery seed" />}{generatedSeed && <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3"><p className="text-xs font-medium text-amber-200">Recovery seed — save it now</p><p className="mt-2 break-all rounded-lg bg-zinc-950 p-2 text-xs">{generatedSeed}</p><Button className="mt-2 w-full" size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(generatedSeed).then(() => toast.success("Seed copied"))}>Copy seed</Button><label className="mt-3 flex items-start gap-2 text-xs text-amber-100"><Checkbox checked={seedSaved} onCheckedChange={(value) => setSeedSaved(Boolean(value))} /><span>I saved this recovery seed.</span></label></div>}<Button className="w-full" variant="outline" onClick={seedAuth} disabled={busy || Boolean(generatedSeed && !seedSaved)}>{generatedSeed && !seedSaved ? "Confirm seed saved first" : seedMode === "create" ? "Create Seed Account" : seedMode === "recover" ? "Recover Seed Account" : "Login with Seed"}</Button><p className="text-xs text-zinc-500">Wrong password cooldown is device-scoped and doubles after 5 failed attempts.</p></div></div></CardContent></Card>'
  );
}

if (!live.includes('Delete company')) {
  live = live.replace(
    '<div className="flex flex-col gap-2 md:flex-row"><Input value={workspaceNameInput} onChange={(event) => setWorkspaceNameInput(event.target.value)} placeholder="Company name" /><Button onClick={createWorkspace}><Building2 className="size-4" />Create company</Button></div>',
    '<div className="flex flex-col gap-2 md:flex-row"><Input value={workspaceNameInput} onChange={(event) => setWorkspaceNameInput(event.target.value)} placeholder="Company name" /><Button onClick={createWorkspace}><Building2 className="size-4" />Create company</Button></div>{activeWorkspace && <div className="rounded-2xl border border-red-900/60 bg-red-950/20 p-4"><p className="font-medium text-red-200">Danger zone</p><p className="mt-1 text-sm text-red-200/70">Delete archives the company manifest only. Encrypted chunks and personal files are not removed.</p><Button className="mt-3" variant="destructive" onClick={deleteWorkspace} disabled={busy || localRole !== "owner"}><Trash2 className="size-4" />Delete company</Button></div>}'
  );
}

if (!live.includes('CompanyOfflineJoinPanel api={api as never}')) {
  live = live.replace(
    '</TabsContent>\n          </Tabs>',
    '<Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardHeader><CardTitle>Offline invitations</CardTitle></CardHeader><CardContent><CompanyOfflineJoinPanel api={api as never} activeWorkspace={activeWorkspace} busy={busy} onDone={refresh} /></CardContent></Card>\n            </TabsContent>\n          </Tabs>'
  );
}

fs.writeFileSync(livePath, live, 'utf8');

const tsconfigPath = path.join(process.cwd(), 'tsconfig.json');
let tsconfig = fs.readFileSync(tsconfigPath, 'utf8');
if (!tsconfig.includes('client/src/NativeP2PAppStable.tsx')) {
  tsconfig = tsconfig.replace(
    '"client/src/NativeP2PApp.tsx"',
    '"client/src/NativeP2PApp.tsx", "client/src/NativeP2PAppStable.tsx"'
  );
  fs.writeFileSync(tsconfigPath, tsconfig, 'utf8');
}

console.log('[patch-live-check-errors] fixed wallet address UI, seed account UI, WalletState.planId, runBusy alias, upload tab state, shared link import UI, delete company UI, scoped folders, offline company join panel, channel types, bridge invoke, and excluded old stable app from TS check');
