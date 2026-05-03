import { useState, useEffect } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Upload, Download, Trash2, Search, Wallet, LogOut, RefreshCw, Home, Network, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

type P2PChunkInfo = {
  index: number;
  hash: string;
  size?: number;
  replicas?: string[];
  proof?: string[];
};

type P2PFileMetadata = {
  id?: string;
  name: string;
  size: number;
  hash: string;
  rootHash?: string;
  uploadedAt: string | number;
  isEncrypted: boolean;
  mimeType?: string;
  totalChunks?: number;
  chunks?: P2PChunkInfo[];
};

type P2PPeerInfo = {
  peerId: string;
  url?: string;
  status?: string;
  lastSeen?: string | number;
};

type P2PStats = {
  totalFiles: number;
  encryptedFiles: number;
  publicFiles: number;
  totalBytes: number;
  totalMB: number;
  totalChunks?: number;
  underReplicatedChunks?: number;
  targetReplicas?: number;
  connectedPeers?: number;
  queuedProofs?: number;
};

type P2PStatus = {
  ok: boolean;
  peerId: string;
  port: number;
  host: string;
  peers: P2PPeerInfo[];
  targetReplicas?: number;
  files?: number;
  queuedProofs?: number;
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

function electronInvoke(channel: string, ...args: any[]) {
  const bridge = window.electron?.ipcRenderer || window.electron;
  if (!bridge?.invoke) {
    throw new Error('Electron P2P engine is not available. Run pnpm electron:dev, not the browser-only Vite tab.');
  }
  return bridge.invoke(channel, ...args);
}

function formatBytes(bytes = 0) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

function formatDate(value?: string | number) {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error';
}

export default function Dashboard() {
  const wallet = useWallet();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isEncrypted, setIsEncrypted] = useState(true);
  const [files, setFiles] = useState<P2PFileMetadata[]>([]);
  const [peers, setPeers] = useState<P2PPeerInfo[]>([]);
  const [stats, setStats] = useState<P2PStats | null>(null);
  const [status, setStatus] = useState<P2PStatus | null>(null);
  const [proofQueue, setProofQueue] = useState<ProofQueueItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    refreshAll();
  }, []);

  const loadFiles = async () => {
    const fileList = await electronInvoke('p2p:listFiles') as P2PFileMetadata[];
    setFiles(Array.isArray(fileList) ? fileList : []);
    return Array.isArray(fileList) ? fileList : [];
  };

  const loadStatus = async () => {
    const nextStatus = await electronInvoke('p2p:status') as P2PStatus;
    setStatus(nextStatus);
    setPeers(Array.isArray(nextStatus.peers) ? nextStatus.peers : []);
    return nextStatus;
  };

  const loadStats = async () => {
    const nextStats = await electronInvoke('p2p:stats') as P2PStats;
    setStats(nextStats);
    return nextStats;
  };

  const loadProofQueue = async () => {
    try {
      const queue = await electronInvoke('p2p:proofQueue') as ProofQueueItem[];
      setProofQueue(Array.isArray(queue) ? queue : []);
      return Array.isArray(queue) ? queue : [];
    } catch {
      setProofQueue([]);
      return [];
    }
  };

  const refreshAll = async () => {
    setIsLoading(true);
    try {
      await electronInvoke('p2p:start');
      await Promise.all([loadFiles(), loadStatus(), loadStats(), loadProofQueue()]);
    } catch (error) {
      console.error('Refresh failed:', error);
      toast.error('P2P engine failed: ' + errorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const visibleFiles = files.filter((file) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return file.name.toLowerCase().includes(q) || file.hash.toLowerCase().includes(q) || file.rootHash?.toLowerCase().includes(q);
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) setSelectedFiles(Array.from(e.target.files));
  };

  const handleUpload = async () => {
    if (selectedFiles.length === 0) {
      toast.error('Please select files to upload');
      return;
    }

    setIsLoading(true);
    try {
      for (const file of selectedFiles) {
        const buffer = await file.arrayBuffer();
        await electronInvoke('p2p:upload', {
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          isEncrypted,
          bytes: Array.from(new Uint8Array(buffer)),
        });
      }

      toast.success(`${selectedFiles.length} file(s) uploaded to P2P network`);
      setSelectedFiles([]);
      await refreshAll();
    } catch (error) {
      console.error('Upload error:', error);
      toast.error('Failed to upload to P2P network: ' + errorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = async () => {
    toast.success(`Showing ${visibleFiles.length} file(s)`);
  };

  const handleDownload = async (file: P2PFileMetadata) => {
    setIsLoading(true);
    try {
      const result = await electronInvoke('p2p:download', { rootHash: file.rootHash, hash: file.hash });
      if (!result?.bytes) throw new Error('No bytes returned from P2P network');

      const blob = new Blob([new Uint8Array(result.bytes)], { type: file.mimeType || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`${file.name} downloaded from P2P network`);
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Failed to download from P2P network: ' + errorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (file: P2PFileMetadata) => {
    setIsLoading(true);
    try {
      await electronInvoke('p2p:delete', { rootHash: file.rootHash, hash: file.hash });
      toast.success(`${file.name} removed from this node manifest`);
      await refreshAll();
    } catch (error) {
      console.error('Delete error:', error);
      toast.error('Failed to delete manifest: ' + errorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRepair = async () => {
    setIsLoading(true);
    try {
      try {
        await electronInvoke('p2p:repair');
        toast.success('Repair cycle completed');
      } catch {
        toast.info('Repair loop is not exposed in this build yet; refreshed network status instead');
      }
      await refreshAll();
    } finally {
      setIsLoading(false);
    }
  };

  const handlePrepareProof = async () => {
    const rootHash = prompt('Root hash from storage deal');
    if (!rootHash) return;
    const dealId = Number(prompt('Deal ID'));
    const challengeIndex = Number(prompt('Challenge chunk index'));
    if (!Number.isFinite(dealId) || !Number.isFinite(challengeIndex)) {
      toast.error('Invalid deal ID or challenge index');
      return;
    }

    try {
      await electronInvoke('p2p:prepareProof', { dealId, rootHash, challengeIndex });
      toast.success('Proof payload prepared');
      await loadProofQueue();
    } catch (error) {
      toast.error('Failed to prepare proof: ' + errorMessage(error));
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="sticky top-0 z-50 border-b border-white/10 bg-slate-950/90 backdrop-blur">
        <div className="container flex flex-col gap-4 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-cyan-300">Dashboard</p>
            <h1 className="text-2xl font-bold text-white">P2P Cloud</h1>
            <p className="text-sm text-slate-400">Electron P2P engine: chunks, Merkle proofs, peers, and network storage.</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-right">
              <p className="text-xs text-slate-400">P2P Node</p>
              <p className="text-sm font-mono text-white">{status?.peerId ? `${status.peerId.slice(0, 16)}...` : 'starting...'}</p>
            </div>

            {wallet.isConnected && (
              <div className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-right">
                <p className="text-xs text-slate-400">Connected Wallet</p>
                <p className="text-sm font-mono text-white">{wallet.address?.slice(0, 6)}...{wallet.address?.slice(-4)}</p>
              </div>
            )}

            <Button asChild variant="outline" size="sm" className="border-white/20 text-white hover:bg-white/10 hover:text-white">
              <a href="/"><Home className="h-4 w-4" />Home</a>
            </Button>
            <Button variant="outline" size="sm" onClick={refreshAll} disabled={isLoading} className="border-white/20 text-white hover:bg-white/10 hover:text-white">
              <RefreshCw className="h-4 w-4" />Refresh
            </Button>

            {wallet.isConnected ? (
              <Button variant="outline" size="sm" onClick={wallet.disconnect} className="border-white/20 text-white hover:bg-white/10 hover:text-white">
                <LogOut className="h-4 w-4" />Disconnect
              </Button>
            ) : (
              <Button onClick={wallet.connect} disabled={wallet.isLoading} className="bg-cyan-400 text-slate-950 hover:bg-cyan-300">
                <Wallet className="h-4 w-4" />{wallet.isLoading ? 'Connecting...' : 'Connect Wallet'}
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="container py-8">
        <Tabs defaultValue="upload" className="space-y-6">
          <TabsList className="grid h-auto w-full grid-cols-2 gap-2 rounded-md border border-white/10 bg-slate-900 p-2 md:w-fit md:grid-cols-5">
            <TabsTrigger value="browser">Files</TabsTrigger>
            <TabsTrigger value="upload">Upload</TabsTrigger>
            <TabsTrigger value="stats">Stats</TabsTrigger>
            <TabsTrigger value="peers">Network</TabsTrigger>
            <TabsTrigger value="proofs">Proofs</TabsTrigger>
          </TabsList>

          <TabsContent value="browser" className="space-y-4">
            <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none">
              <div className="mb-6 flex flex-col gap-2 sm:flex-row">
                <Input placeholder="Search P2P files by name, hash, or Merkle root..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="border-white/10 bg-slate-950 text-white" />
                <Button onClick={handleSearch} disabled={isLoading} className="bg-cyan-400 text-slate-950 hover:bg-cyan-300"><Search className="h-4 w-4" />Search</Button>
              </div>

              {visibleFiles.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-12 text-center"><p className="text-slate-400">No P2P files found on this node</p></div>
              ) : (
                <div className="space-y-2">
                  {visibleFiles.map((file) => (
                    <div key={file.rootHash || file.hash} className="flex flex-col gap-4 rounded-md border border-white/10 bg-slate-950 p-4 transition hover:border-cyan-300/40 md:flex-row md:items-center md:justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-white">{file.name}</p>
                        <p className="mt-1 text-xs text-slate-400">{formatBytes(file.size)} / {formatDate(file.uploadedAt)} / {file.isEncrypted ? 'Encrypted metadata' : 'Public metadata'} / {file.chunks?.length || file.totalChunks || 0} chunk(s)</p>
                        <p className="mt-1 truncate font-mono text-xs text-slate-500">File: {file.hash}</p>
                        {file.rootHash && <p className="mt-1 truncate font-mono text-xs text-cyan-300">Merkle root: {file.rootHash}</p>}
                      </div>
                      <div className="flex gap-2">
                        <Button variant="ghost" size="icon" onClick={() => handleDownload(file)} disabled={isLoading} aria-label={`Download ${file.name}`}><Download className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(file)} disabled={isLoading} aria-label={`Delete ${file.name}`} className="text-red-300 hover:text-red-200"><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="upload" className="space-y-4">
            <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none">
              <div className="space-y-5">
                <div>
                  <label className="mb-2 block text-sm font-medium text-white">Select Files to Upload to P2P Network</label>
                  <input type="file" multiple onChange={handleFileSelect} className="block w-full text-sm text-slate-400 file:mr-4 file:rounded-md file:border-0 file:bg-cyan-400 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-slate-950 hover:file:bg-cyan-300" />
                </div>

                {selectedFiles.length > 0 && (
                  <div className="rounded-md border border-white/10 bg-slate-950 p-4">
                    <p className="mb-2 text-sm font-medium text-white">Selected Files ({selectedFiles.length})</p>
                    <div className="space-y-1">{selectedFiles.map((file, idx) => <p key={idx} className="text-xs text-slate-400">{file.name} ({formatBytes(file.size)})</p>)}</div>
                  </div>
                )}

                <div className="flex items-center gap-3 rounded-md border border-white/10 bg-slate-950 p-3">
                  <input type="checkbox" id="encrypted" checked={isEncrypted} onChange={(e) => setIsEncrypted(e.target.checked)} className="h-4 w-4" />
                  <label htmlFor="encrypted" className="text-sm text-white">Mark manifest as encrypted/private metadata</label>
                </div>

                <Button onClick={handleUpload} disabled={isLoading || selectedFiles.length === 0} className="h-11 w-full bg-cyan-400 text-slate-950 hover:bg-cyan-300" size="lg">
                  <Upload className="h-4 w-4" />{isLoading ? 'Uploading to network...' : 'Upload to P2P Network'}
                </Button>
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="stats" className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none"><p className="mb-2 text-sm text-slate-400">Total Files</p><p className="text-3xl font-bold text-white">{stats?.totalFiles ?? files.length}</p></Card>
              <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none"><p className="mb-2 text-sm text-slate-400">Network Storage</p><p className="text-3xl font-bold text-white">{formatBytes(stats?.totalBytes || 0)}</p></Card>
              <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none"><p className="mb-2 text-sm text-slate-400">Merkle Chunks</p><p className="text-3xl font-bold text-white">{stats?.totalChunks ?? 0}</p></Card>
              <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none"><p className="mb-2 text-sm text-slate-400">Proof Queue</p><p className="text-3xl font-bold text-white">{stats?.queuedProofs ?? proofQueue.length}</p></Card>
            </div>

            <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none">
              <h3 className="mb-4 text-lg font-bold text-white">P2P Node</h3>
              <div className="space-y-2 text-sm text-slate-300">
                <p>Node ID: <span className="font-mono text-white">{status?.peerId || 'unknown'}</span></p>
                <p>Host: <span className="font-mono text-white">{status?.host || 'unknown'}:{status?.port || 0}</span></p>
                <p>Target Replicas: <span className="font-mono text-white">{stats?.targetReplicas ?? status?.targetReplicas ?? 3}</span></p>
                <p>Connected Peers: <span className="font-mono text-white">{stats?.connectedPeers ?? peers.length}</span></p>
                <p>Under Replicated Chunks: <span className="font-mono text-white">{stats?.underReplicatedChunks ?? 0}</span></p>
              </div>
              <Button onClick={handleRepair} disabled={isLoading} className="mt-5 bg-emerald-400 text-slate-950 hover:bg-emerald-300"><RefreshCw className="h-4 w-4" />Refresh Repair Status</Button>
            </Card>
          </TabsContent>

          <TabsContent value="peers" className="space-y-4">
            <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none">
              <h3 className="mb-4 flex items-center gap-2 text-lg font-bold text-white"><Network className="h-5 w-5" />Connected P2P Peers</h3>
              {peers.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-8 text-center"><p className="text-slate-400">No peers connected yet</p><p className="mt-2 text-sm text-slate-500">Start a second node or connect via bootstrap discovery.</p></div>
              ) : (
                <div className="space-y-3">{peers.map((peer) => <div key={peer.peerId} className="rounded-md border border-white/10 bg-slate-950 p-4"><p className="truncate font-mono text-sm text-white">{peer.peerId}</p><p className="mt-1 break-all text-xs text-slate-400">{peer.url || 'direct socket'}</p><p className="mt-1 text-xs text-emerald-300">{peer.status || 'connected'}</p><p className="mt-1 text-xs text-slate-500">Last seen: {formatDate(peer.lastSeen)}</p></div>)}</div>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="proofs" className="space-y-4">
            <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h3 className="flex items-center gap-2 text-lg font-bold text-white"><ShieldCheck className="h-5 w-5" />Storage Proof Queue</h3>
                <Button onClick={handlePrepareProof} className="bg-cyan-400 text-slate-950 hover:bg-cyan-300">Prepare Challenge Proof</Button>
              </div>

              {proofQueue.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-8 text-center"><p className="text-slate-400">No prepared proofs yet</p><p className="mt-2 text-sm text-slate-500">When a smart contract challenge arrives, prepare a Merkle proof here.</p></div>
              ) : (
                <div className="space-y-3">{proofQueue.map((proof, idx) => <div key={`${proof.dealId}-${proof.chunkIndex}-${idx}`} className="rounded-md border border-white/10 bg-slate-950 p-4"><p className="text-sm text-white">Deal #{proof.dealId} / Chunk #{proof.chunkIndex}</p><p className="mt-1 truncate font-mono text-xs text-cyan-300">Leaf: {proof.leaf}</p><p className="mt-1 truncate font-mono text-xs text-slate-400">Root: {proof.rootHash}</p><p className="mt-1 text-xs text-slate-500">Proof nodes: {proof.merkleProof?.length || 0} / {proof.status || 'ready'}</p></div>)}</div>
              )}
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
