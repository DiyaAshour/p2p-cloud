import { useEffect, useMemo, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Upload, Download, Wallet, LogOut, Shield, ShieldOff, HardDrive, Network } from 'lucide-react';
import { toast } from 'sonner';
import { p2pUploadService } from '@/services/p2pUploadService';

type NodeStatus = {
  started: boolean;
  peerId: string | null;
  peers: number;
  localFiles: number;
  remoteFiles: number;
  localChunks?: number;
  sharedCapacityBytes?: number;
  acceptsNetworkStorage?: boolean;
  knownNodes?: Array<{
    peerId: string;
    walletAddress: string | null;
    totalSharedBytes: number;
    availableSharedBytes: number;
    acceptsNewChunks: boolean;
    lastSeenAt: number;
  }>;
};

type UploadedManifest = {
  fileId: string;
  originalName: string;
  size: number;
  encrypted: boolean;
  createdAt: number;
};

const ipc = (window as any).electron?.ipcRenderer;

export default function Home() {
  const wallet = useWallet();
  const [status, setStatus] = useState<NodeStatus | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedManifest[]>([]);
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [tempEncryptionKey, setTempEncryptionKey] = useState('');
  const [decryptionKey, setDecryptionKey] = useState('');
  const [sharedGB, setSharedGB] = useState('5');
  const [acceptStorage, setAcceptStorage] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [earningsUsd, setEarningsUsd] = useState(0);

  const sharedBytes = useMemo(() => {
    const value = Number(sharedGB || '0');
    return Math.max(0, value) * 1024 * 1024 * 1024;
  }, [sharedGB]);

  const refreshStatus = async () => {
    if (!ipc) return;
    const nextStatus = await ipc.invoke('p2p:status');
    setStatus(nextStatus);
  };

  const refreshEarnings = async (peerId?: string | null) => {
    if (!ipc || !peerId) return;
    const earnings = await ipc.invoke('earnings:get');
    setEarningsUsd(Number(earnings?.[peerId] || 0));
  };

  useEffect(() => {
    const bootstrap = async () => {
      if (!ipc) return;
      try {
        await ipc.invoke('p2p:start');
        const nextStatus = await ipc.invoke('p2p:update-config', {
          walletAddress: wallet.address,
          totalSharedBytes: sharedBytes,
          acceptsNetworkStorage: acceptStorage,
        });
        setStatus(nextStatus);
      } catch (error) {
        console.error(error);
      }
    };

    bootstrap();
  }, [wallet.address, sharedBytes, acceptStorage]);

  useEffect(() => {
    refreshEarnings(status?.peerId);
  }, [status?.peerId]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setSelectedFiles(Array.from(e.target.files));
    }
  };

  const handleUpload = async () => {
    if (!selectedFiles.length) {
      toast.error('Select at least one file');
      return;
    }

    if (!wallet.isConnected) {
      toast.error('Connect your wallet first');
      return;
    }

    if (isEncrypting && !tempEncryptionKey) {
      toast.error('Enter an encryption key');
      return;
    }

    setIsBusy(true);
    try {
      const manifests: UploadedManifest[] = [];
      for (const file of selectedFiles) {
        const result = await p2pUploadService.uploadFile(
          file,
          isEncrypting ? tempEncryptionKey : undefined
        );
        const manifest = result.manifest;
        manifests.push({
          fileId: manifest.fileId,
          originalName: manifest.originalName,
          size: manifest.size,
          encrypted: manifest.encrypted,
          createdAt: manifest.createdAt,
        });
      }

      setUploadedFiles((prev) => [...manifests, ...prev]);
      setSelectedFiles([]);
      setTempEncryptionKey('');
      toast.success('Files uploaded to the P2P network');
      await refreshStatus();
      await refreshEarnings(status?.peerId);
    } catch (error) {
      console.error(error);
      toast.error('P2P upload failed');
    } finally {
      setIsBusy(false);
    }
  };

  const handleDownload = async (fileId: string, encrypted: boolean) => {
    if (encrypted && !decryptionKey) {
      toast.error('Enter the decryption key first');
      return;
    }

    setIsBusy(true);
    try {
      const file = await p2pUploadService.downloadFile(
        fileId,
        encrypted ? decryptionKey : undefined
      );
      const url = window.URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      toast.success('File reconstructed from the network');
    } catch (error) {
      console.error(error);
      toast.error('Download failed');
    } finally {
      setIsBusy(false);
    }
  };

  const handlePayout = async () => {
    if (earningsUsd <= 0) {
      toast.error('No earnings available yet');
      return;
    }

    toast.message(`Payout flow placeholder: $${earningsUsd.toFixed(6)} available`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
      <header className="border-b border-slate-700 bg-slate-800/60 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold">P2P Cloud</h1>
            <p className="text-sm text-slate-400">Distributed encrypted storage using user-contributed disk space</p>
          </div>

          {wallet.isConnected ? (
            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-sm text-slate-400">Wallet</p>
                <p className="text-sm font-mono">{wallet.address?.slice(0, 6)}...{wallet.address?.slice(-4)}</p>
              </div>
              <Button variant="outline" size="sm" onClick={wallet.disconnect} className="gap-2">
                <LogOut className="w-4 h-4" />
                Disconnect
              </Button>
            </div>
          ) : (
            <Button onClick={wallet.connect} disabled={wallet.isLoading} className="gap-2">
              <Wallet className="w-4 h-4" />
              {wallet.isLoading ? 'Connecting...' : 'Connect Wallet'}
            </Button>
          )}
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <div className="grid md:grid-cols-5 gap-4">
          <Card className="p-4 bg-slate-800 border-slate-700">
            <div className="flex items-center gap-3">
              <Network className="w-5 h-5 text-blue-400" />
              <div>
                <p className="text-slate-400 text-sm">Peer ID</p>
                <p className="text-xs break-all">{status?.peerId || 'Not started'}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4 bg-slate-800 border-slate-700">
            <p className="text-slate-400 text-sm">Connected Peers</p>
            <p className="text-2xl font-bold">{status?.peers || 0}</p>
          </Card>
          <Card className="p-4 bg-slate-800 border-slate-700">
            <p className="text-slate-400 text-sm">Local Hosted Chunks</p>
            <p className="text-2xl font-bold">{status?.localChunks || 0}</p>
          </Card>
          <Card className="p-4 bg-slate-800 border-slate-700">
            <p className="text-slate-400 text-sm">Shared Capacity</p>
            <p className="text-2xl font-bold">{((status?.sharedCapacityBytes || 0) / 1024 / 1024 / 1024).toFixed(1)} GB</p>
          </Card>
          <Card className="p-4 bg-slate-800 border-slate-700">
            <p className="text-slate-400 text-sm">Earnings (USD)</p>
            <p className="text-2xl font-bold">${earningsUsd.toFixed(6)}</p>
            <Button variant="outline" size="sm" onClick={handlePayout} className="mt-3">Withdraw</Button>
          </Card>
        </div>

        <Tabs defaultValue="upload" className="space-y-6">
          <TabsList className="bg-slate-800 border-slate-700">
            <TabsTrigger value="upload">Upload</TabsTrigger>
            <TabsTrigger value="files">My Network Files</TabsTrigger>
            <TabsTrigger value="node">Node Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="upload">
            <Card className="p-6 bg-slate-800 border-slate-700 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Select Files</label>
                <input type="file" multiple onChange={handleFileSelect} className="block w-full text-sm text-slate-300 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700" />
              </div>

              <div className="flex items-center gap-2 p-3 bg-slate-700 rounded-lg">
                <input type="checkbox" id="encrypting" checked={isEncrypting} onChange={(e) => setIsEncrypting(e.target.checked)} className="w-4 h-4" />
                <label htmlFor="encrypting" className="text-sm">Encrypt chunks before upload</label>
              </div>

              {isEncrypting && (
                <div>
                  <label className="block text-sm font-medium mb-2">Encryption Key</label>
                  <Input type="password" value={tempEncryptionKey} onChange={(e) => setTempEncryptionKey(e.target.value)} placeholder="Strong passphrase" className="bg-slate-700 border-slate-600 text-white" />
                </div>
              )}

              <Button onClick={handleUpload} disabled={isBusy} className="w-full gap-2" size="lg">
                <Upload className="w-4 h-4" />
                {isBusy ? 'Uploading...' : `Upload ${selectedFiles.length} file(s) to network`}
              </Button>
            </Card>
          </TabsContent>

          <TabsContent value="files">
            <Card className="p-6 bg-slate-800 border-slate-700 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Decryption Key</label>
                <Input type="password" value={decryptionKey} onChange={(e) => setDecryptionKey(e.target.value)} placeholder="Required for encrypted files" className="bg-slate-700 border-slate-600 text-white" />
              </div>

              {uploadedFiles.length === 0 ? (
                <p className="text-slate-400">No uploaded manifests in this session yet.</p>
              ) : (
                <div className="space-y-2">
                  {uploadedFiles.map((file) => (
                    <div key={file.fileId} className="flex items-center justify-between p-4 bg-slate-700 rounded-lg">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{file.originalName}</p>
                          {file.encrypted ? <Shield className="w-4 h-4 text-blue-400" /> : <ShieldOff className="w-4 h-4 text-slate-500" />}
                        </div>
                        <p className="text-xs text-slate-400">{(file.size / 1024 / 1024).toFixed(2)} MB • {new Date(file.createdAt).toLocaleString()}</p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleDownload(file.fileId, file.encrypted)} className="gap-2">
                        <Download className="w-4 h-4" />
                        Download
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="node">
            <Card className="p-6 bg-slate-800 border-slate-700 space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2">Shared Storage (GB)</label>
                  <Input value={sharedGB} onChange={(e) => setSharedGB(e.target.value)} className="bg-slate-700 border-slate-600 text-white" />
                </div>
                <div className="flex items-center gap-2 p-3 bg-slate-700 rounded-lg self-end">
                  <HardDrive className="w-4 h-4 text-blue-400" />
                  <input type="checkbox" id="accept-storage" checked={acceptStorage} onChange={(e) => setAcceptStorage(e.target.checked)} className="w-4 h-4" />
                  <label htmlFor="accept-storage" className="text-sm">Accept other users' chunks</label>
                </div>
              </div>

              <Button onClick={refreshStatus} variant="outline">Refresh node status</Button>

              <div className="space-y-2">
                <h3 className="font-semibold">Known Nodes</h3>
                {(status?.knownNodes || []).length === 0 ? (
                  <p className="text-slate-400">No advertised nodes discovered yet.</p>
                ) : (
                  <div className="space-y-2">
                    {status?.knownNodes?.map((node) => (
                      <div key={node.peerId} className="p-3 bg-slate-700 rounded-lg text-sm">
                        <p className="font-mono break-all">{node.peerId}</p>
                        <p className="text-slate-400">Available: {(node.availableSharedBytes / 1024 / 1024 / 1024).toFixed(2)} GB</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
