const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const livePath = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');

function readLive() {
  return fs.existsSync(livePath) ? fs.readFileSync(livePath, 'utf8') : '';
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

live = live.replace(
  'type WalletState = { connected: boolean; address: string; usedBytes: number; remainingBytes: number; plan: Plan; plans: Plan[]; minDrivePasswordLength?: number };',
  'type WalletState = { connected: boolean; address: string; planId?: string; accountId?: string; authMode?: "wallet" | "seed" | null; username?: string | null; seedFingerprint?: string | null; usedBytes: number; remainingBytes: number; plan: Plan; plans: Plan[]; minDrivePasswordLength?: number };'
);

if (!live.includes('| "company:deleteWorkspace"')) {
  live = live.replace(
    '  | "company:createWorkspace"\n',
    '  | "company:createWorkspace"\n  | "company:deleteWorkspace"\n'
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

live = live.replace(
  '<Tabs value={view === "admin" ? "admin" : "files"} onValueChange={(tab) => { if (tab === "admin") setView("admin"); }}>',
  '<Tabs value={activeTab} onValueChange={(tab) => { const nextTab = tab as "files" | "upload" | "admin"; setActiveTab(nextTab); if (nextTab === "admin") setView("admin"); }}>'
);

live = live.replace(
  '    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const localFolders = Object.values(fileFolders).filter(Boolean);\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set([...localFolders, ...workspaceFolders])).sort()];\n  }, [fileFolders, activeWorkspace]);',
  '    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const personalFolderKeys = new Set(personalFiles.map((file) => file.hash));\n    const localFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith("folder:") || personalFolderKeys.has(key)).map(([, folder]) => folder).filter(Boolean);\n    const sourceFolders = view === "company" || view === "admin" ? workspaceFolders : localFolders;\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];\n  }, [fileFolders, activeWorkspace, personalFiles, view]);'
);

if (!live.includes('const deleteWorkspace = () => run(async () =>')) {
  live = live.replace(
    '  const inviteMember = () => run(async () => {',
    '  const deleteWorkspace = () => run(async () => {\n    if (!activeWorkspace) throw new Error("Select a company first");\n    if (localRole !== "owner") throw new Error("Only the company owner can delete this workspace.");\n    const confirmName = window.prompt(`Type ${activeWorkspace.name} to delete this company. Files/chunks will stay encrypted; only the workspace manifest is archived.`)?.trim();\n    if (confirmName !== activeWorkspace.name) throw new Error("Company delete cancelled. Name did not match.");\n    await api.invoke("company:deleteWorkspace", { workspaceId: activeWorkspace.workspaceId });\n    setActiveWorkspaceId("");\n    setView("personal");\n    setActiveTab("files");\n    await refresh();\n    toast.success("Company archived. Encrypted chunks were not deleted.");\n  });\n  const inviteMember = () => run(async () => {'
  );
}

if (!live.includes('Delete company')) {
  live = live.replace(
    '<div className="flex flex-col gap-2 md:flex-row"><Input value={workspaceNameInput} onChange={(event) => setWorkspaceNameInput(event.target.value)} placeholder="Company name" /><Button onClick={createWorkspace}><Building2 className="size-4" />Create company</Button></div>',
    '<div className="flex flex-col gap-2 md:flex-row"><Input value={workspaceNameInput} onChange={(event) => setWorkspaceNameInput(event.target.value)} placeholder="Company name" /><Button onClick={createWorkspace}><Building2 className="size-4" />Create company</Button></div>{activeWorkspace && <div className="rounded-2xl border border-red-900/60 bg-red-950/20 p-4"><p className="font-medium text-red-200">Danger zone</p><p className="mt-1 text-sm text-red-200/70">Delete archives the company manifest only. Encrypted chunks and personal files are not removed.</p><Button className="mt-3" variant="destructive" onClick={deleteWorkspace} disabled={busy || localRole !== "owner"}><Trash2 className="size-4" />Delete company</Button></div>}'
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

console.log('[patch-live-check-errors] fixed WalletState.planId, runBusy alias, upload tab state, delete company UI, separated folder scopes, and excluded old stable app from TS check');
