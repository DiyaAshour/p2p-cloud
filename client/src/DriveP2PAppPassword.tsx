import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Cloud,
  Download,
  FileText,
  Folder,
  FolderPlus,
  HardDrive,
  Home,
  Image as ImageIcon,
  KeyRound,
  Lock,
  Network,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  UnlockKeyhole,
  Wallet,
  X,
} from "lucide-react";
import { connectWalletWithWalletConnect } from "./walletConnect";

type Channel =
  | "p2p:start"
  | "p2p:listFiles"
  | "p2p:upload"
  | "p2p:download"
  | "p2p:delete"
  | "p2p:networkSummary"
  | "wallet:status"
  | "wallet:connect"
  | "wallet:disconnect";
type Bridge = { invoke: <T>(channel: Channel, payload?: unknown) => Promise<T> };
type Wallet = { connected: boolean; address: string; plan?: { name: string; quotaBytes: number }; usedBytes: number; minDrivePasswordLength?: number };
type P2PFile = { name: string; size: number; hash: string; rootHash: string; uploadedAt: string; isEncrypted: boolean; mimeType?: string; ownerWallet?: string };
type Summary = { peerId: string; connectedPeers: number };
type DownloadResult = { file: P2PFile; bytes: number[] };

declare global {
  interface Window {
    electron?: Bridge;
  }
}

const FOLDER_MARKER = ".p2p-folder";
const FOLDER_MIME = "application/x-p2p-folder";
const DEFAULT_MIN_DRIVE_PASSWORD_LENGTH = 12;
const getBridge = () => window.electron || null;
const clean = (v = "") => v.split("/").map((x) => x.trim()).filter(Boolean).join("/");
const join = (...p: string[]) => clean(p.join("/"));
const split = (p = "") => clean(p).split("/").filter(Boolean);
const base = (p = "") => split(p).pop() || "My Drive";
const dir = (p = "") => {
  const x = split(p);
  x.pop();
  return x.join("/");
};
const short = (a = "") => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "Not connected");
const bytes = (n = 0) =>
  n >= 1024 ** 4
    ? `${(n / 1024 ** 4).toFixed(2)} TB`
    : n >= 1024 ** 3
      ? `${(n / 1024 ** 3).toFixed(2)} GB`
      : n >= 1024 ** 2
        ? `${(n / 1024 ** 2).toFixed(2)} MB`
        : n >= 1024
          ? `${(n / 1024).toFixed(2)} KB`
          : `${n} B`;
const err = (e: unknown) => (e instanceof Error ? e.message : "Operation failed");
const safe = (n: string) => n.replace(/[\\/:*?]/g, " ").replace(/\s+/g, " ").trim();
const isMarker = (f: P2PFile) => f.mimeType === FOLDER_MIME || clean(f.name).endsWith(`/${FOLDER_MARKER}`) || clean(f.name) === FOLDER_MARKER;
const markerPath = (f: P2PFile) => (clean(f.name).endsWith(`/${FOLDER_MARKER}`) ? clean(f.name).slice(0, -1 * `/${FOLDER_MARKER}`.length) : dir(f.name));
const isImage = (f: P2PFile) => String(f.mimeType || "").startsWith("image/");
const formatDate = (value = "") => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "Unknown date" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
const gradientCard = "border-white/10 bg-white/[0.055] shadow-2xl shadow-black/20 backdrop-blur-xl";
const glow = "before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:bg-gradient-to-br before:from-cyan-400/20 before:via-violet-500/10 before:to-emerald-400/10 before:opacity-70";

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

  if (!electron) {
    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,#16213f_0%,#09090b_48%,#000_100%)] p-6 text-zinc-50">
        <Card className={`relative mx-auto mt-16 max-w-2xl overflow-hidden ${gradientCard} ${glow}`}>
          <CardHeader className="relative">
            <Badge className="mb-3 w-fit border-red-400/30 bg-red-500/10 text-red-100">Desktop mode required</Badge>
            <CardTitle className="text-3xl">P2P Drive needs Electron IPC</CardTitle>
          </CardHeader>
          <CardContent className="relative space-y-4 text-zinc-300">
            <p>Browser-only mode can show the UI, but local node controls, encrypted storage, and system-level chunk access require Electron.</p>
            <pre className="rounded-2xl border border-white/10 bg-black/60 p-4 text-xs text-cyan-100">git pull{"\n"}pnpm install{"\n"}pnpm run electron:dev</pre>
          </CardContent>
        </Card>
      </div>
    );
  }

  const minDrivePasswordLength = wallet?.minDrivePasswordLength || DEFAULT_MIN_DRIVE_PASSWORD_LENGTH;
  const connected = Boolean(wallet?.connected && wallet.address);
  const passwordReady = drivePassword.trim().length >= minDrivePasswordLength;
  const realFiles = useMemo(() => files.filter((f) => !isMarker(f)), [files]);
  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) {
      if (isMarker(f)) {
        const p = markerPath(f);
        if (p) set.add(p);
        continue;
      }
      const p = split(f.name);
      for (let i = 1; i < p.length; i++) set.add(p.slice(0, i).join("/"));
    }
    return Array.from(set).sort();
  }, [files]);
  const childFolders = folders.filter((f) => dir(f) === path);
  const shownFiles = realFiles.filter((f) => dir(f.name) === path);
  const selectedBytes = selected.reduce((s, f) => s + f.size, 0);
  const quota = wallet?.plan?.quotaBytes || 0;
  const used = wallet?.usedBytes || 0;
  const pct = quota ? Math.min(100, (used / quota) * 100) : 0;
  const peerState = summary?.connectedPeers ? "Live mesh" : "Local node";

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      toast.error(err(e));
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    const [s, f, w] = await Promise.all([
      electron.invoke<Summary>("p2p:networkSummary"),
      electron.invoke<P2PFile[]>("p2p:listFiles", { query: "" }),
      electron.invoke<Wallet>("wallet:status"),
    ]);
    setSummary(s);
    setFiles(Array.isArray(f) ? f : []);
    setWallet(w);
  };

  useEffect(() => {
    void run(async () => {
      await electron.invoke("p2p:start");
      await refresh();
    });
  }, []);
  useEffect(() => () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
  }, [preview?.url]);

  const connect = async () => {
    setConnecting(true);
    try {
      const r = await connectWalletWithWalletConnect();
      const w = await electron.invoke<Wallet>("wallet:connect", { address: r.address, loginMessage: r.loginMessage, signature: r.signature });
      setWallet(w);
      await refresh();
      toast.success("Wallet connected");
    } catch (e) {
      toast.error(err(e));
    } finally {
      setConnecting(false);
    }
  };
  const disconnect = () => run(async () => {
    setWallet(await electron.invoke<Wallet>("wallet:disconnect"));
    setFiles([]);
    setPath("");
  });
  const requirePassword = () => {
    if (!passwordReady) throw new Error(`Enter Drive Password. Minimum ${minDrivePasswordLength} characters.`);
  };
  const createFolder = () => run(async () => {
    if (!connected) throw new Error("Connect wallet first");
    requirePassword();
    const name = safe(folder);
    if (!name) throw new Error("Type a folder name first");
    const p = join(path, name);
    await electron.invoke("p2p:upload", {
      name: join(p, FOLDER_MARKER),
      mimeType: FOLDER_MIME,
      isEncrypted: true,
      drivePassword,
      bytes: new TextEncoder().encode(`folder:${p}`).buffer,
    });
    setFolder("");
    await refresh();
    toast.success("Folder created");
  });
  const upload = () => run(async () => {
    if (!connected) throw new Error("Connect wallet first");
    requirePassword();
    if (!selected.length) throw new Error("Select files first");
    for (const file of selected) {
      await electron.invoke("p2p:upload", {
        name: join(path, file.name),
        mimeType: file.type || "application/octet-stream",
        isEncrypted: true,
        drivePassword,
        bytes: await file.arrayBuffer(),
      });
    }
    setSelected([]);
    await refresh();
    toast.success("Encrypted upload complete");
  });
  const download = (file: P2PFile) => run(async () => {
    if (file.isEncrypted) requirePassword();
    const r = await electron.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword });
    const blob = new Blob([new Uint8Array(r.bytes)], { type: r.file.mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = base(r.file.name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
  const open = (file: P2PFile) => run(async () => {
    if (!isImage(file)) {
      await download(file);
      return;
    }
    if (file.isEncrypted) requirePassword();
    const r = await electron.invoke<DownloadResult>("p2p:download", { hash: file.hash, drivePassword });
    const blob = new Blob([new Uint8Array(r.bytes)], { type: r.file.mimeType || "image/*" });
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview({ file, url: URL.createObjectURL(blob) });
  });
  const remove = (file: P2PFile) => run(async () => {
    if (!confirm(`Delete ${base(file.name)}?`)) return;
    await electron.invoke("p2p:delete", { hash: file.hash });
    await refresh();
  });
  const removeFolder = (p: string) => run(async () => {
    const all = files.filter((f) => clean(f.name).startsWith(`${p}/`));
    if (!confirm(`Delete ${base(p)} and ${all.length} item(s)?`)) return;
    for (const f of all) await electron.invoke("p2p:delete", { hash: f.hash });
    if (path.startsWith(p)) setPath(dir(p));
    await refresh();
  });

  return (
    <div className="min-h-screen overflow-hidden bg-[#05060a] text-zinc-50">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_10%_10%,rgba(34,211,238,0.18),transparent_30%),radial-gradient(circle_at_90%_0%,rgba(139,92,246,0.18),transparent_34%),radial-gradient(circle_at_50%_90%,rgba(16,185,129,0.14),transparent_32%)]" />
      <div className="pointer-events-none fixed inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:48px_48px] opacity-20" />

      <header className="relative border-b border-white/10 bg-black/25 backdrop-blur-xl">
        <div className="container flex flex-col gap-5 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <div className="relative grid size-12 place-items-center rounded-2xl border border-cyan-300/30 bg-cyan-400/10 shadow-lg shadow-cyan-500/10">
              <Cloud className="size-6 text-cyan-200" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">P2P Cloud</h1>
                <Badge className="border-emerald-300/20 bg-emerald-400/10 text-emerald-100">Zero-trust drive</Badge>
              </div>
              <p className="text-sm text-zinc-400">Wallet-gated encrypted chunks over your local P2P node.</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={connected ? "default" : "destructive"} className={connected ? "bg-emerald-500/15 text-emerald-100" : ""}>
              {connected ? <UnlockKeyhole className="mr-1 size-4" /> : <Lock className="mr-1 size-4" />}
              {connected ? short(wallet?.address) : "Wallet locked"}
            </Badge>
            {connected ? (
              <Button variant="outline" onClick={disconnect} disabled={busy}>Disconnect</Button>
            ) : (
              <Button onClick={connect} disabled={connecting || busy} className="bg-cyan-300 text-zinc-950 hover:bg-cyan-200">
                <Wallet className="size-4" />
                {connecting ? "Connecting" : "Connect Wallet"}
              </Button>
            )}
            <Button variant="outline" onClick={() => run(refresh)} disabled={busy}>
              <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      <main className="container relative space-y-6 py-6">
        <section className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
          <Card className={`relative overflow-hidden ${gradientCard} ${glow}`}>
            <CardContent className="relative p-6 md:p-8">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                <div className="max-w-2xl space-y-4">
                  <Badge className="w-fit border-cyan-300/20 bg-cyan-400/10 text-cyan-100">
                    <Sparkles className="mr-1 size-3.5" />
                    Private cloud without a central vault
                  </Badge>
                  <div>
                    <h2 className="text-4xl font-semibold tracking-tight md:text-5xl">Your wallet is the key. Your device is the node.</h2>
                    <p className="mt-3 max-w-xl text-sm leading-6 text-zinc-300 md:text-base">
                      Upload encrypted files, organize them like a real drive, and reopen them from another device using the same wallet and Drive Password.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                      <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Network</p>
                      <p className="mt-2 flex items-center gap-2 text-lg font-semibold"><Network className="size-4 text-cyan-200" />{peerState}</p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                      <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Peers</p>
                      <p className="mt-2 flex items-center gap-2 text-lg font-semibold"><Activity className="size-4 text-emerald-200" />{summary?.connectedPeers ?? 0}</p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                      <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Security</p>
                      <p className="mt-2 flex items-center gap-2 text-lg font-semibold"><ShieldCheck className="size-4 text-violet-200" />Encrypted</p>
                    </div>
                  </div>
                </div>
                <div className="min-w-64 rounded-3xl border border-white/10 bg-black/40 p-5">
                  <p className="text-sm text-zinc-400">Storage usage</p>
                  <div className="mt-3 flex items-end justify-between gap-4">
                    <div>
                      <p className="text-3xl font-semibold">{bytes(used)}</p>
                      <p className="text-xs text-zinc-500">of {quota ? bytes(quota) : "unlimited / unknown"}</p>
                    </div>
                    <HardDrive className="size-9 text-cyan-200" />
                  </div>
                  <div className="mt-5 h-3 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-gradient-to-r from-cyan-300 via-blue-400 to-violet-400" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className={gradientCard}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><KeyRound className="size-5 text-amber-200" />Drive Password</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                type="password"
                value={drivePassword}
                onChange={(e) => setDrivePassword(e.target.value)}
                placeholder={`Minimum ${minDrivePasswordLength} characters`}
                disabled={!connected || busy}
                className="h-12 border-amber-300/20 bg-black/30"
              />
              <div className={`rounded-2xl border p-4 text-sm ${passwordReady ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100" : "border-amber-300/20 bg-amber-400/10 text-amber-100"}`}>
                <div className="mb-1 flex items-center gap-2 font-medium">
                  {passwordReady ? <CheckCircle2 className="size-4" /> : <Lock className="size-4" />}
                  {passwordReady ? "Ready to decrypt" : `Minimum ${minDrivePasswordLength} characters required`}
                </div>
                <p className="text-xs opacity-80">Same wallet + same password opens encrypted files from any device. Forgotten passwords cannot be recovered.</p>
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 md:grid-cols-4">
          {[
            { label: "Plan", value: wallet?.plan?.name || "Free", icon: Wallet },
            { label: "Files", value: String(realFiles.length), icon: FileText },
            { label: "Folders", value: String(folders.length), icon: Folder },
            { label: "Node ID", value: summary?.peerId ? short(summary.peerId) : "Starting", icon: Network },
          ].map((item) => (
            <Card key={item.label} className={gradientCard}>
              <CardContent className="flex items-center justify-between p-5">
                <div>
                  <p className="text-sm text-zinc-400">{item.label}</p>
                  <p className="mt-1 text-xl font-semibold">{item.value}</p>
                </div>
                <div className="grid size-11 place-items-center rounded-2xl border border-white/10 bg-white/10">
                  <item.icon className="size-5 text-cyan-100" />
                </div>
              </CardContent>
            </Card>
          ))}
        </section>

        <Card className={gradientCard}>
          <CardHeader className="space-y-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2"><Folder className="size-5 text-cyan-200" />My Drive</CardTitle>
                <p className="mt-1 text-sm text-zinc-400">Clean folder system, encrypted uploads, image previews, and one-click downloads.</p>
              </div>
              {path && (
                <Button variant="outline" onClick={() => setPath(dir(path))}>
                  <ArrowLeft className="size-4" />
                  Back
                </Button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1 rounded-2xl border border-white/10 bg-black/25 p-2 text-sm text-zinc-400">
              <button onClick={() => setPath("")} className="flex items-center gap-1 rounded-xl px-3 py-2 transition hover:bg-white/10 hover:text-white">
                <Home className="size-4" />
                My Drive
              </button>
              {split(path).map((p, i) => (
                <button key={`${p}-${i}`} onClick={() => setPath(split(path).slice(0, i + 1).join("/"))} className="rounded-xl px-3 py-2 transition hover:bg-white/10 hover:text-white">
                  / {p}
                </button>
              ))}
            </div>

            <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr_auto]">
              <Input value={folder} onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void createFolder(); }} placeholder="New folder name" disabled={!connected || busy} className="h-12 bg-black/30" />
              <Button onClick={createFolder} disabled={!connected || busy || !folder.trim() || !passwordReady} className="h-12">
                <FolderPlus className="size-4" />
                New Folder
              </Button>
              <Input type="file" multiple onChange={(e: ChangeEvent<HTMLInputElement>) => setSelected(Array.from(e.target.files || []))} disabled={!connected || busy} className="h-12 bg-black/30" />
              <Button onClick={upload} disabled={!connected || busy || !selected.length || !passwordReady} className="h-12 bg-cyan-300 text-zinc-950 hover:bg-cyan-200">
                <Upload className="size-4" />
                Encrypt & Upload
              </Button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-cyan-300/20 bg-cyan-300/5 p-4">
              <div>
                <p className="font-medium">Selected {selected.length} item(s)</p>
                <p className="text-sm text-zinc-400">Total upload size: {bytes(selectedBytes)} · Destination: {path || "My Drive"}</p>
              </div>
              {!connected && <Badge variant="destructive">Connect wallet first</Badge>}
              {connected && !passwordReady && <Badge className="border-amber-300/20 bg-amber-400/10 text-amber-100">Use {minDrivePasswordLength}+ characters</Badge>}
              {connected && passwordReady && <Badge className="border-emerald-300/20 bg-emerald-400/10 text-emerald-100">Ready</Badge>}
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            {!connected && <div className="rounded-2xl border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">Connect wallet to load, upload, download, and delete your encrypted drive files.</div>}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
              {childFolders.map((p) => (
                <Card key={p} className="group overflow-hidden border-white/10 bg-black/35 transition hover:-translate-y-0.5 hover:border-cyan-300/30 hover:bg-white/[0.07]">
                  <CardContent className="p-4">
                    <button onClick={() => setPath(p)} className="mb-4 block w-full text-left">
                      <div className="mb-3 grid h-28 place-items-center rounded-2xl border border-yellow-300/10 bg-yellow-300/10">
                        <Folder className="size-10 text-yellow-200 transition group-hover:scale-110" />
                      </div>
                      <p className="truncate font-medium">{base(p)}</p>
                      <p className="text-xs text-zinc-500">Encrypted folder</p>
                    </button>
                    <Button variant="ghost" size="sm" onClick={() => removeFolder(p)} className="text-zinc-400 hover:text-red-200">
                      <Trash2 className="size-4" />
                      Delete
                    </Button>
                  </CardContent>
                </Card>
              ))}

              {shownFiles.map((file) => (
                <Card key={file.hash} className="group overflow-hidden border-white/10 bg-black/35 transition hover:-translate-y-0.5 hover:border-cyan-300/30 hover:bg-white/[0.07]">
                  <CardContent className="p-4">
                    <button onClick={() => open(file)} className="block w-full text-left">
                      <div className="mb-3 grid h-28 place-items-center rounded-2xl border border-white/10 bg-white/[0.055]">
                        {isImage(file) ? <ImageIcon className="size-10 text-emerald-200 transition group-hover:scale-110" /> : <FileText className="size-10 text-cyan-200 transition group-hover:scale-110" />}
                      </div>
                      <p className="truncate font-medium">{base(file.name)}</p>
                      <p className="text-xs text-zinc-500">{bytes(file.size)} · {formatDate(file.uploadedAt)}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <Badge className={file.isEncrypted ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100" : "border-zinc-300/20 bg-zinc-400/10 text-zinc-100"}>
                          {file.isEncrypted ? "Encrypted" : "Public"}
                        </Badge>
                      </div>
                    </button>
                    <div className="mt-4 flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => download(file)} disabled={file.isEncrypted && !passwordReady}>
                        <Download className="size-4" />
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => remove(file)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {childFolders.length === 0 && shownFiles.length === 0 && (
              <div className="rounded-3xl border border-dashed border-white/15 bg-black/25 py-16 text-center">
                <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl border border-cyan-300/20 bg-cyan-300/10">
                  <Upload className="size-7 text-cyan-200" />
                </div>
                <p className="text-lg font-medium">This folder is empty</p>
                <p className="mt-1 text-sm text-zinc-500">Create a folder or upload encrypted files to start building your private mesh drive.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md" onClick={() => setPreview(null)}>
          <div className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-3xl border border-white/10 bg-zinc-950 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 border-b border-white/10 p-4">
              <div>
                <p className="truncate font-medium">{base(preview.file.name)}</p>
                <p className="text-xs text-zinc-500">{bytes(preview.file.size)} · encrypted preview</p>
              </div>
              <Button variant="outline" onClick={() => setPreview(null)}>
                <X className="size-4" />
                Close
              </Button>
            </div>
            <div className="grid max-h-[78vh] place-items-center p-4">
              <img src={preview.url} alt={base(preview.file.name)} className="max-h-[72vh] max-w-full rounded-2xl object-contain" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
