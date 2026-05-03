import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWallet } from '@/hooks/useWallet';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Database,
  Download,
  HardDrive,
  Lock,
  Network,
  RadioTower,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  Wallet,
  Wifi,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';

type P2PChunkInfo = {
  index: number;
  hash: string;
  size?: number;
  replicas?: string[];
  proof?: string[];
};

type P2PFileMetadata = {
  name: string;
  size: number;
  hash: string;
  rootHash?: string;
  uploadedAt: string | number;
  isEncrypted: boolean;
  mimeType?: string;
  totalChunks?: number;
  ownerWallet?: string;
  chunks?: P2PChunkInfo[];
};

type P2PPeerInfo = {
  peerId: string;
  url?: string;
  status?: string;
  lastSeen?: string | number;
};

type BootstrapState = {
  ok?: boolean;
  configured?: boolean;
  bootstrapUrl?: string;
  registeredAs?: string;
  discoveredPeers?: number;
  connected?: unknown[];
  failed?: unknown[];
  error?: string;
  message?: string;
  at?: string;
};

type P2PNetworkSummary = {
  ok: boolean;
  peerId: string;
  port: number;
  host: string;
  listenUrl?: string;
  peers: P2PPeerInfo[];
  connectedPeers: number;
  connectedPeerIds?: string[];
  targetReplicas: number;
  files: number;
  totalFiles: number;
  encryptedFiles: number;
  publicFiles: number;
  totalBytes: number;
  totalMB: number;
  totalChunks: number;
  underReplicatedChunks: number;
  queuedProofs: number;
  freeQuotaBytes: number;
  freeQuotaRemainingBytes: number;
  bootstrapUrl?: string | null;
  bootstrap?: BootstrapState | null;
  readyForRealUpload: boolean;
};

type ProofQueueItem = {
  dealId: number;
  chunkIndex: number;
  rootHash: string;
  leaf: string;
  merkleProof: string[];
  status?: string;
  createdAt?: string;
};

type RepairItem = {
  file: string;
  rootHash: string;
  chunkIndex: number;
  chunkHash: string;
  healthyReplicas: string[];
  targetReplicas: number;
  underReplicated: boolean;
};

declare global {
  interface Window {
    electron?: {
      invoke?: (channel: string, ...args: any[]) => Promise<any>;
      ipcRenderer?: {
        invoke: (channel: string, ...args: any[]) => Promise<any>;
      };
    };
  }
}

function electronInvoke<T = any>(channel: string, ...args: any[]): Promise<T> {
  const bridge = window.electron?.ipcRenderer || window.electron;
  if (!bridge?.invoke) {
    throw new Error('Native P2P engine is unavailable. Start the app with pnpm electron:dev. Browser-only mode is intentionally blocked.');
  }
  return bridge.invoke(channel, ...args) as Promise<T>;
}

function formatBytes(bytes = 0) {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

function formatDate(value?: string | number) {
  if (!value) return 'unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error';
}

function shortHash(value?: string, start = 10, end = 8) {
  if (!value) return 'unknown';
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function StatusPill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${ok ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-amber-400/30 bg-amber-400/10 text-amber-200'}`}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
      {children}
    </span>
  );
}

function StatCard({ label, value, icon: Icon, note }: { label: string; value: string | number; icon: any; note?: string }) {
  return (
    <Card className="rounded-2xl border-white/10 bg-white/[0.04] p-5 shadow-none">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-slate-400">{label}</p>
          <p className="mt-2 text-3xl font-bold text-white">{value}</p>
          {note && <p className="mt-2 text-xs text-slate-500">{note}</p>}
        </div>
        <div className="rounded-2xl bg-cyan-400/10 p-3 text-cyan-200">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </Card>
  );
}

export default function NativeP2PApp() {
  const wallet = useWallet();
  const [summary, setSummary] = useState<P2PNetworkSummary | null>(null);
  const [files, setFiles] = useState<P2PFileMetadata[]>([]);
  const [proofQueue, setProofQueue] = useState<ProofQueueItem[]>([]);
  const [repairReport, setRepairReport] = useState<RepairItem[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isEncrypted, setIsEncrypted] = useState(true);
  const [peerId, setPeerId] = useState('');
  const [peerUrl, setPeerUrl] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const peers = summary?.peers || [];
  const connectedPeers = summary?.connectedPeers || 0;
  const ready = Boolean(summary?.readyForRealUpload && wallet.isConnected);
  const quotaUsed = summary?.totalBytes || 0;
  const quotaTotal = summary?.freeQuotaBytes || 5 * 1024 * 1024 * 1024;
  const quotaPercent = Math.min(100, Math.round((quotaUsed / Math.max(1, quotaTotal)) * 100));

  const visibleFiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return files;
    return files.filter((file) => [file.name, file.hash, file.rootHash, file.ownerWallet].some((item) => String(item || '').toLowerCase().includes(q)));
  }, [files, search]);

  async function refreshAll() {
    setBusy(true);
    setLastError(null);
    try {
      const nextSummary = await electronInvoke<P2PNetworkSummary>('p2p:start');
      const [fileList, queue] = await Promise.all([
        electronInvoke<P2PFileMetadata[]>('p2p:listFiles'),
        electronInvoke<ProofQueueItem[]>('p2p:proofQueue').catch(() => []),
      ]);
      setSummary(nextSummary);
      setFiles(Array.isArray(fileList) ? fileList : []);
      setProofQueue(Array.isArray(queue) ? queue : []);
    } catch (error) {
      const message = errorMessage(error);
      setLastError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refreshAll();
    const id = window.setInterval(() => {
      electronInvoke<P2PNetworkSummary>('p2p:networkSummary')
        .then(setSummary)
        .catch((error) => setLastError(errorMessage(error)));
    }, 5000);
    return () => window.clearInterval(id);
  }, []);

  async function copyText(value?: string) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    toast.success('Copied');
  }

  async function bootstrapNow() {
    setBusy(true);
    try {
      const result = await electronInvoke<BootstrapState>('p2p:bootstrapNow');
      toast[result.ok ? 'success' : 'warning'](result.ok ? 'Bootstrap discovery completed' : result.message || result.error || 'Bootstrap not configured');
      await refreshAll();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function connectPeer() {
    if (!peerId.trim() || !peerUrl.trim()) {
      toast.error('Peer ID and ws:// URL are required');
      return;
    }
    setBusy(true);
    try {
      await electronInvoke('p2p:connectPeer', { peerId: peerId.trim(), url: peerUrl.trim() });
      toast.success('Peer connection started');
      setPeerId('');
      setPeerUrl('');
      await refreshAll();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function uploadFiles() {
    if (!wallet.isConnected || !wallet.address) {
      toast.error('Connect wallet before uploading. This is enforced by the native P2P engine.');
      return;
    }
    if (!summary?.readyForRealUpload) {
      toast.error('No live peers. Bootstrap or connect a peer before upload.');
      return;
    }
    if (!selectedFiles.length) {
      toast.error('Select at least one file');
      return;
    }

    setBusy(true);
    try {
      for (const file of selectedFiles) {
        const buffer = await file.arrayBuffer();
        await electronInvoke('p2p:upload', {
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          isEncrypted,
          walletAddress: wallet.address,
          bytes: Array.from(new Uint8Array(buffer)),
        });
      }
      toast.success(`${selectedFiles.length} file(s) committed to the P2P network`);
      setSelectedFiles([]);
      await refreshAll();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function downloadFile(file: P2PFileMetadata) {
    setBusy(true);
    try {
      const result = await electronInvoke<{ bytes: number[]; file: P2PFileMetadata }>('p2p:download', { rootHash: file.rootHash, hash: file.hash });
      if (!result?.bytes?.length) throw new Error('No bytes returned from the P2P network');
      const blob = new Blob([new Uint8Array(result.bytes)], { type: file.mimeType || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Downloaded from P2P replicas');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function deleteFile(file: P2PFileMetadata) {
    setBusy(true);
    try {
      await electronInvoke('p2p:delete', { rootHash: file.rootHash, hash: file.hash });
      toast.success('Local manifest removed');
      await refreshAll();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function runRepair() {
    setBusy(true);
    try {
      const result = await electronInvoke<{ report: RepairItem[] }>('p2p:repair');
      setRepairReport(Array.isArray(result.report) ? result.report : []);
      toast.success('Replica health scan completed');
      await refreshAll();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function prepareProof() {
    const rootHash = prompt('Merkle root hash');
    if (!rootHash) return;
    const dealId = Number(prompt('Deal ID'));
    const challengeIndex = Number(prompt('Challenge chunk index'));
    if (!Number.isFinite(dealId) || !Number.isFinite(challengeIndex)) {
      toast.error('Invalid deal ID or challenge index');
      return;
    }
    try {
      await electronInvoke('p2p:prepareProof', { dealId, rootHash, challengeIndex });
      toast.success('Cryptographic proof payload prepared');
      await refreshAll();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="min-h-screen bg-[#030712] text-white">
      <div className="fixed inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.16),transparent_30%),radial-gradient(circle_at_top_right,rgba(16,185,129,0.12),transparent_30%)]" />

      <header className="border-b border-white/10 bg-black/30 backdrop-blur-xl">
        <div className="container flex flex-col gap-6 py-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill ok={Boolean(summary?.ok)}>Native Electron P2P</StatusPill>
              <StatusPill ok={connectedPeers > 0}>{connectedPeers > 0 ? `${connectedPeers} peer(s) online` : 'No live peers'}</StatusPill>
              <StatusPill ok={Boolean(wallet.isConnected)}>{wallet.isConnected ? 'Wallet connected' : 'Wallet required'}</StatusPill>
            </div>
            <div>
              <h1 className="text-4xl font-black tracking-tight md:text-6xl">P2P Cloud Control Center</h1>
              <p className="mt-3 max-w-3xl text-base leading-7 text-slate-300">
                Real network dashboard for encrypted chunk storage, bootstrap discovery, replica health, Merkle proofs, wallet-gated uploads, and native Electron IPC. No REST API fallback. No demo data.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            {wallet.isConnected ? (
              <Button onClick={wallet.disconnect} variant="outline" className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white">
                <Wallet className="h-4 w-4" /> {shortHash(wallet.address, 6, 4)}
              </Button>
            ) : (
              <Button onClick={wallet.connect} disabled={wallet.isLoading} className="bg-cyan-400 text-slate-950 hover:bg-cyan-300">
                <Wallet className="h-4 w-4" /> {wallet.isLoading ? 'Connecting...' : 'Connect Wallet'}
              </Button>
            )}
            <Button onClick={bootstrapNow} disabled={busy} variant="outline" className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white">
              <RadioTower className="h-4 w-4" /> Bootstrap Now
            </Button>
            <Button onClick={refreshAll} disabled={busy} className="bg-white text-slate-950 hover:bg-slate-200">
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
          </div>
        </div>
      </header>

      <main className="container space-y-8 py-8">
        {lastError && (
          <Card className="rounded-2xl border-red-400/30 bg-red-400/10 p-4 text-red-100 shadow-none">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5" />
              <div>
                <p className="font-semibold">Native engine error</p>
                <p className="mt-1 text-sm text-red-100/80">{lastError}</p>
              </div>
            </div>
          </Card>
        )}

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Connected Peers" value={connectedPeers} icon={Network} note={summary?.bootstrapUrl ? `Bootstrap: ${summary.bootstrapUrl}` : 'Bootstrap URL not configured'} />
          <StatCard label="Stored Files" value={summary?.totalFiles ?? files.length} icon={Database} note={`${summary?.totalChunks ?? 0} chunk(s)`} />
          <StatCard label="Used Storage" value={formatBytes(summary?.totalBytes || 0)} icon={HardDrive} note={`${quotaPercent}% of free 5GB quota`} />
          <StatCard label="Under Replicated" value={summary?.underReplicatedChunks ?? 0} icon={ShieldCheck} note={`Target: ${summary?.targetReplicas ?? 3} replicas`} />
        </section>

        <Card className="overflow-hidden rounded-2xl border-white/10 bg-white/[0.04] p-0 shadow-none">
          <div className="border-b border-white/10 p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-xl font-bold">Network truth panel</h2>
                <p className="mt-1 text-sm text-slate-400">These values come from Electron IPC and the live P2P engine.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => copyText(summary?.peerId)} className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white">
                  <Copy className="h-4 w-4" /> Copy Peer ID
                </Button>
                <Button size="sm" variant="outline" onClick={() => copyText(summary?.listenUrl)} className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white">
                  <Copy className="h-4 w-4" /> Copy Listen URL
                </Button>
              </div>
            </div>
          </div>
          <div className="grid gap-0 md:grid-cols-3">
            <div className="border-b border-white/10 p-5 md:border-b-0 md:border-r">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Peer ID</p>
              <p className="mt-2 break-all font-mono text-sm text-cyan-100">{summary?.peerId || 'starting...'}</p>
            </div>
            <div className="border-b border-white/10 p-5 md:border-b-0 md:border-r">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Listen URL</p>
              <p className="mt-2 break-all font-mono text-sm text-emerald-100">{summary?.listenUrl || 'unknown'}</p>
            </div>
            <div className="p-5">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Bootstrap</p>
              <p className="mt-2 text-sm text-slate-200">{summary?.bootstrap?.ok ? `Discovered ${summary.bootstrap.discoveredPeers || 0} peer(s)` : summary?.bootstrap?.message || summary?.bootstrap?.error || 'Waiting for bootstrap'}</p>
            </div>
          </div>
        </Card>

        <Tabs defaultValue="upload" className="space-y-5">
          <TabsList className="grid h-auto w-full grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-black/30 p-2 md:grid-cols-5">
            <TabsTrigger value="upload">Upload</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="network">Network</TabsTrigger>
            <TabsTrigger value="repair">Repair</TabsTrigger>
            <TabsTrigger value="proofs">Proofs</TabsTrigger>
          </TabsList>

          <TabsContent value="upload">
            <Card className="rounded-2xl border-white/10 bg-white/[0.04] p-6 shadow-none">
              <div className="grid gap-6 lg:grid-cols-[1fr_0.8fr]">
                <div className="space-y-5">
                  <div>
                    <h2 className="text-2xl font-bold">Commit files to the real P2P network</h2>
                    <p className="mt-2 text-sm text-slate-400">Upload is blocked unless wallet + live peer connection are both active.</p>
                  </div>

                  <input
                    type="file"
                    multiple
                    onChange={(event) => setSelectedFiles(Array.from(event.target.files || []))}
                    className="block w-full rounded-2xl border border-dashed border-white/20 bg-slate-950/70 p-6 text-sm text-slate-300 file:mr-4 file:rounded-xl file:border-0 file:bg-cyan-400 file:px-4 file:py-2 file:font-semibold file:text-slate-950 hover:file:bg-cyan-300"
                  />

                  <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/70 p-4">
                    <input id="encrypted" type="checkbox" checked={isEncrypted} onChange={(event) => setIsEncrypted(event.target.checked)} className="h-4 w-4" />
                    <label htmlFor="encrypted" className="text-sm text-slate-200">Mark manifest private/encrypted</label>
                  </div>

                  <Button onClick={uploadFiles} disabled={busy || !selectedFiles.length || !ready} className="h-12 w-full bg-cyan-400 text-slate-950 hover:bg-cyan-300 disabled:opacity-40">
                    <Upload className="h-5 w-5" /> Upload to P2P Network
                  </Button>
                </div>

                <div className="space-y-4">
                  <Card className="rounded-2xl border-white/10 bg-slate-950/70 p-5 shadow-none">
                    <h3 className="font-bold">Upload gates</h3>
                    <div className="mt-4 space-y-3 text-sm">
                      <div className="flex items-center justify-between"><span className="text-slate-400">Wallet</span><StatusPill ok={wallet.isConnected}>{wallet.isConnected ? 'ready' : 'missing'}</StatusPill></div>
                      <div className="flex items-center justify-between"><span className="text-slate-400">Live peers</span><StatusPill ok={connectedPeers > 0}>{connectedPeers}</StatusPill></div>
                      <div className="flex items-center justify-between"><span className="text-slate-400">Quota</span><span>{formatBytes(summary?.freeQuotaRemainingBytes || 0)} left</span></div>
                    </div>
                    <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full bg-cyan-300" style={{ width: `${quotaPercent}%` }} />
                    </div>
                  </Card>

                  <Card className="rounded-2xl border-white/10 bg-slate-950/70 p-5 shadow-none">
                    <h3 className="font-bold">Selected files</h3>
                    <div className="mt-4 max-h-48 space-y-2 overflow-auto text-sm text-slate-300">
                      {selectedFiles.length ? selectedFiles.map((file) => (
                        <div key={`${file.name}-${file.size}`} className="flex justify-between gap-3 rounded-xl bg-white/5 p-3">
                          <span className="truncate">{file.name}</span>
                          <span className="shrink-0 text-slate-500">{formatBytes(file.size)}</span>
                        </div>
                      )) : <p className="text-slate-500">No files selected.</p>}
                    </div>
                  </Card>
                </div>
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="files">
            <Card className="rounded-2xl border-white/10 bg-white/[0.04] p-6 shadow-none">
              <div className="mb-5 flex flex-col gap-3 md:flex-row">
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name, file hash, Merkle root, wallet..." className="border-white/10 bg-slate-950 text-white" />
                <Button onClick={refreshAll} disabled={busy} className="bg-white text-slate-950 hover:bg-slate-200"><RefreshCw className="h-4 w-4" /> Sync</Button>
              </div>

              <div className="space-y-3">
                {visibleFiles.length ? visibleFiles.map((file) => (
                  <div key={file.rootHash || file.hash} className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-lg font-bold">{file.name}</p>
                          {file.isEncrypted && <span className="inline-flex items-center gap-1 rounded-full bg-cyan-400/10 px-2 py-1 text-xs text-cyan-200"><Lock className="h-3 w-3" /> private</span>}
                        </div>
                        <p className="mt-1 text-sm text-slate-400">{formatBytes(file.size)} / {formatDate(file.uploadedAt)} / {file.chunks?.length || file.totalChunks || 0} chunk(s)</p>
                        <p className="mt-2 break-all font-mono text-xs text-slate-500">file: {file.hash}</p>
                        {file.rootHash && <p className="mt-1 break-all font-mono text-xs text-cyan-300">root: {file.rootHash}</p>}
                      </div>
                      <div className="flex gap-2">
                        <Button size="icon" variant="outline" onClick={() => downloadFile(file)} disabled={busy} className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white"><Download className="h-4 w-4" /></Button>
                        <Button size="icon" variant="outline" onClick={() => deleteFile(file)} disabled={busy} className="border-red-400/30 bg-red-400/10 text-red-200 hover:bg-red-400/20 hover:text-red-100"><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </div>
                  </div>
                )) : (
                  <div className="rounded-2xl border border-dashed border-white/10 py-14 text-center text-slate-500">No real P2P files stored on this node.</div>
                )}
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="network">
            <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
              <Card className="rounded-2xl border-white/10 bg-white/[0.04] p-6 shadow-none">
                <h2 className="text-xl font-bold">Manual peer connection</h2>
                <p className="mt-2 text-sm text-slate-400">Use this only when bootstrap discovery cannot see the peer.</p>
                <div className="mt-5 space-y-3">
                  <Input value={peerId} onChange={(event) => setPeerId(event.target.value)} placeholder="Remote peer ID" className="border-white/10 bg-slate-950 text-white" />
                  <Input value={peerUrl} onChange={(event) => setPeerUrl(event.target.value)} placeholder="ws://remote-ip:8787" className="border-white/10 bg-slate-950 text-white" />
                  <Button onClick={connectPeer} disabled={busy} className="w-full bg-emerald-400 text-slate-950 hover:bg-emerald-300"><Wifi className="h-4 w-4" /> Connect Peer</Button>
                </div>
              </Card>

              <Card className="rounded-2xl border-white/10 bg-white/[0.04] p-6 shadow-none">
                <h2 className="mb-5 text-xl font-bold">Live peers</h2>
                <div className="space-y-3">
                  {peers.length ? peers.map((peer) => (
                    <div key={peer.peerId} className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
                      <p className="break-all font-mono text-sm text-white">{peer.peerId}</p>
                      <p className="mt-1 break-all text-xs text-slate-400">{peer.url || 'direct socket'}</p>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs">
                        <StatusPill ok={peer.status !== 'disconnected'}>{peer.status || 'connected'}</StatusPill>
                        <span className="rounded-full bg-white/5 px-3 py-1 text-slate-400">last seen: {formatDate(peer.lastSeen)}</span>
                      </div>
                    </div>
                  )) : <div className="rounded-2xl border border-dashed border-white/10 py-12 text-center text-slate-500">No peers connected yet. Bootstrap should discover nodes automatically.</div>}
                </div>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="repair">
            <Card className="rounded-2xl border-white/10 bg-white/[0.04] p-6 shadow-none">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-xl font-bold">Replica repair and health</h2>
                  <p className="mt-2 text-sm text-slate-400">Scans every chunk and reports whether it has the target number of healthy replicas.</p>
                </div>
                <Button onClick={runRepair} disabled={busy} className="bg-emerald-400 text-slate-950 hover:bg-emerald-300"><Activity className="h-4 w-4" /> Run Health Scan</Button>
              </div>
              <div className="mt-6 space-y-3">
                {repairReport.length ? repairReport.map((item) => (
                  <div key={`${item.rootHash}-${item.chunkIndex}`} className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="font-semibold">{item.file} / chunk #{item.chunkIndex}</p>
                      <StatusPill ok={!item.underReplicated}>{item.healthyReplicas.length}/{item.targetReplicas} replicas</StatusPill>
                    </div>
                    <p className="mt-2 break-all font-mono text-xs text-slate-500">{item.chunkHash}</p>
                  </div>
                )) : <div className="rounded-2xl border border-dashed border-white/10 py-12 text-center text-slate-500">No scan results yet.</div>}
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="proofs">
            <Card className="rounded-2xl border-white/10 bg-white/[0.04] p-6 shadow-none">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-xl font-bold">Storage proofs</h2>
                  <p className="mt-2 text-sm text-slate-400">Prepare Merkle proof payloads for smart-contract challenge flows.</p>
                </div>
                <Button onClick={prepareProof} className="bg-cyan-400 text-slate-950 hover:bg-cyan-300"><Zap className="h-4 w-4" /> Prepare Proof</Button>
              </div>
              <div className="mt-6 space-y-3">
                {proofQueue.length ? proofQueue.map((proof, index) => (
                  <div key={`${proof.dealId}-${proof.chunkIndex}-${index}`} className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="font-semibold">Deal #{proof.dealId} / chunk #{proof.chunkIndex}</p>
                      <StatusPill ok>{proof.status || 'ready'}</StatusPill>
                    </div>
                    <p className="mt-2 break-all font-mono text-xs text-cyan-300">leaf: {proof.leaf}</p>
                    <p className="mt-1 break-all font-mono text-xs text-slate-500">root: {proof.rootHash}</p>
                    <p className="mt-2 text-xs text-slate-400">Proof nodes: {proof.merkleProof?.length || 0} / created: {formatDate(proof.createdAt)}</p>
                  </div>
                )) : <div className="rounded-2xl border border-dashed border-white/10 py-12 text-center text-slate-500">No prepared proofs.</div>}
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
