import { useState, useEffect } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { p2pFetch, p2pJson, resetP2PApiBase } from '@/lib/p2pApi';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Upload, Download, Trash2, Search, Wallet, LogOut, RefreshCw, Home } from 'lucide-react';
import { toast } from 'sonner';

type ApiChunkInfo = {
  index: number;
  hash: string;
  size: number;
  replicas: string[];
};

type ApiFileMetadata = {
  id: string;
  name: string;
  size: number;
  hash: string;
  uploadedAt: string;
  path: string;
  isEncrypted: boolean;
  mimeType?: string;
  ownerNodeId: string;
  replicas: string[];
  storageMode?: 'file' | 'chunks';
  chunkSize?: number;
  chunks?: ApiChunkInfo[];
};

type ApiPeerInfo = {
  peerId: string;
  url: string;
  lastSeen: string;
  successCount?: number;
  failureCount?: number;
  latencyMs?: number;
};

type ApiStats = {
  nodeId: string;
  publicUrl: string;
  peers: number;
  totalFiles: number;
  totalChunks: number;
  chunkSizeBytes: number;
  underReplicatedFiles: number;
  encryptedFiles: number;
  publicFiles: number;
  totalBytes: number;
  totalMB: number;
};

function formatBytes(bytes = 0) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

function formatDate(value?: string) {
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
  const [isEncrypted, setIsEncrypted] = useState(false);
  const [files, setFiles] = useState<ApiFileMetadata[]>([]);
  const [peers, setPeers] = useState<ApiPeerInfo[]>([]);
  const [stats, setStats] = useState<ApiStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    refreshAll();
  }, []);

  const loadFiles = async (query = searchQuery) => {
    const url = query.trim() ? `/api/files?q=${encodeURIComponent(query.trim())}` : '/api/files';
    const fileList = await p2pJson<ApiFileMetadata[]>(url);
    setFiles(fileList);
    return fileList;
  };

  const loadPeers = async () => {
    const peerList = await p2pJson<ApiPeerInfo[]>('/api/peers');
    setPeers(peerList);
    return peerList;
  };

  const loadStats = async () => {
    const nextStats = await p2pJson<ApiStats>('/api/stats');
    setStats(nextStats);
    return nextStats;
  };

  const refreshAll = async () => {
    setIsLoading(true);
    try {
      await Promise.all([loadFiles(), loadPeers(), loadStats()]);
    } catch (error) {
      console.error('Refresh failed:', error);
      resetP2PApiBase();
      toast.error('Failed to load backend data: ' + errorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setSelectedFiles(Array.from(e.target.files));
    }
  };

  const handleUpload = async () => {
    if (selectedFiles.length === 0) {
      toast.error('Please select files to upload');
      return;
    }

    setIsLoading(true);
    try {
      for (const file of selectedFiles) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('isEncrypted', String(isEncrypted));

        try {
          await p2pFetch('/api/upload', {
            method: 'POST',
            body: formData,
          });
        } catch (error) {
          throw new Error(`${file.name}: ${errorMessage(error)}`);
        }
      }

      toast.success(`${selectedFiles.length} file(s) uploaded to backend`);
      setSelectedFiles([]);
      await refreshAll();
    } catch (error) {
      console.error('Upload error:', error);
      resetP2PApiBase();
      toast.error('Failed to upload files: ' + errorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = async () => {
    setIsLoading(true);
    try {
      const results = await loadFiles(searchQuery);
      toast.success(`Found ${results.length} file(s)`);
    } catch (error) {
      console.error('Search error:', error);
      resetP2PApiBase();
      toast.error('Search failed: ' + errorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownload = async (fileHash: string, fileName: string) => {
    setIsLoading(true);
    try {
      const response = await p2pFetch(`/api/download/${encodeURIComponent(fileHash)}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`${fileName} downloaded from backend`);
    } catch (error) {
      console.error('Download error:', error);
      resetP2PApiBase();
      toast.error('Failed to download file: ' + errorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (fileHash: string, fileName: string) => {
    setIsLoading(true);
    try {
      await p2pJson(`/api/files/${encodeURIComponent(fileHash)}`, { method: 'DELETE' });
      toast.success(`${fileName} deleted from backend`);
      await refreshAll();
    } catch (error) {
      console.error('Delete error:', error);
      resetP2PApiBase();
      toast.error('Failed to delete file: ' + errorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRepair = async () => {
    setIsLoading(true);
    try {
      await p2pJson('/api/repair', { method: 'POST' });
      toast.success('Repair cycle completed');
      await refreshAll();
    } catch (error) {
      console.error('Repair error:', error);
      resetP2PApiBase();
      toast.error('Repair failed: ' + errorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="sticky top-0 z-50 border-b border-white/10 bg-slate-950/90 backdrop-blur">
        <div className="container flex flex-col gap-4 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-cyan-300">Dashboard</p>
            <h1 className="text-2xl font-bold text-white">P2P Cloud</h1>
            <p className="text-sm text-slate-400">Upload, encrypt, track, and repair distributed storage.</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {wallet.isConnected && (
              <div className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-right">
                <p className="text-xs text-slate-400">Connected Wallet</p>
                <p className="text-sm font-mono text-white">
                  {wallet.address?.slice(0, 6)}...{wallet.address?.slice(-4)}
                </p>
              </div>
            )}

            <Button asChild variant="outline" size="sm" className="border-white/20 text-white hover:bg-white/10 hover:text-white">
              <a href="/">
                <Home className="h-4 w-4" />
                Home
              </a>
            </Button>
            <Button variant="outline" size="sm" onClick={refreshAll} disabled={isLoading} className="border-white/20 text-white hover:bg-white/10 hover:text-white">
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>

            {wallet.isConnected ? (
              <Button variant="outline" size="sm" onClick={wallet.disconnect} className="border-white/20 text-white hover:bg-white/10 hover:text-white">
                <LogOut className="h-4 w-4" />
                Disconnect
              </Button>
            ) : (
              <Button onClick={wallet.connect} disabled={wallet.isLoading} className="bg-cyan-400 text-slate-950 hover:bg-cyan-300">
                <Wallet className="h-4 w-4" />
                {wallet.isLoading ? 'Connecting...' : 'Connect Wallet'}
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="container py-8">
        <Tabs defaultValue="browser" className="space-y-6">
          <TabsList className="grid h-auto w-full grid-cols-2 gap-2 rounded-md border border-white/10 bg-slate-900 p-2 md:w-fit md:grid-cols-4">
            <TabsTrigger value="browser">File Browser</TabsTrigger>
            <TabsTrigger value="upload">Upload Files</TabsTrigger>
            <TabsTrigger value="stats">Statistics</TabsTrigger>
            <TabsTrigger value="peers">Network</TabsTrigger>
          </TabsList>

          <TabsContent value="browser" className="space-y-4">
            <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none">
              <div className="mb-6 flex flex-col gap-2 sm:flex-row">
                <Input
                  placeholder="Search backend files by name or hash..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="border-white/10 bg-slate-950 text-white"
                />
                <Button onClick={handleSearch} disabled={isLoading} className="bg-cyan-400 text-slate-950 hover:bg-cyan-300">
                  <Search className="h-4 w-4" />
                  Search
                </Button>
              </div>

              {files.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-12 text-center">
                  <p className="text-slate-400">No backend files found</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {files.map((file) => (
                    <div key={file.hash} className="flex flex-col gap-4 rounded-md border border-white/10 bg-slate-950 p-4 transition hover:border-cyan-300/40 md:flex-row md:items-center md:justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-white">{file.name}</p>
                        <p className="mt-1 text-xs text-slate-400">
                          {formatBytes(file.size)} / {formatDate(file.uploadedAt)} / {file.isEncrypted ? 'Encrypted' : 'Public'} / {file.replicas?.length || 0} replica(s) / {file.chunks?.length || 0} chunk(s)
                        </p>
                        <p className="mt-1 truncate font-mono text-xs text-slate-500">{file.hash}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="ghost" size="icon" onClick={() => handleDownload(file.hash, file.name)} disabled={isLoading} aria-label={`Download ${file.name}`}>
                          <Download className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(file.hash, file.name)} disabled={isLoading} aria-label={`Delete ${file.name}`} className="text-red-300 hover:text-red-200">
                          <Trash2 className="h-4 w-4" />
                        </Button>
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
                  <label className="mb-2 block text-sm font-medium text-white">Select Files to Upload</label>
                  <input
                    type="file"
                    multiple
                    onChange={handleFileSelect}
                    className="block w-full text-sm text-slate-400 file:mr-4 file:rounded-md file:border-0 file:bg-cyan-400 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-slate-950 hover:file:bg-cyan-300"
                  />
                </div>

                {selectedFiles.length > 0 && (
                  <div className="rounded-md border border-white/10 bg-slate-950 p-4">
                    <p className="mb-2 text-sm font-medium text-white">Selected Files ({selectedFiles.length})</p>
                    <div className="space-y-1">
                      {selectedFiles.map((file, idx) => (
                        <p key={idx} className="text-xs text-slate-400">{file.name} ({formatBytes(file.size)})</p>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-3 rounded-md border border-white/10 bg-slate-950 p-3">
                  <input type="checkbox" id="encrypted" checked={isEncrypted} onChange={(e) => setIsEncrypted(e.target.checked)} className="h-4 w-4" />
                  <label htmlFor="encrypted" className="text-sm text-white">Mark upload as encrypted metadata</label>
                </div>

                <Button onClick={handleUpload} disabled={isLoading || selectedFiles.length === 0} className="h-11 w-full bg-cyan-400 text-slate-950 hover:bg-cyan-300" size="lg">
                  <Upload className="h-4 w-4" />
                  {isLoading ? 'Uploading...' : 'Upload to Backend'}
                </Button>
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="stats" className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none">
                <p className="mb-2 text-sm text-slate-400">Total Files</p>
                <p className="text-3xl font-bold text-white">{stats?.totalFiles ?? files.length}</p>
              </Card>

              <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none">
                <p className="mb-2 text-sm text-slate-400">Storage Used</p>
                <p className="text-3xl font-bold text-white">{formatBytes(stats?.totalBytes || 0)}</p>
              </Card>

              <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none">
                <p className="mb-2 text-sm text-slate-400">Total Chunks</p>
                <p className="text-3xl font-bold text-white">{stats?.totalChunks ?? 0}</p>
              </Card>

              <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none">
                <p className="mb-2 text-sm text-slate-400">Under-Replicated</p>
                <p className="text-3xl font-bold text-white">{stats?.underReplicatedFiles ?? 0}</p>
              </Card>
            </div>

            <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none">
              <h3 className="mb-4 text-lg font-bold text-white">Backend Node</h3>
              <div className="space-y-2 text-sm text-slate-300">
                <p>Node ID: <span className="font-mono text-white">{stats?.nodeId || 'unknown'}</span></p>
                <p>Public URL: <span className="font-mono text-white">{stats?.publicUrl || 'unknown'}</span></p>
                <p>Chunk Size: <span className="font-mono text-white">{formatBytes(stats?.chunkSizeBytes || 0)}</span></p>
                <p>Peers: <span className="font-mono text-white">{stats?.peers ?? peers.length}</span></p>
              </div>
              <Button onClick={handleRepair} disabled={isLoading} className="mt-5 bg-emerald-400 text-slate-950 hover:bg-emerald-300">
                <RefreshCw className="h-4 w-4" />
                Run Repair Cycle
              </Button>
            </Card>
          </TabsContent>

          <TabsContent value="peers" className="space-y-4">
            <Card className="rounded-md border-white/10 bg-slate-900 p-6 shadow-none">
              <h3 className="mb-4 text-lg font-bold text-white">Connected Backend Peers</h3>
              {peers.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-8 text-center">
                  <p className="text-slate-400">No peers connected yet</p>
                  <p className="mt-2 text-sm text-slate-500">Register another backend node or bootstrap URL to connect</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {peers.map((peer) => (
                    <div key={peer.peerId} className="rounded-md border border-white/10 bg-slate-950 p-4">
                      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
                        <div className="min-w-0">
                          <p className="truncate font-mono text-sm text-white">{peer.peerId}</p>
                          <p className="mt-1 break-all text-xs text-slate-400">{peer.url}</p>
                          <p className="mt-1 text-xs text-slate-500">Last seen: {formatDate(peer.lastSeen)}</p>
                        </div>
                        <div className="shrink-0 md:text-right">
                          <p className="text-sm text-emerald-300">Known</p>
                          <p className="text-xs text-slate-400">OK: {peer.successCount || 0} / Fail: {peer.failureCount || 0}</p>
                          <p className="text-xs text-slate-400">Latency: {peer.latencyMs ?? 0}ms</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
