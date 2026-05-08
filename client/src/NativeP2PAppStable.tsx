import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Cloud, Download, Eye, FileCheck2, FolderOpen, HardDrive, Image as ImageIcon, KeyRound, Lock, RefreshCw, Search, ShieldCheck, Trash2, Upload, Wallet, Wifi, Zap } from "lucide-react";
import { toast } from "sonner";

type P2PChannel =
  | "p2p:start"
  | "p2p:listFiles"
  | "p2p:uploadFiles"
  | "p2p:download"
  | "p2p:delete"
  | "p2p:networkSummary"
  | "p2p:repair"
  | "p2p:prepareProof"
  | "wallet:status"
  | "wallet:connect"
  | "wallet:disconnect"
  | "wallet:setPlan"
  | "electron:openDevTools"
  | "electron:diagnostics";

type ElectronBridge = { invoke: <T>(channel: P2PChannel, payload?: unknown) => Promise<T>; isElectron?: boolean; platform?: string };
type WalletPlan = { id: string; name: string; quotaBytes: number; priceUsd: number; locked?: boolean };
type WalletState = { ok: boolean; connected: boolean; address: string; planId: string; plan: WalletPlan; plans: WalletPlan[]; usedBytes: number; remainingBytes: number; minDrivePasswordLength?: number };
type P2PFile = { id: string; name: string; size: number; hash: string; rootHash: string; uploadedAt: string; isEncrypted: boolean; mimeType?: string; totalChunks: number; ownerNodeId?: string; ownerWallet?: string; planId?: string; replicas?: string[] };
type P2PPeer = { peerId: string; url?: string; status?: string; lastSeen?: string | number };
type P2PSummary = { ok: boolean; peerId: string; port: number; host: string; listenUrl: string; publicPeerUrl?: string; safetyPeerUrl?: string; peers: P2PPeer[]; connectedPeers: number; targetReplicas: number; totalFiles: number; encryptedFiles: number; publicFiles: number; totalBytes: number; totalChunks: number; underReplicatedChunks: number; wallet?: WalletState };
type DownloadResult = { ok: boolean; file: P2PFile; bytes: number[] };

declare global { interface Window { electron?: ElectronBridge } }

const ALL_FILES = "All files";
const UNCATEGORIZED = "Uncategorized";
const FOLDERS_KEY = "chunknet.ui.folders";
const FILE_FOLDERS_KEY = "chunknet.ui.fileFolders";

function getElectronBridge(): ElectronBridge | null {
  return typeof window !== "undefined" && typeof window.electron?.invoke === "function" ? window.electron : null;
}
function formatBytes(bytes = 0) { if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TB`; if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`; if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`; if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`; return `${bytes} B`; }
function formatDate(value?: string | number | null) { if (!value) return "unknown"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString(); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Operation failed"; }
function shortAddress(address = "") { return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Not connected"; }
function isImageFile(file: P2PFile) { return String(file.mimeType || "").startsWith("image/"); }
function safeJson<T>(key: string, fallback: T): T { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }

function ElectronRequiredScreen() {
  return <div className="min-h-screen bg-zinc-950 p-6 text-zinc-50"><Card className="mx-auto mt-16 max-w-2xl rounded-2xl border-red-900 bg-zinc-900"><CardHeader><CardTitle>Electron required</CardTitle></CardHeader><CardContent className="space-y-4 text-sm text-zinc-300"><p>Chunknet must run inside Electron so uploads use the native streaming path.</p><pre className="overflow-auto rounded-xl bg-zinc-950 p-3 text-xs">pnpm run electron:dev</pre></CardContent></Card></div>;
}

function StatCard({ icon, label, value, sub }: { icon: ReactNode; label: string; value: string | number; sub?: string }) {
  return <Card className="rounded-2xl border-zinc-800 bg-zinc-900/80"><CardContent className="flex items-center gap-4 p-5"><div className="rounded-2xl bg-zinc-800 p-3 text-zinc-100">{icon}</div><div className="min-w-0"><p className="text-sm text-zinc-400">{label}</p><p className="truncate text-xl font-semibold text-zinc-50">{value}</p>{sub && <p className="mt-0.5 truncate text-xs text-zinc-500">{sub}</p>}</div></CardContent></Card>;
}

export default function NativeP2PAppStable() {
  const bridge = getElectronBridge();
  const [summary, setSummary] = useState<P2PSummary | null>(null);
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [files, setFiles] = useState<P2PFile[]>([]);
  const [isEncrypted, setIsEncrypted] = useState(true);
  const [drivePassword, setDrivePassword] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [folderNames, setFolderNames] = useState<string[]>(() => safeJson<string[]>(FOLDERS_KEY, []));
  const [fileFolders, setFileFolders] = useState<Record<string, string>>(() => safeJson<Record<string, string>>(FILE_FOLDERS_KEY, {}));
  const [activeFolder, setActiveFolder] = useState(ALL_FILES);
  const [newFolderName, setNewFolderName] = useState("");

  const allFolders = useMemo(() => [ALL_FILES, UNCATEGORIZED, ...folderNames], [folderNames]);
  const walletConnected = Boolean(wallet?.connected && wallet.address);
  const minPasswordLength = wallet?.minDrivePasswordLength || 12;
  const quotaPercent = wallet?.plan?.quotaBytes ? Math.min(100, (wallet.usedBytes / wallet.plan.quotaBytes) * 100) : 0;
  const visibleFiles = useMemo(() => {
    const query = search.trim().toLowerCase();
    return files.filter((file) => {
      const folder = fileFolders[file.hash] || UNCATEGORIZED;
      const folderOk = activeFolder === ALL_FILES || activeFolder === folder;
      const queryOk = !query || [file.name, file.hash, file.rootHash, file.ownerWallet || "", folder].some((value) => String(value).toLowerCase().includes(query));
      return folderOk && queryOk;
    });
  }, [files, fileFolders, activeFolder, search]);

  useEffect(() => { localStorage.setItem(FOLDERS_KEY, JSON.stringify(folderNames)); }, [folderNames]);
  useEffect(() => { localStorage.setItem(FILE_FOLDERS_KEY, JSON.stringify(fileFolders)); }, [fileFolders]);

  const refreshAll = async () => {
    if (!bridge) return;
    const [nextSummary, nextFiles, nextWallet] = await Promise.all([
      bridge.invoke<P2PSummary>("p2p:networkSummary"),
      bridge.invoke<P2PFile[]>("p2p:listFiles", { query: search }),
      bridge.invoke<WalletState>("wallet:status"),
    ]);
    setSummary(nextSummary);
    setFiles(Array.isArray(nextFiles) ? nextFiles : []);
    setWallet(nextWallet);
  };

  const runBusy = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); } catch (error) { toast.error(errorMessage(error)); } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!bridge) return;
    void runBusy(async () => { await bridge.invoke("p2p:start"); await refreshAll(); });
  }, []);

  const connectDevWallet = () => runBusy(async () => {
    if (!bridge) return;
    const address = window.prompt("Wallet address 0x...")?.trim();
    if (!address) return;
    const nextWallet = await bridge.invoke<WalletState>("wallet:connect", { address });
    setWallet(nextWallet);
    await refreshAll();
    toast.success("Wallet connected");
  });

  const disconnectWallet = () => runBusy(async () => {
    if (!bridge) return;
    const nextWallet = await bridge.invoke<WalletState>("wallet:disconnect");
    setWallet(nextWallet);
    await refreshAll();
    toast.success("Wallet disconnected");
  });

  const createFolder = () => {
    const name = newFolderName.trim();
    if (!name || name === ALL_FILES || name === UNCATEGORIZED) return;
    if (folderNames.includes(name)) { toast.error("Folder already exists"); return; }
    setFolderNames((current) => [...current, name]);
    setActiveFolder(name);
    setNewFolderName("");
  };

  const moveFileToFolder = (file: P2PFile, folder: string) => {
    setFileFolders((current) => ({ ...current, [file.hash]: folder === UNCATEGORIZED ? "" : folder }));
  };

  const getDrivePassword = () => {
    if (!isEncrypted) return null;
    const password = drivePassword.trim();
    if (password.length < minPasswordLength) throw new Error(`Drive Password must be at least ${minPasswordLength} characters.`);
    return password;
  };

  const uploadFiles = () => runBusy(async () => {
    if (!bridge) return;
    if (!walletConnected) throw new Error("Connect your wallet before uploading");
    const password = getDrivePassword();
    const targetFolder = activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : "";
    const result = await bridge.invoke<{ ok?: boolean; cancelled?: boolean; files?: P2PFile[] }>("p2p:uploadFiles", { isEncrypted, drivePassword: password, folderPath: targetFolder });
    if (result?.cancelled) return;
    const uploaded = Array.isArray(result?.files) ? result.files : [];
    if (targetFolder && uploaded.length) setFileFolders((current) => ({ ...current, ...Object.fromEntries(uploaded.filter((file) => file.hash).map((file) => [file.hash, targetFolder])) }));
    toast.success(`${uploaded.length || 1} file(s) stored safely`);
    await refreshAll();
  });

  const downloadFile = (file: P2PFile) => runBusy(async () => {
    if (!bridge) return;
    const password = file.isEncrypted ? getDrivePassword() : null;
    const result = await bridge.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword: password });
    const blob = new Blob([new Uint8Array(result.bytes)], { type: result.file.mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.file.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  });

  const deleteFile = (file: P2PFile) => runBusy(async () => {
    if (!bridge) return;
    await bridge.invoke("p2p:delete", { hash: file.hash });
    setFileFolders((current) => { const next = { ...current }; delete next[file.hash]; return next; });
    await refreshAll();
  });

  const prepareProof = (file: P2PFile) => runBusy(async () => {
    if (!bridge) return;
    const result = await bridge.invoke<{ proof: unknown }>("p2p:prepareProof", { hash: file.hash });
    await navigator.clipboard.writeText(JSON.stringify(result.proof, null, 2));
    toast.success("Proof copied");
  });

  if (!bridge) return <ElectronRequiredScreen />;

  return <div className="min-h-screen bg-zinc-950 text-zinc-50">
    <header className="border-b border-zinc-800 bg-zinc-950"><div className="container flex flex-col gap-4 py-5 lg:flex-row lg:items-center lg:justify-between"><div className="flex items-center gap-4"><div className="rounded-2xl bg-zinc-50 p-3 text-zinc-950"><Cloud className="size-7" /></div><div><h1 className="text-2xl font-semibold">Chunknet Drive</h1><p className="mt-1 text-sm text-zinc-400">Encrypted storage that stays close to you.</p></div></div><div className="flex flex-wrap gap-2"><Badge variant={walletConnected ? "default" : "secondary"} className="px-3 py-2">{walletConnected ? <Wallet className="mr-1 size-4" /> : <Lock className="mr-1 size-4" />}{walletConnected ? shortAddress(wallet?.address) : "Guest view"}</Badge><Button variant="outline" onClick={() => void runBusy(refreshAll)} disabled={busy}><RefreshCw className="size-4" />Refresh</Button><Button variant={advancedMode ? "default" : "outline"} onClick={() => setAdvancedMode((value) => !value)}>{advancedMode ? "Simple" : "Advanced"}</Button></div></div></header>

    <main className="container grid gap-6 py-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="space-y-4"><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardContent className="space-y-4 p-5"><div><p className="text-sm text-zinc-400">Account</p><p className="mt-1 truncate font-medium">{walletConnected ? shortAddress(wallet?.address) : "Guest"}</p></div><div className="flex flex-col gap-2">{walletConnected ? <Button variant="outline" onClick={disconnectWallet} disabled={busy}>Disconnect Wallet</Button> : <Button onClick={connectDevWallet} disabled={busy}><Wallet className="size-4" />Connect Wallet</Button>}</div></CardContent></Card><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardContent className="space-y-3 p-5"><div className="flex items-center justify-between text-sm"><span className="text-zinc-400">Storage</span><span>{quotaPercent.toFixed(0)}%</span></div><div className="h-3 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-zinc-50 transition-all duration-500" style={{ width: `${quotaPercent}%` }} /></div><p className="text-xs text-zinc-400">{formatBytes(wallet?.usedBytes ?? 0)} of {formatBytes(wallet?.plan?.quotaBytes ?? 0)} · {wallet?.plan?.name || "Free"}</p></CardContent></Card><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><FolderOpen className="size-4" />Folders</CardTitle></CardHeader><CardContent className="space-y-3"><div className="flex gap-2"><Input value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="New folder" /><Button variant="outline" onClick={createFolder}>+</Button></div><nav className="grid gap-2 text-sm">{allFolders.map((folder) => <button key={folder} onClick={() => setActiveFolder(folder)} className={`rounded-xl px-4 py-3 text-left transition duration-200 ${activeFolder === folder ? "bg-zinc-800 font-medium text-zinc-50" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"}`}><FolderOpen className="mr-2 inline size-4" />{folder}</button>)}</nav></CardContent></Card></aside>

      <section className="space-y-6"><section className="grid gap-3 md:grid-cols-4"><StatCard icon={<FolderOpen className="size-5" />} label="Files" value={summary?.totalFiles ?? 0} sub={`${summary?.encryptedFiles ?? 0} encrypted`} /><StatCard icon={<HardDrive className="size-5" />} label="Used" value={formatBytes(summary?.totalBytes ?? 0)} sub={`Remaining ${formatBytes(wallet?.remainingBytes ?? 0)}`} /><StatCard icon={<ShieldCheck className="size-5" />} label="Protection" value={isEncrypted ? "Encrypted" : "Public"} sub="Drive password required" /><StatCard icon={<Wifi className="size-5" />} label="Network" value={`${summary?.connectedPeers ?? 0} peers`} sub={summary?.safetyPeerUrl ? `Safety: ${summary.safetyPeerUrl}` : "Local first"} /></section>

        <Tabs defaultValue="files" className="space-y-5"><TabsList className="rounded-2xl border border-zinc-800 bg-zinc-900 p-1"><TabsTrigger value="files">My Files</TabsTrigger><TabsTrigger value="upload">Upload</TabsTrigger><TabsTrigger value="plans">Plans</TabsTrigger></TabsList>
          <TabsContent value="files" className="space-y-4"><div className="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:flex-row"><div className="relative flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${activeFolder}`} className="pl-9" /></div><Button variant="outline" onClick={() => void runBusy(refreshAll)} disabled={busy}>Search</Button></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{visibleFiles.map((file) => <Card key={file.hash} className="group overflow-hidden rounded-2xl border-zinc-800 bg-zinc-900"><CardContent className="space-y-4 p-5"><div className="flex h-28 items-center justify-center rounded-2xl bg-gradient-to-br from-zinc-800 to-zinc-950 text-zinc-300">{isImageFile(file) ? <ImageIcon className="size-10" /> : <FileCheck2 className="size-10" />}</div><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate font-semibold">{file.name}</h2><p className="mt-1 text-sm text-zinc-400">{formatBytes(file.size)} · {formatDate(file.uploadedAt)}</p><p className="mt-1 text-xs text-zinc-500"><FolderOpen className="mr-1 inline size-3" />{fileFolders[file.hash] || UNCATEGORIZED}</p></div>{file.isEncrypted && <Badge variant="secondary"><Lock className="mr-1 size-3" />Encrypted</Badge>}</div><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => downloadFile(file)} disabled={busy}><Download className="size-4" />Download</Button><Button variant="outline" size="sm" onClick={() => prepareProof(file)} disabled={busy}><ShieldCheck className="size-4" />Proof</Button><Button variant="destructive" size="sm" onClick={() => deleteFile(file)} disabled={busy}><Trash2 className="size-4" />Delete</Button></div><select value={fileFolders[file.hash] || UNCATEGORIZED} onChange={(event) => moveFileToFolder(file, event.target.value)} className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none"><option value={UNCATEGORIZED}>Uncategorized</option>{folderNames.map((folder) => <option key={folder} value={folder}>{folder}</option>)}</select></CardContent></Card>)}</div>{visibleFiles.length === 0 && <Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardContent className="py-14 text-center"><p className="font-medium">No files here yet</p><p className="mt-1 text-sm text-zinc-400">Upload your first encrypted file.</p></CardContent></Card>}</TabsContent>

          <TabsContent value="upload"><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardHeader><CardTitle className="flex items-center gap-2"><Upload className="size-5" />Upload encrypted files</CardTitle></CardHeader><CardContent className="space-y-5">{!walletConnected && <div className="rounded-2xl border border-zinc-700 bg-zinc-950 p-4 text-sm text-zinc-300">Connect your wallet to unlock encrypted storage.</div>}<div className="rounded-3xl border-2 border-dashed border-zinc-700 bg-zinc-950 p-8 text-center"><Upload className="mx-auto size-10 text-zinc-400" /><p className="mt-3 font-medium">Large-file safe mode</p><p className="mt-1 text-sm text-zinc-500">Click Choose & Store files. Files stream from disk instead of browser RAM.</p></div><div className="grid gap-4 lg:grid-cols-2"><label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-zinc-800 bg-zinc-950 p-4"><Checkbox checked={isEncrypted} onCheckedChange={(value) => setIsEncrypted(Boolean(value))} disabled={!walletConnected} /><span><span className="block font-medium">Encrypted storage</span><span className="text-sm text-zinc-400">Peers store encrypted chunks only.</span></span></label><div className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-950 p-4"><Label htmlFor="drive-password" className="flex items-center gap-2"><KeyRound className="size-4" />Drive Password</Label><Input id="drive-password" type="password" value={drivePassword} onChange={(event) => setDrivePassword(event.target.value)} placeholder={`Minimum ${minPasswordLength} characters`} disabled={!walletConnected || !isEncrypted} /></div></div><div className="flex justify-end"><Button onClick={uploadFiles} disabled={busy || !walletConnected}><Zap className="size-4" />Choose & Store files</Button></div></CardContent></Card></TabsContent>

          <TabsContent value="plans"><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{(wallet?.plans || []).map((plan) => <Card key={plan.id} className="rounded-2xl border-zinc-800 bg-zinc-900"><CardHeader><CardTitle>{plan.name}</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold">${plan.priceUsd}/mo</p><p className="mt-2 text-sm text-zinc-400">{formatBytes(plan.quotaBytes)} quota</p><Button className="mt-4 w-full" variant={wallet?.planId === plan.id ? "secondary" : "outline"} disabled>{wallet?.planId === plan.id ? "Current" : "Upgrade soon"}</Button></CardContent></Card>)}</div></TabsContent>
        </Tabs>
      </section>
    </main>
  </div>;
}
