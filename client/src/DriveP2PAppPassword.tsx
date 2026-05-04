import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Download, FileText, Folder, FolderPlus, Home, Image as ImageIcon, KeyRound, Lock, RefreshCw, Trash2, Upload, UnlockKeyhole, Wallet } from "lucide-react";
import { connectWalletWithWalletConnect } from "./walletConnect";

type Channel = "p2p:start" | "p2p:listFiles" | "p2p:upload" | "p2p:download" | "p2p:delete" | "p2p:networkSummary" | "wallet:status" | "wallet:connect" | "wallet:disconnect";
type Bridge = { invoke: <T>(channel: Channel, payload?: unknown) => Promise<T> };
type Wallet = { connected: boolean; address: string; plan?: { name: string; quotaBytes: number }; usedBytes: number };
type P2PFile = { name: string; size: number; hash: string; rootHash: string; uploadedAt: string; isEncrypted: boolean; mimeType?: string; ownerWallet?: string };
type Summary = { peerId: string; connectedPeers: number };
type DownloadResult = { file: P2PFile; bytes: number[] };

declare global { interface Window { electron?: Bridge } }

const FOLDER_MARKER = ".p2p-folder";
const FOLDER_MIME = "application/x-p2p-folder";
const getBridge = () => window.electron || null;
const clean = (v = "") => v.split("/").map((x) => x.trim()).filter(Boolean).join("/");
const join = (...p: string[]) => clean(p.join("/"));
const split = (p = "") => clean(p).split("/").filter(Boolean);
const base = (p = "") => split(p).pop() || "My Drive";
const dir = (p = "") => { const x = split(p); x.pop(); return x.join("/"); };
const short = (a = "") => a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "Not connected";
const bytes = (n = 0) => n >= 1024 ** 4 ? `${(n / 1024 ** 4).toFixed(2)} TB` : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(2)} KB` : `${n} B`;
const err = (e: unknown) => e instanceof Error ? e.message : "Operation failed";
const safe = (n: string) => n.replace(/[\\/:*?]/g, " ").replace(/\s+/g, " ").trim();
const isMarker = (f: P2PFile) => f.mimeType === FOLDER_MIME || clean(f.name).endsWith(`/${FOLDER_MARKER}`) || clean(f.name) === FOLDER_MARKER;
const markerPath = (f: P2PFile) => clean(f.name).endsWith(`/${FOLDER_MARKER}`) ? clean(f.name).slice(0, -1 * `/${FOLDER_MARKER}`.length) : dir(f.name);
const isImage = (f: P2PFile) => String(f.mimeType || "").startsWith("image/");

export default function DriveP2PAppPassword() {
  const electron = getBridge();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [files, setFiles] = useState<P2PFile[]>([]);
  const [path, setPath] = useState("");
  const [folder, setFolder] = useState("");
  const [drivePassword, setDrivePassword] = useState("");
  const [selected, setSelected] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [preview, setPreview] = useState<{ file: P2PFile; url: string } | null>(null);

  if (!electron) return <div className="min-h-screen bg-zinc-950 p-6 text-zinc-50"><Card className="mx-auto mt-16 max-w-xl border-red-900 bg-zinc-900"><CardHeader><CardTitle>Electron required</CardTitle></CardHeader><CardContent><pre className="rounded bg-zinc-950 p-3 text-xs">git pull{"\n"}pnpm run electron:dev</pre></CardContent></Card></div>;

  const connected = Boolean(wallet?.connected && wallet.address);
  const passwordReady = drivePassword.trim().length >= 6;
  const realFiles = useMemo(() => files.filter((f) => !isMarker(f)), [files]);
  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) {
      if (isMarker(f)) { const p = markerPath(f); if (p) set.add(p); continue; }
      const p = split(f.name);
      for (let i = 1; i < p.length; i++) set.add(p.slice(0, i).join("/"));
    }
    return Array.from(set).sort();
  }, [files]);
  const childFolders = folders.filter((f) => dir(f) === path);
  const shownFiles = realFiles.filter((f) => dir(f.name) === path);
  const selectedBytes = selected.reduce((s, f) => s + f.size, 0);
  const quota = wallet?.plan?.quotaBytes || 0;
  const pct = quota ? Math.min(100, ((wallet?.usedBytes || 0) / quota) * 100) : 0;

  const run = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } catch (e) { toast.error(err(e)); } finally { setBusy(false); } };
  const refresh = async () => {
    const [s, f, w] = await Promise.all([electron.invoke<Summary>("p2p:networkSummary"), electron.invoke<P2PFile[]>("p2p:listFiles", { query: "" }), electron.invoke<Wallet>("wallet:status")]);
    setSummary(s); setFiles(Array.isArray(f) ? f : []); setWallet(w);
  };
  useEffect(() => { void run(async () => { await electron.invoke("p2p:start"); await refresh(); }); }, []);
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview?.url]);

  const connect = async () => {
    setConnecting(true);
    try {
      const r = await connectWalletWithWalletConnect();
      const w = await electron.invoke<Wallet>("wallet:connect", { address: r.address, encryptionSignature: r.signature || r.encryptionSignature });
      setWallet(w); await refresh(); toast.success("Wallet connected");
    } catch (e) { toast.error(err(e)); } finally { setConnecting(false); }
  };
  const disconnect = () => run(async () => { setWallet(await electron.invoke<Wallet>("wallet:disconnect")); setFiles([]); setPath(""); });
  const requirePassword = () => { if (!passwordReady) throw new Error("Enter Drive Password. Minimum 6 characters."); };
  const createFolder = () => run(async () => {
    if (!connected) throw new Error("Connect wallet first");
    requirePassword();
    const name = safe(folder);
    if (!name) throw new Error("Type a folder name first");
    const p = join(path, name);
    await electron.invoke("p2p:upload", { name: join(p, FOLDER_MARKER), mimeType: FOLDER_MIME, isEncrypted: true, drivePassword, bytes: new TextEncoder().encode(`folder:${p}`).buffer });
    setFolder(""); await refresh(); toast.success("Folder created");
  });
  const upload = () => run(async () => {
    if (!connected) throw new Error("Connect wallet first");
    requirePassword();
    if (!selected.length) throw new Error("Select files first");
    for (const file of selected) await electron.invoke("p2p:upload", { name: join(path, file.name), mimeType: file.type || "application/octet-stream", isEncrypted: true, drivePassword, bytes: await file.arrayBuffer() });
    setSelected([]); await refresh(); toast.success("Encrypted upload complete");
  });
  const download = (file: P2PFile) => run(async () => {
    if (file.isEncrypted) requirePassword();
    const r = await electron.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword });
    const blob = new Blob([new Uint8Array(r.bytes)], { type: r.file.mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = base(r.file.name); document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });
  const open = (file: P2PFile) => run(async () => {
    if (!isImage(file)) { await download(file); return; }
    if (file.isEncrypted) requirePassword();
    const r = await electron.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword });
    const blob = new Blob([new Uint8Array(r.bytes)], { type: r.file.mimeType || "image/*" });
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview({ file, url: URL.createObjectURL(blob) });
  });
  const remove = (file: P2PFile) => run(async () => { if (!confirm(`Delete ${base(file.name)}?`)) return; await electron.invoke("p2p:delete", { hash: file.hash }); await refresh(); });
  const removeFolder = (p: string) => run(async () => { const all = files.filter((f) => clean(f.name).startsWith(`${p}/`)); if (!confirm(`Delete ${base(p)} and ${all.length} item(s)?`)) return; for (const f of all) await electron.invoke("p2p:delete", { hash: f.hash }); if (path.startsWith(p)) setPath(dir(p)); await refresh(); });

  return <div className="min-h-screen bg-zinc-950 text-zinc-50"><header className="border-b border-zinc-800"><div className="container flex flex-col gap-4 py-5 lg:flex-row lg:items-center lg:justify-between"><div><h1 className="text-2xl font-semibold">P2P Drive</h1><p className="text-sm text-zinc-400">{summary ? `${summary.peerId} · peers ${summary.connectedPeers}` : "Starting"}</p></div><div className="flex flex-wrap gap-2"><Badge variant={connected ? "default" : "destructive"}>{connected ? <UnlockKeyhole className="mr-1 size-4" /> : <Lock className="mr-1 size-4" />}{connected ? short(wallet?.address) : "Locked"}</Badge>{connected ? <Button variant="outline" onClick={disconnect}>Disconnect</Button> : <Button onClick={connect} disabled={connecting}><Wallet className="size-4" />{connecting ? "Connecting" : "Connect Wallet"}</Button>}<Button variant="outline" onClick={() => run(refresh)}><RefreshCw className="size-4" />Refresh</Button></div></div></header><main className="container space-y-5 py-6"><section className="grid gap-3 md:grid-cols-4"><Card className="border-zinc-800 bg-zinc-900"><CardContent className="pt-6"><p className="text-sm text-zinc-400">Plan</p><p className="text-xl font-semibold">{wallet?.plan?.name || "Free"}</p></CardContent></Card><Card className="border-zinc-800 bg-zinc-900"><CardContent className="pt-6"><p className="text-sm text-zinc-400">Used</p><p className="text-xl font-semibold">{bytes(wallet?.usedBytes || 0)}</p></CardContent></Card><Card className="border-zinc-800 bg-zinc-900"><CardContent className="pt-6"><p className="text-sm text-zinc-400">Files</p><p className="text-xl font-semibold">{realFiles.length}</p></CardContent></Card><Card className="border-zinc-800 bg-zinc-900"><CardContent className="pt-6"><p className="text-sm text-zinc-400">Folders</p><p className="text-xl font-semibold">{folders.length}</p></CardContent></Card></section><Card className="border-zinc-800 bg-zinc-900"><CardHeader className="space-y-4"><CardTitle className="flex items-center gap-2"><Folder className="size-5" />My Drive</CardTitle><div className="rounded border border-amber-800 bg-amber-950/30 p-3"><div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-200"><KeyRound className="size-4" />Drive Password</div><Input type="password" value={drivePassword} onChange={(e) => setDrivePassword(e.target.value)} placeholder="Enter your Drive Password" disabled={!connected || busy} /><p className="mt-2 text-xs text-amber-200/80">Same wallet + same password opens encrypted files from any device. If you forget it, encrypted files cannot be recovered.</p></div><div className="flex flex-wrap items-center gap-1 text-sm text-zinc-400"><button onClick={() => setPath("")} className="flex items-center gap-1 rounded px-2 py-1 hover:bg-zinc-800"><Home className="size-4" />My Drive</button>{split(path).map((p, i) => <button key={`${p}-${i}`} onClick={() => setPath(split(path).slice(0, i + 1).join("/"))} className="rounded px-2 py-1 hover:bg-zinc-800">/ {p}</button>)}</div><div className="grid gap-2 lg:grid-cols-[1fr_auto]"><Input value={folder} onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void createFolder(); }} placeholder="Folder name" disabled={!connected || busy} /><Button onClick={createFolder} disabled={!connected || busy || !folder.trim() || !passwordReady}><FolderPlus className="size-4" />New Folder</Button></div><div className="flex flex-wrap gap-2"><Input type="file" multiple onChange={(e: ChangeEvent<HTMLInputElement>) => setSelected(Array.from(e.target.files || []))} disabled={!connected || busy} className="max-w-xs" /><Button onClick={upload} disabled={!connected || busy || !selected.length || !passwordReady}><Upload className="size-4" />Encrypt & Upload</Button><span className="text-sm text-zinc-500">Selected {selected.length} · {bytes(selectedBytes)}</span></div><div className="h-2 overflow-hidden rounded-full bg-zinc-800"><div className="h-full bg-zinc-50" style={{ width: `${pct}%` }} /></div></CardHeader><CardContent className="space-y-4">{!connected && <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-100">Connect wallet to load and upload files.</div>}{path && <Button variant="outline" onClick={() => setPath(dir(path))}>Back</Button>}<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">{childFolders.map((p) => <Card key={p} className="border-zinc-800 bg-zinc-950"><CardContent className="p-4"><button onClick={() => setPath(p)} className="mb-3 flex w-full items-center gap-2 text-left"><Folder className="size-8 text-yellow-300" /><span className="truncate font-medium">{base(p)}</span></button><Button variant="ghost" size="sm" onClick={() => removeFolder(p)}><Trash2 className="size-4" /></Button></CardContent></Card>)}{shownFiles.map((file) => <Card key={file.hash} className="border-zinc-800 bg-zinc-950"><CardContent className="p-4"><button onClick={() => open(file)} className="block w-full text-left"><div className="mb-3 flex h-24 items-center justify-center rounded bg-zinc-900">{isImage(file) ? <ImageIcon className="size-9 text-emerald-300" /> : <FileText className="size-9 text-cyan-300" />}</div><p className="truncate font-medium">{base(file.name)}</p><p className="text-xs text-zinc-500">{bytes(file.size)} · {file.isEncrypted ? "Encrypted" : "Public"}</p></button><div className="mt-3 flex gap-2"><Button variant="outline" size="sm" onClick={() => download(file)} disabled={file.isEncrypted && !passwordReady}><Download className="size-4" /></Button><Button variant="destructive" size="sm" onClick={() => remove(file)}><Trash2 className="size-4" /></Button></div></CardContent></Card>)}</div>{childFolders.length === 0 && shownFiles.length === 0 && <div className="rounded border border-dashed border-zinc-800 py-12 text-center text-zinc-500">Empty folder</div>}</CardContent></Card></main>{preview && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setPreview(null)}><div className="max-h-[90vh] max-w-5xl rounded bg-zinc-950 p-4" onClick={(e) => e.stopPropagation()}><div className="mb-3 flex items-center justify-between gap-3"><p className="truncate font-medium">{base(preview.file.name)}</p><Button variant="outline" onClick={() => setPreview(null)}>Close</Button></div><img src={preview.url} alt={base(preview.file.name)} className="max-h-[75vh] max-w-full object-contain" /></div></div>}</div>;
}
