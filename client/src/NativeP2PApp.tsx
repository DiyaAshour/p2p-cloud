import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity, Download, FileCheck2, Link2, RefreshCw, Search, ShieldCheck, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

type P2PChannel =
  | "p2p:start"
  | "p2p:listFiles"
  | "p2p:upload"
  | "p2p:download"
  | "p2p:delete"
  | "p2p:networkSummary"
  | "p2p:bootstrapNow"
  | "p2p:connectPeer"
  | "p2p:repair"
  | "p2p:prepareProof";

type ElectronBridge = {
  invoke: <T>(channel: P2PChannel, payload?: unknown) => Promise<T>;
};

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
  replicas: string[];
};

type P2PPeer = {
  peerId: string;
  url?: string;
  status?: string;
  lastSeen?: string | number;
};

type P2PSummary = {
  ok: boolean;
  peerId: string;
  port: number;
  host: string;
  listenUrl: string;
  peers: P2PPeer[];
  connectedPeers: number;
  targetReplicas: number;
  totalFiles: number;
  encryptedFiles: number;
  publicFiles: number;
  totalBytes: number;
  totalChunks: number;
  underReplicatedChunks: number;
};

type DownloadResult = {
  ok: boolean;
  file: P2PFile;
  bytes: number[];
};

type RepairResult = {
  report: Array<{
    file: string;
    chunkIndex: number;
    healthyReplicas: string[];
    targetReplicas: number;
    underReplicated: boolean;
  }>;
};

declare global {
  interface Window {
    electron?: ElectronBridge;
  }
}

function electron(): ElectronBridge {
  if (!window.electron?.invoke) {
    throw new Error("Electron required. No browser mode allowed.");
  }
  return window.electron;
}

function formatBytes(bytes = 0) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

function formatDate(value?: string | number) {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Operation failed";
}

export default function NativeP2PApp() {
  const bridge = electron();
  const [summary, setSummary] = useState<P2PSummary | null>(null);
  const [files, setFiles] = useState<P2PFile[]>([]);
  const [repairReport, setRepairReport] = useState<RepairResult["report"]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isEncrypted, setIsEncrypted] = useState(false);
  const [peerId, setPeerId] = useState("");
  const [peerUrl, setPeerUrl] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);

  const visibleFiles = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return files;
    return files.filter((file) => [file.name, file.hash, file.rootHash].some((value) => value.toLowerCase().includes(query)));
  }, [files, search]);

  const refreshAll = async () => {
    const [nextSummary, nextFiles] = await Promise.all([
      bridge.invoke<P2PSummary>("p2p:networkSummary"),
      bridge.invoke<P2PFile[]>("p2p:listFiles", { query: search }),
    ]);
    setSummary(nextSummary);
    setFiles(Array.isArray(nextFiles) ? nextFiles : []);
  };

  const runBusy = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void runBusy(async () => {
      await bridge.invoke("p2p:start");
      await refreshAll();
    });
  }, []);

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    setSelectedFiles(Array.from(event.target.files || []));
  };

  const uploadFiles = () =>
    runBusy(async () => {
      if (!selectedFiles.length) throw new Error("Select at least one file");

      for (const file of selectedFiles) {
        await bridge.invoke("p2p:upload", {
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          isEncrypted,
          bytes: await file.arrayBuffer(),
        });
      }

      setSelectedFiles([]);
      toast.success("Stored through Electron P2P");
      await refreshAll();
    });

  const downloadFile = (file: P2PFile) =>
    runBusy(async () => {
      const result = await bridge.invoke<DownloadResult>("p2p:download", { hash: file.hash });
      const blob = new Blob([new Uint8Array(result.bytes)], { type: result.file.mimeType || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.file.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success("Download verified");
    });

  const deleteFile = (file: P2PFile) =>
    runBusy(async () => {
      await bridge.invoke("p2p:delete", { hash: file.hash });
      toast.success("File removed");
      await refreshAll();
    });

  const connectPeer = () =>
    runBusy(async () => {
      await bridge.invoke("p2p:connectPeer", { peerId, url: peerUrl });
      setPeerId("");
      setPeerUrl("");
      toast.success("Peer connection started");
      await refreshAll();
    });

  const repair = () =>
    runBusy(async () => {
      const result = await bridge.invoke<RepairResult>("p2p:repair");
      setRepairReport(Array.isArray(result.report) ? result.report : []);
      await refreshAll();
    });

  const prepareProof = (file: P2PFile) =>
    runBusy(async () => {
      const result = await bridge.invoke<{ proof: { rootHash: string; leaf: string } }>("p2p:prepareProof", { hash: file.hash });
      await navigator.clipboard.writeText(JSON.stringify(result.proof));
      toast.success("Proof copied");
    });

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50">
      <header className="border-b border-zinc-800 bg-zinc-950">
        <div className="container flex flex-col gap-4 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Native P2P Cloud</h1>
            <p className="mt-1 break-all text-sm text-zinc-400">{summary ? `${summary.peerId} at ${summary.listenUrl}` : "Starting Electron P2P node"}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void runBusy(refreshAll)} disabled={busy}>
              <RefreshCw className="size-4" />
              Refresh
            </Button>
            <Button variant="outline" onClick={() => void runBusy(async () => { await bridge.invoke("p2p:bootstrapNow"); await refreshAll(); })} disabled={busy}>
              <Link2 className="size-4" />
              Bootstrap
            </Button>
            <Button onClick={repair} disabled={busy}>
              <ShieldCheck className="size-4" />
              Repair
            </Button>
          </div>
        </div>
      </header>

      <main className="container space-y-6 py-6">
        <section className="grid gap-3 md:grid-cols-4">
          <Card className="rounded-md border-zinc-800 bg-zinc-900">
            <CardContent className="pt-6">
              <p className="text-sm text-zinc-400">Files</p>
              <p className="text-3xl font-semibold">{summary?.totalFiles ?? 0}</p>
            </CardContent>
          </Card>
          <Card className="rounded-md border-zinc-800 bg-zinc-900">
            <CardContent className="pt-6">
              <p className="text-sm text-zinc-400">Storage</p>
              <p className="text-3xl font-semibold">{formatBytes(summary?.totalBytes ?? 0)}</p>
            </CardContent>
          </Card>
          <Card className="rounded-md border-zinc-800 bg-zinc-900">
            <CardContent className="pt-6">
              <p className="text-sm text-zinc-400">Peers</p>
              <p className="text-3xl font-semibold">{summary?.connectedPeers ?? 0}</p>
            </CardContent>
          </Card>
          <Card className="rounded-md border-zinc-800 bg-zinc-900">
            <CardContent className="pt-6">
              <p className="text-sm text-zinc-400">Under Replicated</p>
              <p className="text-3xl font-semibold">{summary?.underReplicatedChunks ?? 0}</p>
            </CardContent>
          </Card>
        </section>

        <Tabs defaultValue="files" className="space-y-5">
          <TabsList className="border border-zinc-800 bg-zinc-900">
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="upload">Upload</TabsTrigger>
            <TabsTrigger value="network">Network</TabsTrigger>
            <TabsTrigger value="repair">Repair</TabsTrigger>
          </TabsList>

          <TabsContent value="files" className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name, file hash, or root" />
              <Button variant="outline" onClick={() => void runBusy(refreshAll)} disabled={busy}>
                <Search className="size-4" />
                Search
              </Button>
            </div>

            <div className="grid gap-3">
              {visibleFiles.map((file) => (
                <Card key={file.hash} className="rounded-md border-zinc-800 bg-zinc-900">
                  <CardContent className="grid gap-4 pt-6 lg:grid-cols-[1fr_auto] lg:items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <FileCheck2 className="size-4 text-emerald-300" />
                        <h2 className="truncate text-base font-semibold">{file.name}</h2>
                        {file.isEncrypted && <Badge variant="secondary">Private</Badge>}
                      </div>
                      <p className="mt-2 break-all text-xs text-zinc-500">file {file.hash}</p>
                      <p className="mt-1 break-all text-xs text-cyan-300">root {file.rootHash}</p>
                      <p className="mt-1 text-sm text-zinc-400">
                        {formatBytes(file.size)} · {file.totalChunks} chunk(s) · {formatDate(file.uploadedAt)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={() => prepareProof(file)} disabled={busy}>
                        <ShieldCheck className="size-4" />
                        Proof
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => downloadFile(file)} disabled={busy}>
                        <Download className="size-4" />
                        Download
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => deleteFile(file)} disabled={busy}>
                        <Trash2 className="size-4" />
                        Delete
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}

              {visibleFiles.length === 0 && (
                <Card className="rounded-md border-zinc-800 bg-zinc-900">
                  <CardContent className="py-10 text-center text-sm text-zinc-400">No files stored on this node.</CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="upload">
            <Card className="rounded-md border-zinc-800 bg-zinc-900">
              <CardHeader>
                <CardTitle>Store Files</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input type="file" multiple onChange={handleFileSelect} />
                <div className="flex items-center gap-2">
                  <Checkbox id="private-file" checked={isEncrypted} onCheckedChange={(value) => setIsEncrypted(Boolean(value))} />
                  <Label htmlFor="private-file">Mark as private</Label>
                </div>
                <Button onClick={uploadFiles} disabled={busy || selectedFiles.length === 0}>
                  <Upload className="size-4" />
                  Upload {selectedFiles.length > 0 ? selectedFiles.length : ""}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="network">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
              <Card className="rounded-md border-zinc-800 bg-zinc-900">
                <CardHeader>
                  <CardTitle>Peers</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(summary?.peers || []).map((peer) => (
                    <div key={peer.peerId} className="rounded-md border border-zinc-800 p-3">
                      <p className="break-all text-sm font-medium">{peer.peerId}</p>
                      <p className="break-all text-xs text-zinc-400">{peer.url || "Direct socket"}</p>
                      <Badge className="mt-2" variant={peer.status === "connected" ? "default" : "secondary"}>
                        {peer.status || "known"}
                      </Badge>
                    </div>
                  ))}
                  {(summary?.peers || []).length === 0 && <p className="text-sm text-zinc-400">No peers connected.</p>}
                </CardContent>
              </Card>

              <Card className="rounded-md border-zinc-800 bg-zinc-900">
                <CardHeader>
                  <CardTitle>Connect Peer</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Input value={peerId} onChange={(event) => setPeerId(event.target.value)} placeholder="Peer id" />
                  <Input value={peerUrl} onChange={(event) => setPeerUrl(event.target.value)} placeholder="ws://127.0.0.1:8788" />
                  <Button onClick={connectPeer} disabled={busy || !peerId || !peerUrl}>
                    <Link2 className="size-4" />
                    Connect
                  </Button>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="repair">
            <Card className="rounded-md border-zinc-800 bg-zinc-900">
              <CardHeader>
                <CardTitle>Replica Health</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button onClick={repair} disabled={busy}>
                  <Activity className="size-4" />
                  Scan
                </Button>
                {repairReport.map((item) => (
                  <div key={`${item.file}-${item.chunkIndex}`} className="rounded-md border border-zinc-800 p-3">
                    <p className="text-sm font-medium">{item.file} chunk #{item.chunkIndex}</p>
                    <p className="text-xs text-zinc-400">
                      {item.healthyReplicas.length}/{item.targetReplicas} replicas
                    </p>
                  </div>
                ))}
                {repairReport.length === 0 && <p className="text-sm text-zinc-400">No scan results yet.</p>}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
