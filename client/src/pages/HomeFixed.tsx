import { useState, useEffect } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Upload, Download, Trash2, Search, Wallet, LogOut, RefreshCw } from 'lucide-react';
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

const API_KEY = import.meta.env.VITE_P2P_API_KEY || '';

function apiHeaders(extra: HeadersInit = {}) {
  return API_KEY ? { ...extra, 'x-p2p-api-key': API_KEY } : extra;
}

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

export default function HomeFixed() {
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

  const requestJson = async <T,>(url: string, options: RequestInit = {}): Promise<T> => {
    const response = await fetch(url, {
      ...options,
      headers: apiHeaders(options.headers || {}),
    });

    if (!response.ok) {
      const message = await response.text().catch(() => 'Request failed');
      throw new Error(message || `Request failed with ${response.status}`);
    }

    return response.json();
  };

  const loadFiles = async (query = searchQuery) => {
    const url = query.trim() ? `/api/files?q=${encodeURIComponent(query.trim())}` : '/api/files';
    const fileList = await requestJson<ApiFileMetadata[]>(url);
    setFiles(fileList);
    return fileList;
  };

  const loadPeers = async () => {
    const peerList = await requestJson<ApiPeerInfo[]>('/api/peers');
    setPeers(peerList);
    return peerList;
  };

  const loadStats = async () => {
    const nextStats = await requestJson<ApiStats>('/api/stats');
    setStats(nextStats);
    return nextStats;
  };

  const refreshAll = async () => {
    setIsLoading(true);
    try {
      await Promise.all([loadFiles(), loadPeers(), loadStats()]);
    } catch (error) {
      console.error('Refresh failed:', error);
      toast.error('Failed to load backend data');
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

        const response = await fetch('/api/upload', {
          method: 'POST',
          headers: apiHeaders(),
          body: formData,
        });

        if (!response.ok) {
          const message = await response.text().catch(() => 'Upload failed');
          throw new Error(message || `Upload failed for ${file.name}`);
        }
      }

      toast.success(`✅ ${selectedFiles.length} file(s) uploaded to backend`);
      setSelectedFiles([]);
      await refreshAll();
    } catch (error) {
      console.error('Upload error:', error);
      toast.error('Failed to upload files: ' + (error instanceof Error ? error.message : 'Unknown error'));
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
      toast.error('Search failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownload = async (fileHash: string, fileName: string) => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/download/${encodeURIComponent(fileHash)}`, {
        headers: apiHeaders(),
      });

      if (!response.ok) {
        const message = await response.text().catch(() => 'Download failed');
        throw new Error(message || 'Download failed');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`✅ ${fileName} downloaded from backend`);
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Failed to download file: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (fileHash: string, fileName: string) => {
    setIsLoading(true);
    try {
      await requestJson(`/api/files/${encodeURIComponent(fileHash)}`, { method: 'DELETE' });
      toast.success(`✅ ${fileName} deleted from backend`);
      await refreshAll();
    } catch (error) {
      console.error('Delete error:', error);
      toast.error('Failed to delete file');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRepair = async () => {
    setIsLoading(true);
    try {
      await requestJson('/api/repair', { method: 'POST' });
      toast.success('Repair cycle completed');
      await refreshAll();
    } catch (error) {
      console.error('Repair error:', error);
      toast.error('Repair failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <header className="border-b border-slate-700 bg-slate-800/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-white">P2P Cloud</h1>
            <p className="text-sm text-slate-400">Backend-powered distributed chunk storage</p>
          </div>

          <div className="flex items-center gap-4">
            {wallet.isConnected && (
              <div className="text-right">
                <p className="text-sm text-slate-400">Connected Wallet</p>
                <p className="text-sm font-mono text-white">
                  {wallet.address?.slice(0, 6)}...{wallet.address?.slice(-4)}
                </p>
                <p className="text-xs text-slate-400">{wallet.balance} ETH</p>
              </div>
            )}

            <Button variant="outline" size="sm" onClick={refreshAll} disabled={isLoading} className="gap-2">
              <RefreshCw className="w-4 h-4" />
              Refresh
            </Button>
            
            {wallet.isConnected ? (
              <Button variant="outline" size="sm" onClick={wallet.disconnect} className="gap-2">
                <LogOut className="w-4 h-4" />
                Disconnect
              </Button>
            ) : (
              <Button onClick={wallet.connect} disabled={wallet.isLoading} className="gap-2">
                <Wallet className="w-4 h-4" />
                {wallet.isLoading ? 'Connecting...' : 'Connect Wallet'}
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <Tabs defaultValue="browser" className="space-y-6">
          <TabsList className="bg-slate-800 border-slate-700">
            <TabsTrigger value="browser">File Browser</TabsTrigger>
            <TabsTrigger value="upload">Upload Files</TabsTrigger>
            <TabsTrigger value="stats">Statistics</TabsTrigger>
            <TabsTrigger value="peers">Network</TabsTrigger>
          </TabsList>

          <TabsContent value="browser" className="space-y-4">
            <Card className="p-6 bg-slate-800 border-slate-700">
              <div className="flex gap-2 mb-6">
                <Input
                  placeholder="Search backend files by name or hash..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-slate-700 border-slate-600 text-white"
                />
                <Button onClick={handleSearch} disabled={isLoading} className="gap-2">
                  <Search className="w-4 h-4" />
                  Search
                </Button>
              </div>

              {files.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-slate-400">No backend files found</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {files.map((file) => (
                    <div key={file.hash} className="flex items-center justify-between p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition">
                      <div className="flex-1">
                        <p className="text-white font-medium">{file.name}</p>
                        <p className="text-xs text-slate-400">
                          {formatBytes(file.size)} • {formatDate(file.uploadedAt)} • {file.isEncrypted ? '🔒 Encrypted' : '🌐 Public'} • {file.replicas?.length || 0} replica(s) • {file.chunks?.length || 0} chunk(s)
                        </p>
                        <p className="text-xs text-slate-500 font-mono mt-1">{file.hash.slice(0, 32)}...</p>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => handleDownload(file.hash, file.name)} disabled={isLoading} className="gap-2">
                          <Download className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(file.hash, file.name)} disabled={isLoading} className="gap-2 text-red-400 hover:text-red-300">
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="upload" className="space-y-4">
            <Card className="p-6 bg-slate-800 border-slate-700">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-white mb-2">Select Files to Upload</label>
                  <input
                    type="file"
                    multiple
                    onChange={handleFileSelect}
                    className="block w-full text-sm text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700"
                  />
                </div>

                {selectedFiles.length > 0 && (
                  <div className="bg-slate-700 rounded-lg p-4">
                    <p className="text-sm font-medium text-white mb-2">Selected Files ({selectedFiles.length})</p>
                    <div className="space-y-1">
                      {selectedFiles.map((file, idx) => (
                        <p key={idx} className="text-xs text-slate-400">{file.name} ({formatBytes(file.size)})</p>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2 p-3 bg-slate-700 rounded-lg">
                  <input type="checkbox" id="encrypted" checked={isEncrypted} onChange={(e) => setIsEncrypted(e.target.checked)} className="w-4 h-4" />
                  <label htmlFor="encrypted" className="text-sm text-white">Mark upload as encrypted metadata</label>
                </div>

                <Button onClick={handleUpload} disabled={isLoading || selectedFiles.length === 0} className="w-full gap-2" size="lg">
                  <Upload className="w-4 h-4" />
                  {isLoading ? 'Uploading...' : 'Upload to Backend'}
                </Button>
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="stats" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card className="p-6 bg-slate-800 border-slate-700">
                <p className="text-sm text-slate-400 mb-2">Total Files</p>
                <p className="text-3xl font-bold text-white">{stats?.totalFiles ?? files.length}</p>
              </Card>

              <Card className="p-6 bg-slate-800 border-slate-700">
                <p className="text-sm text-slate-400 mb-2">Storage Used</p>
                <p className="text-3xl font-bold text-white">{formatBytes(stats?.totalBytes || 0)}</p>
              </Card>

              <Card className="p-6 bg-slate-800 border-slate-700">
                <p className="text-sm text-slate-400 mb-2">Total Chunks</p>
                <p className="text-3xl font-bold text-white">{stats?.totalChunks ?? 0}</p>
              </Card>

              <Card className="p-6 bg-slate-800 border-slate-700">
                <p className="text-sm text-slate-400 mb-2">Under-Replicated Files</p>
                <p className="text-3xl font-bold text-white">{stats?.underReplicatedFiles ?? 0}</p>
              </Card>
            </div>

            <Card className="p-6 bg-slate-800 border-slate-700">
              <h3 className="text-lg font-bold text-white mb-4">Backend Node</h3>
              <div className="space-y-2 text-sm text-slate-300">
                <p>Node ID: <span className="font-mono text-white">{stats?.nodeId || 'unknown'}</span></p>
                <p>Public URL: <span className="font-mono text-white">{stats?.publicUrl || 'unknown'}</span></p>
                <p>Chunk Size: <span className="font-mono text-white">{formatBytes(stats?.chunkSizeBytes || 0)}</span></p>
                <p>Peers: <span className="font-mono text-white">{stats?.peers ?? peers.length}</span></p>
              </div>
              <Button onClick={handleRepair} disabled={isLoading} className="mt-4 gap-2">
                <RefreshCw className="w-4 h-4" />
                Run Repair Cycle
              </Button>
            </Card>
          </TabsContent>

          <TabsContent value="peers" className="space-y-4">
            <Card className="p-6 bg-slate-800 border-slate-700">
              <h3 className="text-lg font-bold text-white mb-4">Connected Backend Peers</h3>
              {peers.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-slate-400">No peers connected yet</p>
                  <p className="text-sm text-slate-500 mt-2">Register another backend node or bootstrap URL to connect</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {peers.map((peer) => (
                    <div key={peer.peerId} className="p-4 bg-slate-700 rounded-lg border border-slate-600">
                      <div className="flex justify-between items-start gap-4">
                        <div>
                          <p className="text-white font-mono text-sm">{peer.peerId}</p>
                          <p className="text-xs text-slate-400 mt-1">{peer.url}</p>
                          <p className="text-xs text-slate-500 mt-1">Last seen: {formatDate(peer.lastSeen)}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm text-green-400">🟢 Known</p>
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
