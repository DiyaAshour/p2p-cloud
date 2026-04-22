import { useMemo, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useStorage } from '@/hooks/useStorage';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Upload, Download, Wallet, LogOut, Shield, ShieldOff, HardDrive } from 'lucide-react';
import { toast } from 'sonner';

type UploadedFileView = {
  hash: string;
  name: string;
  size: number;
  isEncrypted: boolean;
  uploadedAt: number;
};

export default function Home() {
  const wallet = useWallet();
  const storage = useStorage();
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [tempEncryptionKey, setTempEncryptionKey] = useState('');
  const [decryptionKey, setDecryptionKey] = useState('');
  const [sharedGB, setSharedGB] = useState('5');

  const sharedBytes = useMemo(() => {
    const value = Number(sharedGB || '0');
    return Math.max(0, value) * 1024 * 1024 * 1024;
  }, [sharedGB]);

  const uploadedFiles: UploadedFileView[] = storage.files.map((file) => ({
    hash: file.hash,
    name: file.name,
    size: file.size,
    isEncrypted: file.isEncrypted,
    uploadedAt: file.uploadedAt,
  }));

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

    try {
      if (isEncrypting) {
        storage.setEncryptionKey(tempEncryptionKey);
      }

      for (const file of selectedFiles) {
        await storage.uploadFile(file, false, '', isEncrypting);
      }

      setSelectedFiles([]);
      setTempEncryptionKey('');
      toast.success('Files uploaded successfully');
      await storage.refreshFiles();
    } catch (error) {
      console.error(error);
      toast.error('Upload failed');
    }
  };

  const handleDownload = async (fileHash: string, isEncrypted: boolean) => {
    if (isEncrypted && !decryptionKey) {
      toast.error('Enter the decryption key first');
      return;
    }

    try {
      if (isEncrypted) {
        storage.setEncryptionKey(decryptionKey);
      }

      const file = storage.files.find((entry) => entry.hash === fileHash);
      if (!file) {
        throw new Error('File not found');
      }

      await storage.downloadFile(file);
      toast.success('Download started');
    } catch (error) {
      console.error(error);
      toast.error('Download failed');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
      <header className="border-b border-slate-700 bg-slate-800/60 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold">P2P Cloud</h1>
            <p className="text-sm text-slate-400">Browser-based encrypted storage experience</p>
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
        <div className="grid md:grid-cols-3 gap-4">
          <Card className="p-4 bg-slate-800 border-slate-700">
            <p className="text-slate-400 text-sm">Stored Files</p>
            <p className="text-2xl font-bold">{storage.stats.totalFiles}</p>
          </Card>
          <Card className="p-4 bg-slate-800 border-slate-700">
            <p className="text-slate-400 text-sm">Encrypted Files</p>
            <p className="text-2xl font-bold">{storage.stats.encryptedFiles}</p>
          </Card>
          <Card className="p-4 bg-slate-800 border-slate-700">
            <div className="flex items-center gap-3">
              <HardDrive className="w-5 h-5 text-blue-400" />
              <div>
                <p className="text-slate-400 text-sm">Shared Capacity</p>
                <p className="text-2xl font-bold">{(sharedBytes / 1024 / 1024 / 1024).toFixed(1)} GB</p>
              </div>
            </div>
          </Card>
        </div>

        <Tabs defaultValue="upload" className="space-y-6">
          <TabsList className="bg-slate-800 border-slate-700">
            <TabsTrigger value="upload">Upload</TabsTrigger>
            <TabsTrigger value="files">My Files</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="upload">
            <Card className="p-6 bg-slate-800 border-slate-700 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Select Files</label>
                <input type="file" multiple onChange={handleFileSelect} className="block w-full text-sm text-slate-300 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700" />
              </div>

              <div className="flex items-center gap-2 p-3 bg-slate-700 rounded-lg">
                <input type="checkbox" id="encrypting" checked={isEncrypting} onChange={(e) => setIsEncrypting(e.target.checked)} className="w-4 h-4" />
                <label htmlFor="encrypting" className="text-sm">Encrypt files before upload</label>
              </div>

              {isEncrypting && (
                <div>
                  <label className="block text-sm font-medium mb-2">Encryption Key</label>
                  <Input type="password" value={tempEncryptionKey} onChange={(e) => setTempEncryptionKey(e.target.value)} placeholder="Strong passphrase" className="bg-slate-700 border-slate-600 text-white" />
                </div>
              )}

              <Button onClick={handleUpload} disabled={storage.isLoading} className="w-full gap-2" size="lg">
                <Upload className="w-4 h-4" />
                {storage.isLoading ? 'Uploading...' : `Upload ${selectedFiles.length} file(s)`}
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
                <p className="text-slate-400">No uploaded files yet.</p>
              ) : (
                <div className="space-y-2">
                  {uploadedFiles.map((file) => (
                    <div key={file.hash} className="flex items-center justify-between p-4 bg-slate-700 rounded-lg">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{file.name}</p>
                          {file.isEncrypted ? <Shield className="w-4 h-4 text-blue-400" /> : <ShieldOff className="w-4 h-4 text-slate-500" />}
                        </div>
                        <p className="text-xs text-slate-400">{(file.size / 1024 / 1024).toFixed(2)} MB • {new Date(file.uploadedAt).toLocaleString()}</p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleDownload(file.hash, file.isEncrypted)} className="gap-2">
                        <Download className="w-4 h-4" />
                        Download
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="settings">
            <Card className="p-6 bg-slate-800 border-slate-700 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Shared Storage (GB)</label>
                <Input value={sharedGB} onChange={(e) => setSharedGB(e.target.value)} className="bg-slate-700 border-slate-600 text-white" />
              </div>
              <p className="text-sm text-slate-400">This value is currently cosmetic in browser mode and can be wired to a backend later.</p>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
