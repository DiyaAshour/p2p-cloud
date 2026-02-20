import { useState, useEffect } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useStorage } from '@/hooks/useStorage';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Upload, Download, Trash2, Search, Wallet, LogOut, Shield, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';

export default function Home() {
  const wallet = useWallet();
  const storage = useStorage();
  
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isIndexing, setIsIndexing] = useState(false);
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [tempEncryptionKey, setTempEncryptionKey] = useState('');
  const [decryptionKey, setDecryptionKey] = useState('');

  useEffect(() => {
    storage.refreshFiles();
  }, []);

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

    if (!wallet.isConnected) {
      toast.error('Please connect your wallet first');
      return;
    }

    if (isEncrypting && !tempEncryptionKey) {
      toast.error('Please enter an encryption key');
      return;
    }

    try {
      for (const file of selectedFiles) {
        if (isEncrypting) {
          storage.setEncryptionKey(tempEncryptionKey);
          await storage.uploadFile(file, isIndexing, '', true);
        } else {
          await storage.uploadFile(file, isIndexing, '', false);
        }
      }
      toast.success(`${selectedFiles.length} file(s) uploaded successfully`);
      setSelectedFiles([]);
      setTempEncryptionKey('');
      setIsEncrypting(false);
    } catch (error) {
      console.error('Upload error:', error);
      toast.error('Failed to upload files');
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      storage.refreshFiles();
      return;
    }

    try {
      await storage.searchFiles(searchQuery);
    } catch (error) {
      console.error('Search error:', error);
      toast.error('Search failed');
    }
  };

  const handleDownload = async (fileHash: string, isEncrypted: boolean) => {
    if (isEncrypted && !decryptionKey) {
      toast.error('Please enter the decryption key in Statistics tab');
      return;
    }

    try {
      if (isEncrypted) {
        storage.setEncryptionKey(decryptionKey);
      }
      await storage.downloadFile(fileHash, isEncrypted);
      toast.success('File download started');
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Failed to download file. Check your decryption key.');
    }
  };

  const handleDelete = async (fileHash: string) => {
    try {
      await storage.deleteFile(fileHash);
      toast.success('File removed from view');
    } catch (error) {
      console.error('Delete error:', error);
      toast.error('Failed to delete file');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Header */}
      <header className="border-b border-slate-700 bg-slate-800/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-white">P2P Storage Browser</h1>
            <p className="text-sm text-slate-400">Decentralized file storage network with E2E encryption</p>
          </div>

          {wallet.isConnected ? (
            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-sm text-slate-400">Connected Wallet</p>
                <p className="text-sm font-mono text-white">
                  {wallet.address?.slice(0, 6)}...{wallet.address?.slice(-4)}
                </p>
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

      <main className="container mx-auto px-4 py-8">
        {!wallet.isConnected ? (
          <Card className="p-12 text-center bg-slate-800 border-slate-700">
            <Wallet className="w-16 h-16 mx-auto mb-4 text-slate-400" />
            <h2 className="text-2xl font-bold text-white mb-2">Connect Your Wallet</h2>
            <p className="text-slate-400 mb-6">To use P2P Storage, please connect your MetaMask wallet first</p>
            <Button onClick={wallet.connect} disabled={wallet.isLoading} size="lg">
              {wallet.isLoading ? 'Connecting...' : 'Connect MetaMask'}
            </Button>
          </Card>
        ) : (
          <Tabs defaultValue="browser" className="space-y-6">
            <TabsList className="bg-slate-800 border-slate-700">
              <TabsTrigger value="browser">File Browser</TabsTrigger>
              <TabsTrigger value="upload">Upload Files</TabsTrigger>
              <TabsTrigger value="stats">Statistics & Keys</TabsTrigger>
            </TabsList>

            <TabsContent value="browser" className="space-y-4">
              <Card className="p-6 bg-slate-800 border-slate-700">
                <div className="flex gap-2 mb-6">
                  <Input
                    placeholder="Search files by name or hash..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="bg-slate-700 border-slate-600 text-white"
                  />
                  <Button onClick={handleSearch} className="gap-2">
                    <Search className="w-4 h-4" />
                    Search
                  </Button>
                </div>

                {storage.files.length === 0 ? (
                  <div className="text-center py-12">
                    <p className="text-slate-400">No files found on the network</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {storage.files.map((file) => (
                      <div key={file.hash} className="flex items-center justify-between p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-white font-medium">{file.name}</p>
                            {file.isEncrypted ? <Shield className="w-4 h-4 text-blue-400" /> : <ShieldOff className="w-4 h-4 text-slate-500" />}
                          </div>
                          <p className="text-xs text-slate-400">
                            {(file.size / 1024 / 1024).toFixed(2)} MB • {new Date(file.uploadedAt).toLocaleString()} • {file.isEncrypted ? 'Encrypted' : 'Public'}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <Button variant="ghost" size="sm" onClick={() => handleDownload(file.hash, file.isEncrypted)} className="gap-2">
                            <Download className="w-4 h-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => handleDelete(file.hash)} className="gap-2 text-red-400 hover:text-red-300">
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
                    <input type="file" multiple onChange={handleFileSelect} className="block w-full text-sm text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700" />
                  </div>

                  <div className="flex items-center gap-2 p-3 bg-slate-700 rounded-lg">
                    <input type="checkbox" id="encrypting" checked={isEncrypting} onChange={(e) => setIsEncrypting(e.target.checked)} className="w-4 h-4" />
                    <label htmlFor="encrypting" className="text-sm text-white">🔐 Encrypt files before upload (End-to-End Encryption)</label>
                  </div>

                  {isEncrypting && (
                    <div className="space-y-2">
                      <label className="block text-sm font-medium text-white">Encryption Key</label>
                      <Input type="password" placeholder="Enter a strong key..." value={tempEncryptionKey} onChange={(e) => setTempEncryptionKey(e.target.value)} className="bg-slate-700 border-slate-600 text-white" />
                    </div>
                  )}

                  <Button onClick={handleUpload} disabled={storage.isLoading} className="w-full gap-2" size="lg">
                    <Upload className="w-4 h-4" />
                    {storage.isLoading ? 'Uploading...' : `Upload ${selectedFiles.length} File(s)`}
                  </Button>
                </div>
              </Card>
            </TabsContent>

            <TabsContent value="stats" className="space-y-4">
              <Card className="p-6 bg-slate-800 border-slate-700">
                <h3 className="text-lg font-bold text-white mb-4">Decryption Settings</h3>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-white">Global Decryption Key</label>
                    <Input type="password" placeholder="Enter key to decrypt downloads..." value={decryptionKey} onChange={(e) => setDecryptionKey(e.target.value)} className="bg-slate-700 border-slate-600 text-white" />
                    <p className="text-xs text-slate-400">This key is used to decrypt files when you click the download button.</p>
                  </div>
                </div>
              </Card>
            </TabsContent>
          </Tabs>
        )}
      </main>
    </div>
  );
}
