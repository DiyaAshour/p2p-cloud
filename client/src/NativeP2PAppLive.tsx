import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Cloud, Download, FileCheck2, FolderOpen, HardDrive, KeyRound, Lock, RefreshCw, Search, ShieldCheck, Trash2, Upload, Wallet, Wifi, Zap } from "lucide-react";
import { toast } from "sonner";

type Channel = "p2p:start" | "p2p:listFiles" | "p2p:uploadFiles" | "p2p:downloadToPath" | "p2p:delete" | "p2p:networkSummary" | "p2p:prepareProof" | "wallet:status" | "wallet:connect" | "wallet:disconnect";
type Bridge = { invoke: <T>(channel: Channel, payload?: unknown) => Promise<T> };
type Plan = { id: string; name: string; quotaBytes: number; priceUsd: number };
type WalletState = { connected: boolean; address: string; usedBytes: number; remainingBytes: number; plan: Plan; plans: Plan[]; minDrivePasswordLength?: number };
type P2PFile = { id?: string; name: string; size: number; hash: string; rootHash: string; uploadedAt: string; isEncrypted: boolean; mimeType?: string; totalChunks: number; ownerWallet?: string; replicas?: string[] };
type Summary = { totalFiles: number; encryptedFiles: number; totalBytes: number; connectedPeers: number; safetyPeerUrl?: string; transferProgress?: unknown };

declare global { interface Window { electron?: Bridge } }

const ALL_FILES = "All files";
const UNCATEGORIZED = "Uncategorized";
const FOLDERS_KEY = "chunknet.ui.folders";
const FILE_FOLDERS_KEY = "chunknet.ui.fileFolders";

function bridge(): Bridge | null { return typeof window !== "undefined" && typeof window.electron?.invoke === "function" ? window.electron : null; }
function bytes(n = 0) { if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(2)} TB`; if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`; if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`; if (n >= 1024) return `${(n / 1024).toFixed(2)} KB`; return `${n} B`; }
function short(a = "") { return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "Guest"; }
function date(v?: string) { const d = new Date(v || ""); return Number.isNaN(d.getTime()) ? "unknown" : d.toLocaleString(); }
function readJson<T>(key: string, fallback: T): T { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
function err(e: unknown) { return e instanceof Error ? e.message : "Operation failed"; }
function cleanSafetyPeerLabel(url?: string) { if (!url) return "No safety peer"; try { const parsed = new URL(url); return `AWS safety peer · ${parsed.hostname}`; } catch { return "AWS safety peer enabled"; } }

export default function NativeP2PAppLive() {
  const api = bridge();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [files, setFiles] = useState<P2PFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [isEncrypted, setIsEncrypted] = useState(true);
  const [drivePassword, setDrivePassword] = useState("");
  const [folders, setFolders] = useState<string[]>(() => readJson<string[]>(FOLDERS_KEY, []));
  const [fileFolders, setFileFolders] = useState<Record<string, string>>(() => readJson<Record<string, string>>(FILE_FOLDERS_KEY, {}));
  const [activeFolder, setActiveFolder] = useState(ALL_FILES);
  const [newFolder, setNewFolder] = useState("");

  const walletConnected = Boolean(wallet?.connected && wallet.address);
  const minPasswordLength = wallet?.minDrivePasswordLength || 12;
  const folderList = useMemo(() => [ALL_FILES, UNCATEGORIZED, ...folders], [folders]);
  const safetyPeerEnabled = Boolean(summary?.safetyPeerUrl);
  const livePeerCount = summary?.connectedPeers || 0;
  const displayedPeerCount = livePeerCount + (safetyPeerEnabled ? 1 : 0);
  const networkSubText = safetyPeerEnabled ? `${livePeerCount} live peer(s) + AWS safety` : `${livePeerCount} live peer(s)`;
  const visibleFiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return files.filter((file) => {
      const folder = fileFolders[file.hash] || UNCATEGORIZED;
      const folderOk = activeFolder === ALL_FILES || activeFolder === folder;
      const queryOk = !q || [file.name, file.hash, file.rootHash, folder].some((x) => String(x || "").toLowerCase().includes(q));
      return folderOk && queryOk;
    });
  }, [files, fileFolders, activeFolder, search]);

  useEffect(() => { localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders)); }, [folders]);
  useEffect(() => { localStorage.setItem(FILE_FOLDERS_KEY, JSON.stringify(fileFolders)); }, [fileFolders]);

  const run = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } catch (e) { toast.error(err(e)); } finally { setBusy(false); } };
  const refresh = async () => {
    if (!api) return;
    const [s, f, w] = await Promise.all([api.invoke<Summary>("p2p:networkSummary"), api.invoke<P2PFile[]>("p2p:listFiles", { query: search }), api.invoke<WalletState>("wallet:status")]);
    setSummary(s); setFiles(Array.isArray(f) ? f : []); setWallet(w);
  };

  useEffect(() => { if (api) void run(async () => { await api.invoke("p2p:start"); await refresh(); }); }, []);

  if (!api) return <div className="min-h-screen bg-zinc-950 p-8 text-zinc-50">Electron required. Run pnpm run electron:dev</div>;

  const password = () => {
    if (!isEncrypted) return null;
    const p = drivePassword.trim();
    if (p.length < minPasswordLength) throw new Error(`Drive Password must be at least ${minPasswordLength} characters.`);
    return p;
  };

  const connectWallet = () => run(async () => {
    const address = window.prompt("Wallet address 0x...")?.trim();
    if (!address) return;
    setWallet(await api.invoke<WalletState>("wallet:connect", { address }));
    await refresh();
  });
  const disconnectWallet = () => run(async () => { setWallet(await api.invoke<WalletState>("wallet:disconnect")); await refresh(); });
  const upload = () => run(async () => {
    if (!walletConnected) throw new Error("Connect your wallet before uploading");
    const result = await api.invoke<{ cancelled?: boolean; files?: P2PFile[] }>("p2p:uploadFiles", { isEncrypted, drivePassword: password(), folderPath: activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED ? "" : activeFolder });
    if (!result?.cancelled) toast.success(`${result?.files?.length || 1} file(s) stored safely`);
    await refresh();
  });
  const download = (file: P2PFile) => run(async () => {
    const result = await api.invoke<{ cancelled?: boolean; path?: string }>("p2p:downloadToPath", { hash: file.hash, drivePassword: file.isEncrypted ? password() : null });
    if (!result?.cancelled) toast.success(result?.path ? `Downloaded to ${result.path}` : "Download complete");
    await refresh();
  });
  const remove = (file: P2PFile) => run(async () => { await api.invoke("p2p:delete", { hash: file.hash }); await refresh(); });
  const proof = (file: P2PFile) => run(async () => { const r = await api.invoke<{ proof: unknown }>("p2p:prepareProof", { hash: file.hash }); await navigator.clipboard.writeText(JSON.stringify(r.proof, null, 2)); toast.success("Proof copied"); });
  const createFolder = () => { const name = newFolder.trim(); if (!name || folderList.includes(name)) return; setFolders((x) => [...x, name]); setActiveFolder(name); setNewFolder(""); };

  const quota = wallet?.plan?.quotaBytes ? Math.min(100, (wallet.usedBytes / wallet.plan.quotaBytes) * 100) : 0;

  return <div className="min-h-screen bg-zinc-950 text-zinc-50"><header className="border-b border-zinc-800"><div className="container flex flex-col gap-4 py-5 lg:flex-row lg:items-center lg:justify-between"><div className="flex items-center gap-4"><div className="rounded-2xl bg-zinc-50 p-3 text-zinc-950"><Cloud className="size-7" /></div><div><h1 className="text-2xl font-semibold">Chunknet Drive</h1><p className="text-sm text-zinc-400">Encrypted storage that stays close to you.</p></div></div><div className="flex gap-2"><Badge className="px-3 py-2">{walletConnected ? short(wallet?.address) : "Guest view"}</Badge><Button variant="outline" onClick={() => void run(refresh)} disabled={busy}><RefreshCw className="size-4" />Refresh</Button></div></div></header><main className="container grid gap-6 py-6 lg:grid-cols-[280px_minmax(0,1fr)]"><aside className="space-y-4"><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardContent className="space-y-4 p-5"><p className="text-sm text-zinc-400">Account</p><p className="truncate font-medium">{walletConnected ? short(wallet?.address) : "Guest"}</p>{walletConnected ? <Button variant="outline" onClick={disconnectWallet} disabled={busy}>Disconnect Wallet</Button> : <Button onClick={connectWallet} disabled={busy}><Wallet className="size-4" />Connect Wallet</Button>}</CardContent></Card><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardContent className="space-y-3 p-5"><div className="flex justify-between text-sm"><span>Storage</span><span>{quota.toFixed(0)}%</span></div><div className="h-3 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-zinc-50" style={{ width: `${quota}%` }} /></div><p className="text-xs text-zinc-400">{bytes(wallet?.usedBytes || 0)} of {bytes(wallet?.plan?.quotaBytes || 0)}</p></CardContent></Card><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardHeader><CardTitle className="text-base">Folders</CardTitle></CardHeader><CardContent className="space-y-3"><div className="flex gap-2"><Input value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="New folder" /><Button onClick={createFolder}>+</Button></div>{folderList.map((folder) => <button key={folder} onClick={() => setActiveFolder(folder)} className={`block w-full rounded-xl px-4 py-3 text-left text-sm ${activeFolder === folder ? "bg-zinc-800" : "text-zinc-400 hover:bg-zinc-800/60"}`}><FolderOpen className="mr-2 inline size-4" />{folder}</button>)}</CardContent></Card></aside><section className="space-y-6"><section className="grid gap-3 md:grid-cols-4"><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardContent className="p-5"><FolderOpen /><p className="text-sm text-zinc-400">Files</p><p className="text-xl font-semibold">{summary?.totalFiles || 0}</p></CardContent></Card><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardContent className="p-5"><HardDrive /><p className="text-sm text-zinc-400">Used</p><p className="text-xl font-semibold">{bytes(summary?.totalBytes || 0)}</p></CardContent></Card><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardContent className="p-5"><ShieldCheck /><p className="text-sm text-zinc-400">Protection</p><p className="text-xl font-semibold">Encrypted</p></CardContent></Card><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardContent className="p-5"><Wifi /><p className="text-sm text-zinc-400">Network</p><p className="text-xl font-semibold">{displayedPeerCount} peers</p><p className="mt-1 text-xs text-zinc-500">{networkSubText}</p><p className="mt-1 truncate text-xs text-emerald-300">{cleanSafetyPeerLabel(summary?.safetyPeerUrl)}</p></CardContent></Card></section><Tabs defaultValue="files"><TabsList><TabsTrigger value="files">My Files</TabsTrigger><TabsTrigger value="upload">Upload</TabsTrigger></TabsList><TabsContent value="files" className="space-y-4"><div className="relative"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="pl-9" /></div><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visibleFiles.map((file) => <Card key={file.hash} className="rounded-2xl border-zinc-800 bg-zinc-900"><CardContent className="space-y-4 p-5"><div className="flex h-24 items-center justify-center rounded-2xl bg-zinc-950"><FileCheck2 className="size-10" /></div><div><p className="truncate font-semibold">{file.name}</p><p className="text-sm text-zinc-400">{bytes(file.size)} · {date(file.uploadedAt)}</p>{file.isEncrypted && <Badge variant="secondary"><Lock className="mr-1 size-3" />Encrypted</Badge>}</div><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => download(file)} disabled={busy}><Download className="size-4" />Download</Button><Button variant="outline" size="sm" onClick={() => proof(file)} disabled={busy}>Proof</Button><Button variant="destructive" size="sm" onClick={() => remove(file)} disabled={busy}><Trash2 className="size-4" />Delete</Button></div><select value={fileFolders[file.hash] || UNCATEGORIZED} onChange={(e) => setFileFolders((x) => ({ ...x, [file.hash]: e.target.value === UNCATEGORIZED ? "" : e.target.value }))} className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm"><option>{UNCATEGORIZED}</option>{folders.map((f) => <option key={f}>{f}</option>)}</select></CardContent></Card>)}</div></TabsContent><TabsContent value="upload"><Card className="rounded-2xl border-zinc-800 bg-zinc-900"><CardHeader><CardTitle><Upload className="mr-2 inline size-5" />Upload encrypted files</CardTitle></CardHeader><CardContent className="space-y-5"><div className="rounded-3xl border-2 border-dashed border-zinc-700 bg-zinc-950 p-8 text-center"><Upload className="mx-auto size-10" /><p className="mt-3 font-medium">Large-file safe mode</p><p className="text-sm text-zinc-500">Choose files with the native Windows picker. No browser RAM upload.</p></div><label className="flex gap-3 rounded-2xl border border-zinc-800 bg-zinc-950 p-4"><Checkbox checked={isEncrypted} onCheckedChange={(v) => setIsEncrypted(Boolean(v))} /><span>Encrypted storage</span></label><div className="space-y-2"><Label><KeyRound className="mr-2 inline size-4" />Drive Password</Label><Input type="password" value={drivePassword} onChange={(e) => setDrivePassword(e.target.value)} placeholder={`Minimum ${minPasswordLength} characters`} /></div><Button onClick={upload} disabled={busy || !walletConnected}><Zap className="size-4" />Choose & Store files</Button></CardContent></Card></TabsContent></Tabs></section></main></div>;
}
