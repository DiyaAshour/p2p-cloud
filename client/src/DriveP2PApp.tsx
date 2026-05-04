import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderPlus,
  Grid3X3,
  Home,
  Image as ImageIcon,
  Link2,
  Lock,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  UnlockKeyhole,
  Wallet,
} from "lucide-react";
import { connectWalletWithWalletConnect } from "./walletConnect";

type P2PChannel =
  | "p2p:start"
  | "p2p:listFiles"
  | "p2p:upload"
  | "p2p:download"
  | "p2p:delete"
  | "p2p:networkSummary"
  | "p2p:bootstrapNow"
  | "p2p:repair"
  | "wallet:status"
  | "wallet:connect"
  | "wallet:disconnect";

type ElectronBridge = { invoke: <T>(channel: P2PChannel, payload?: unknown) => Promise<T>; isElectron?: boolean };
type WalletPlan = { id: string; name: string; quotaBytes: number; priceUsd: number; locked?: boolean };
type WalletState = { ok: boolean; connected: boolean; address: string; planId: string; plan: WalletPlan; plans: WalletPlan[]; usedBytes: number; remainingBytes: number };
type P2PFile = {
  id: string;
  name: string;
  size: number;
  hash: string;
  rootHash: string;
  uploadedAt: string;
  isEncrypted: boolean;
  mimeType?: string;
  totalChunks: number;
  ownerNodeId: string;
  ownerWallet?: string;
  planId?: string;
  replicas: string[];
};
type P2PSummary = { ok: boolean; peerId: string; listenUrl: string; connectedPeers: number; totalFiles: number; totalBytes: number; encryptedFiles: number; underReplicatedChunks: number };
type DownloadResult = { ok: boolean; file: P2PFile; bytes: number[] };
type ViewMode = "grid" | "list";

declare global { interface Window { electron?: ElectronBridge } }

const FOLDER_MARKER = ".p2p-folder";
const FOLDER_MIME = "application/x-p2p-folder";
const DRIVE_PASSWORD_STORAGE_KEY = "p2p.cloud.drivePassword";

function getElectronBridge(): ElectronBridge | null {
  return typeof window !== "undefined" && typeof window.electron?.invoke === "function" ? window.electron : null;
}

function formatBytes(bytes = 0) {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

function formatDate(value?: string | number | null) {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Operation failed";
}

function shortAddress(address = "") {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Not connected";
}

function cleanPath(value = "") {
  return value.split("/").map((part) => part.trim()).filter(Boolean).join("/");
}

function joinPath(...parts: string[]) {
  return cleanPath(parts.join("/"));
}

function baseName(path = "") {
  const parts = cleanPath(path).split("/").filter(Boolean);
  return parts[parts.length - 1] || "My Drive";
}

function dirname(path = "") {
  const parts = cleanPath(path).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function isFolderMarker(file: P2PFile) {
  return file.mimeType === FOLDER_MIME || cleanPath(file.name).endsWith(`/${FOLDER_MARKER}`) || cleanPath(file.name) === FOLDER_MARKER;
}

function isImageFile(file: P2PFile) {
  return String(file.mimeType || "").startsWith("image/");
}

function folderPathFromMarker(file: P2PFile) {
  const name = cleanPath(file.name);
  if (name === FOLDER_MARKER) return "";
  return name.endsWith(`/${FOLDER_MARKER}`) ? name.slice(0, -1 * (`/${FOLDER_MARKER}`.length)) : dirname(name);
}

function sanitizeFolderName(name: string) {
  return name.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
}

function pathParts(path = "") {
  return cleanPath(path).split("/").filter(Boolean);
}

function readStoredDrivePassword() {
  try { return localStorage.getItem(DRIVE_PASSWORD_STORAGE_KEY) || ""; } catch { return ""; }
}

function ElectronRequiredScreen() {
  return (
    <div className="min-h-screen bg-zinc-950 p-6 text-zinc-50">
      <Card className="mx-auto mt-16 max-w-2xl rounded-md border-red-900 bg-zinc-900">
        <CardHeader><CardTitle>Electron preload bridge is missing</CardTitle></CardHeader>
        <CardContent className="space-y-4 text-sm text-zinc-300">
          <p>Drive Mode needs Electron because uploads, downloads, wallet gate, and local P2P node controls run through IPC.</p>
          <pre className="overflow-auto rounded bg-zinc-950 p-3 text-xs">git pull{"\n"}pnpm run electron:dev</pre>
        </CardContent>
      </Card>
    </div>
  );
}

export default function DriveP2PApp() {
  const bridge = getElectronBridge();
  const [summary, setSummary] = useState<P2PSummary | null>(null);
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [files, setFiles] = useState<P2PFile[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [previewFile, setPreviewFile] = useState<P2PFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [drivePassword, setDrivePassword] = useState(() => readStoredDrivePassword());

  if (!bridge) return <ElectronRequiredScreen />;

  const walletConnected = Boolean(wallet?.connected && wallet.address);
  const selectedBytes = useMemo(() => selectedFiles.reduce((sum, file) => sum + file.size, 0), [selectedFiles]);
  const quotaPercent = wallet?.plan?.quotaBytes ? Math.min(100, (wallet.usedBytes / wallet.plan.quotaBytes) * 100) : 0;
  const uploadWouldExceedQuota = Boolean(wallet && selectedBytes > 0 && wallet.usedBytes + selectedBytes > wallet.plan.quotaBytes);

  const realFiles = useMemo(() => files.filter((file) => !isFolderMarker(file)), [files]);
  const folderPaths = useMemo(() => {
    const set = new Set<string>();
    for (const file of files) {
      if (isFolderMarker(file)) {
        const folder = folderPathFromMarker(file);
        if (folder) set.add(folder);
        continue;
      }
      const parts = pathParts(file.name);
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/"));
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [files]);

  const childFolders = useMemo(() => {
    const query = search.trim().toLowerCase();
    const children = folderPaths
      .filter((folderPath) => dirname(folderPath) === currentPath)
      .map((folderPath) => ({ path: folderPath, name: baseName(folderPath) }))
      .filter((folder) => !query || folder.name.toLowerCase().includes(query));
    return children.sort((a, b) => a.name.localeCompare(b.name));
  }, [folderPaths, currentPath, search]);

  const currentFiles = useMemo(() => {
    const query = search.trim().toLowerCase();
    return realFiles
      .filter((file) => dirname(file.name) === currentPath)
      .filter((file) => !query || [baseName(file.name), file.hash, file.rootHash, file.ownerWallet || ""].some((value) => value.toLowerCase().includes(query)))
      .sort((a, b) => baseName(a.name).localeCompare(baseName(b.name)));
  }, [realFiles, currentPath, search]);

  const imageCount = currentFiles.filter(isImageFile).length;
  const currentCrumbs = pathParts(currentPath);

  const requireDrivePassword = () => {
    const password = drivePassword.trim();
    if (password.length < 6) throw new Error("Drive Password required. Use at least 6 characters.");
    try { localStorage.setItem(DRIVE_PASSWORD_STORAGE_KEY, password); } catch {}
    return password;
  };

  const runBusy = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); } catch (error) { toast.error(errorMessage(error)); } finally { setBusy(false); }
  };

  const refreshAll = async () => {
    const [nextSummary, nextFiles, nextWallet] = await Promise.all([
      bridge.invoke<P2PSummary>("p2p:networkSummary"),
      bridge.invoke<P2PFile[]>("p2p:listFiles", { query: "" }),
      bridge.invoke<WalletState>("wallet:status"),
    ]);
    setSummary(nextSummary);
    setFiles(Array.isArray(nextFiles) ? nextFiles : []);
    setWallet(nextWallet);
  };

  useEffect(() => {
    void runBusy(async () => {
      await bridge.invoke("p2p:start");
      await refreshAll();
    });
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const connectWallet = async () => {
    if (walletConnecting) return;
    setWalletConnecting(true);
    try {
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Wallet connection cancelled or timed out.")), 30000));
      const result = await Promise.race([connectWalletWithWalletConnect(), timeout]);
      const nextWallet = await bridge.invoke<WalletState>("wallet:connect", {
        address: result.address,
        loginMessage: result.loginMessage,
        signature: result.signature,
      });
      setWallet(nextWallet);
      toast.success("Wallet connected");
      await refreshAll();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setWalletConnecting(false);
    }
  };

  const disconnectWallet = () => runBusy(async () => {
    const nextWallet = await bridge.invoke<WalletState>("wallet:disconnect");
    setWallet(nextWallet);
    setFiles([]);
    setCurrentPath("");
    toast.success("Wallet disconnected");
  });

  const createFolder = () => runBusy(async () => {
    if (!walletConnected) throw new Error("Connect wallet before creating folders");
    const password = requireDrivePassword();
    const raw = window.prompt("Folder name");
    const folderName = sanitizeFolderName(raw || "");
    if (!folderName) return;
    const folderPath = joinPath(currentPath, folderName);
    if (folderPaths.includes(folderPath)) throw new Error("Folder already exists");
    await bridge.invoke("p2p:upload", {
      name: joinPath(folderPath, FOLDER_MARKER),
      mimeType: FOLDER_MIME,
      isEncrypted: true,
      drivePassword: password,
      bytes: new TextEncoder().encode(`folder:${folderPath}`).buffer,
    });
    toast.success(`Folder created: ${folderName}`);
    await refreshAll();
  });

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => setSelectedFiles(Array.from(event.target.files || []));

  const uploadFiles = () => runBusy(async () => {
    if (!walletConnected) throw new Error("Connect wallet before uploading");
    const password = requireDrivePassword();
    if (uploadWouldExceedQuota) throw new Error("Storage quota exceeded. Upgrade your plan.");
    if (!selectedFiles.length) throw new Error("Select at least one file");
    for (const file of selectedFiles) {
      await bridge.invoke("p2p:upload", {
        name: joinPath(currentPath, file.name),
        mimeType: file.type || "application/octet-stream",
        isEncrypted: true,
        drivePassword: password,
        bytes: await file.arrayBuffer(),
      });
    }
    setSelectedFiles([]);
    toast.success(`Uploaded ${selectedFiles.length} file(s) to ${currentPath || "My Drive"}`);
    await refreshAll();
  });

  const downloadFile = (file: P2PFile) => runBusy(async () => {
    const payload = file.isEncrypted ? { hash: file.hash, drivePassword: requireDrivePassword() } : { hash: file.hash };
    const result = await bridge.invoke<DownloadResult>("p2p:download", payload);
    const blob = new Blob([new Uint8Array(result.bytes)], { type: result.file.mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = baseName(result.file.name);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast.success("Download ready");
  });

  const openPreview = (file: P2PFile) => runBusy(async () => {
    if (!isImageFile(file)) {
      await downloadFile(file);
      return;
    }
    const payload = file.isEncrypted ? { hash: file.hash, drivePassword: requireDrivePassword() } : { hash: file.hash };
    const result = await bridge.invoke<DownloadResult>("p2p:download", payload);
    const blob = new Blob([new Uint8Array(result.bytes)], { type: result.file.mimeType || "image/*" });
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(blob));
    setPreviewFile(file);
  });

  const deleteFile = (file: P2PFile) => runBusy(async () => {
    const ok = window.confirm(`Delete ${baseName(file.name)}?`);
    if (!ok) return;
    await bridge.invoke("p2p:delete", { hash: file.hash });
    toast.success("File deleted");
    await refreshAll();
  });

  const deleteFolder = (folderPath: string) => runBusy(async () => {
    const descendants = files.filter((file) => cleanPath(file.name).startsWith(`${folderPath}/`));
    if (!descendants.length) return;
    const ok = window.confirm(`Delete folder ${baseName(folderPath)} and ${descendants.length} item(s)?`);
    if (!ok) return;
    for (const file of descendants) await bridge.invoke("p2p:delete", { hash: file.hash });
    toast.success("Folder deleted");
    if (currentPath.startsWith(folderPath)) setCurrentPath(dirname(folderPath));
    await refreshAll();
  });

  const goToCrumb = (index: number) => {
    if (index < 0) setCurrentPath("");
    else setCurrentPath(currentCrumbs.slice(0, index + 1).join("/"));
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50">
      <header className="border-b border-zinc-800 bg-zinc-950">
        <div className="container flex flex-col gap-4 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">P2P Drive</h1>
            <p className="mt-1 break-all text-sm text-zinc-400">{summary ? `${summary.peerId} · ${summary.listenUrl}` : "Starting native P2P node"}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={walletConnected ? "default" : "destructive"} className="px-3 py-2">
              {walletConnected ? <UnlockKeyhole className="mr-1 size-4" /> : <Lock className="mr-1 size-4" />}
              {walletConnected ? shortAddress(wallet?.address) : "Upload locked"}
            </Badge>
            {walletConnected ? (
              <Button variant="outline" onClick={disconnectWallet} disabled={busy}>Disconnect</Button>
            ) : (
              <Button onClick={() => void connectWallet()} disabled={walletConnecting}><Wallet className="size-4" />{walletConnecting ? "Connecting..." : "Connect Wallet"}</Button>
            )}
            <Button variant="outline" onClick={() => void runBusy(refreshAll)} disabled={busy}><RefreshCw className="size-4" />Refresh</Button>
            <Button variant="outline" onClick={() => void runBusy(async () => { await bridge.invoke("p2p:bootstrapNow"); await refreshAll(); })} disabled={busy}><Link2 className="size-4" />Bootstrap</Button>
            <Button variant="outline" onClick={() => void runBusy(async () => { await bridge.invoke("p2p:repair"); await refreshAll(); })} disabled={busy}><ShieldCheck className="size-4" />Repair</Button>
          </div>
        </div>
      </header>

      <main className="container space-y-6 py-6">
        <section className="grid gap-3 md:grid-cols-5">
          <Card className="rounded-md border-zinc-800 bg-zinc-900"><CardContent className="pt-6"><p className="text-sm text-zinc-400">Plan</p><p className="text-2xl font-semibold">{wallet?.plan?.name || "Free"}</p></CardContent></Card>
          <Card className="rounded-md border-zinc-800 bg-zinc-900"><CardContent className="pt-6"><p className="text-sm text-zinc-400">Used</p><p className="text-2xl font-semibold">{formatBytes(wallet?.usedBytes ?? 0)}</p></CardContent></Card>
          <Card className="rounded-md border-zinc-800 bg-zinc-900"><CardContent className="pt-6"><p className="text-sm text-zinc-400">Drive files</p><p className="text-2xl font-semibold">{realFiles.length}</p></CardContent></Card>
          <Card className="rounded-md border-zinc-800 bg-zinc-900"><CardContent className="pt-6"><p className="text-sm text-zinc-400">Folders</p><p className="text-2xl font-semibold">{folderPaths.length}</p></CardContent></Card>
          <Card className="rounded-md border-zinc-800 bg-zinc-900"><CardContent className="pt-6"><p className="text-sm text-zinc-400">Peers</p><p className="text-2xl font-semibold">{summary?.connectedPeers ?? 0}</p></CardContent></Card>
        </section>

        <Card className="rounded-md border-zinc-800 bg-zinc-900">
          <CardHeader className="space-y-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2"><Folder className="size-5" />My Drive</CardTitle>
                <div className="mt-3 flex flex-wrap items-center gap-1 text-sm text-zinc-400">
                  <button onClick={() => goToCrumb(-1)} className="flex items-center gap-1 rounded px-2 py-1 hover:bg-zinc-800 hover:text-zinc-50"><Home className="size-4" />My Drive</button>
                  {currentCrumbs.map((part, index) => <span key={`${part}-${index}`} className="flex items-center gap-1"><ChevronRight className="size-4" /><button onClick={() => goToCrumb(index)} className="rounded px-2 py-1 hover:bg-zinc-800 hover:text-zinc-50">{part}</button></span>)}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setViewMode(viewMode === "grid" ? "list" : "grid")}><Grid3X3 className="size-4" />{viewMode === "grid" ? "Grid" : "List"}</Button>
                {currentPath && <Button variant="outline" onClick={() => setCurrentPath(dirname(currentPath))}><ArrowLeft className="size-4" />Back</Button>}
                <Button onClick={createFolder} disabled={busy || !walletConnected}><FolderPlus className="size-4" />New Folder</Button>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
              <div className="relative">
                <Search className="absolute left-3 top-2.5 size-4 text-zinc-500" />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search current folder" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Input type="password" value={drivePassword} onChange={(event) => setDrivePassword(event.target.value)} placeholder="Drive Password" disabled={!walletConnected || busy} className="max-w-xs" />
                <Input type="file" multiple onChange={handleFileSelect} disabled={!walletConnected || busy} className="max-w-xs" />
                <Button onClick={uploadFiles} disabled={busy || !walletConnected || selectedFiles.length === 0 || uploadWouldExceedQuota}><Upload className="size-4" />Upload here</Button>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-zinc-400"><span>Storage usage</span><span>{formatBytes(wallet?.usedBytes ?? 0)} / {formatBytes(wallet?.plan?.quotaBytes ?? 0)}</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-zinc-50" style={{ width: `${quotaPercent}%` }} /></div>
              <p className="text-xs text-zinc-500">Selected: {selectedFiles.length} file(s), {formatBytes(selectedBytes)} · Images in this folder: {imageCount}</p>
              {walletConnected && drivePassword.trim().length > 0 && drivePassword.trim().length < 6 && <p className="rounded border border-red-900 bg-red-950/40 p-2 text-sm text-red-200">Drive Password must be at least 6 characters.</p>}
              {uploadWouldExceedQuota && <p className="rounded border border-red-900 bg-red-950/40 p-2 text-sm text-red-200">Selected files exceed your plan. Upgrade before upload.</p>}
            </div>
          </CardHeader>

          <CardContent className="space-y-5">
            {!walletConnected && <div className="rounded-md border border-red-900 bg-red-950/40 p-4 text-sm text-red-200">Connect your wallet to load your private P2P Drive and upload files.</div>}

            {childFolders.length > 0 && <div className={viewMode === "grid" ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5" : "space-y-2"}>
              {childFolders.map((folder) => (
                <Card key={folder.path} className="group cursor-pointer rounded-md border-zinc-800 bg-zinc-950 transition hover:border-zinc-600" onDoubleClick={() => setCurrentPath(folder.path)}>
                  <CardContent className={viewMode === "grid" ? "p-4" : "flex items-center justify-between gap-3 p-3"}>
                    <button onClick={() => setCurrentPath(folder.path)} className={viewMode === "grid" ? "block w-full text-left" : "flex min-w-0 flex-1 items-center gap-3 text-left"}>
                      <Folder className={viewMode === "grid" ? "mb-3 size-10 text-yellow-300" : "size-6 shrink-0 text-yellow-300"} />
                      <div className="min-w-0"><p className="truncate font-medium">{folder.name}</p><p className="text-xs text-zinc-500">Folder</p></div>
                    </button>
                    <Button variant="ghost" size="sm" onClick={() => deleteFolder(folder.path)} disabled={busy}><Trash2 className="size-4" /></Button>
                  </CardContent>
                </Card>
              ))}
            </div>}

            {currentFiles.length > 0 && <div className={viewMode === "grid" ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5" : "space-y-2"}>
              {currentFiles.map((file) => (
                <Card key={file.hash} className="group rounded-md border-zinc-800 bg-zinc-950 transition hover:border-zinc-600">
                  <CardContent className={viewMode === "grid" ? "p-4" : "flex items-center justify-between gap-3 p-3"}>
                    <button onClick={() => openPreview(file)} className={viewMode === "grid" ? "block w-full text-left" : "flex min-w-0 flex-1 items-center gap-3 text-left"}>
                      <div className={viewMode === "grid" ? "mb-3 flex h-28 items-center justify-center rounded-md bg-zinc-900" : "flex size-10 shrink-0 items-center justify-center rounded-md bg-zinc-900"}>
                        {isImageFile(file) ? <ImageIcon className="size-9 text-emerald-300" /> : <FileText className="size-9 text-cyan-300" />}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{baseName(file.name)}</p>
                        <p className="text-xs text-zinc-500">{formatBytes(file.size)} · {formatDate(file.uploadedAt)}</p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {file.isEncrypted && <Badge variant="secondary">Private</Badge>}
                          {isImageFile(file) && <Badge variant="outline">Image</Badge>}
                        </div>
                      </div>
                    </button>
                    <div className={viewMode === "grid" ? "mt-3 flex gap-2" : "flex gap-2"}>
                      <Button variant="outline" size="sm" onClick={() => downloadFile(file)} disabled={busy}><Download className="size-4" /></Button>
                      <Button variant="destructive" size="sm" onClick={() => deleteFile(file)} disabled={busy}><Trash2 className="size-4" /></Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>}

            {childFolders.length === 0 && currentFiles.length === 0 && <div className="rounded-md border border-dashed border-zinc-800 py-16 text-center">
              <Folder className="mx-auto mb-3 size-12 text-zinc-600" />
              <p className="font-medium">This folder is empty</p>
              <p className="mt-1 text-sm text-zinc-500">Create a folder or upload images/files here.</p>
            </div>}
          </CardContent>
        </Card>
      </main>

      {previewFile && previewUrl && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setPreviewFile(null)}>
        <div className="max-h-[92vh] w-full max-w-5xl rounded-md border border-zinc-800 bg-zinc-950 p-4" onClick={(event) => event.stopPropagation()}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0"><p className="truncate font-medium">{baseName(previewFile.name)}</p><p className="text-xs text-zinc-500">{formatBytes(previewFile.size)}</p></div>
            <div className="flex gap-2"><Button variant="outline" onClick={() => downloadFile(previewFile)}><Download className="size-4" />Download</Button><Button variant="outline" onClick={() => setPreviewFile(null)}>Close</Button></div>
          </div>
          <div className="flex max-h-[78vh] items-center justify-center overflow-auto rounded bg-zinc-900"><img src={previewUrl} alt={baseName(previewFile.name)} className="max-h-[78vh] max-w-full object-contain" /></div>
        </div>
      </div>}
    </div>
  );
}
