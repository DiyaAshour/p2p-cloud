import { useEffect, useMemo, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useStorage } from '@/hooks/useStorage';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Activity,
  CheckCircle2,
  Cloud,
  Coins,
  Database,
  Download,
  Gauge,
  Globe2,
  HardDrive,
  KeyRound,
  Lock,
  LogOut,
  Search,
  Server,
  Shield,
  ShieldCheck,
  ShieldOff,
  ShoppingCart,
  Trash2,
  Upload,
  Wallet,
  Wifi,
} from 'lucide-react';
import { toast } from 'sonner';

const FREE_STORAGE_GB = 5;
const NETWORK_SHARE_OPTIONS = [25, 50, 100, 250, 500];

const paidPlans = [
  { name: 'Starter Node', size: '1 TB', price: '$1/mo', note: 'For personal encrypted backup' },
  { name: 'Builder', size: '3 TB', price: '$3/mo', note: 'More space for apps and media' },
  { name: 'Pro Storage', size: '5 TB', price: '$5/mo', note: 'Higher replication capacity' },
  { name: 'Network Whale', size: '10 TB', price: '$10/mo', note: 'Best value for heavy users' },
];

export default function Home() {
  const wallet = useWallet();
  const storage = useStorage();

  const [activeTab, setActiveTab] = useState('dashboard');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isIndexing, setIsIndexing] = useState(false);
  const [isEncrypting, setIsEncrypting] = useState(true);
  const [tempEncryptionKey, setTempEncryptionKey] = useState('');
  const [decryptionKey, setDecryptionKey] = useState('');
  const [acceptedNodeTerms, setAcceptedNodeTerms] = useState(false);
  const [sharedSpaceGb, setSharedSpaceGb] = useState(25);

  useEffect(() => {
    storage.refreshFiles();
  }, []);

  const usedStorageGb = useMemo(() => {
    return storage.files.reduce((total, file) => total + file.size / 1024 / 1024 / 1024, 0);
  }, [storage.files]);

  const selectedUploadGb = useMemo(() => {
    return selectedFiles.reduce((total, file) => total + file.size / 1024 / 1024 / 1024, 0);
  }, [selectedFiles]);

  const freeUsagePercent = Math.min(100, (usedStorageGb / FREE_STORAGE_GB) * 100);
  const encryptedFiles = storage.files.filter((file) => file.isEncrypted).length;
  const publicFiles = storage.files.length - encryptedFiles;

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

    if (!acceptedNodeTerms) {
      toast.error('Please activate your node and approve storage sharing first');
      setActiveTab('node');
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
      setIsEncrypting(true);
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
      toast.error('Please enter the decryption key in Security tab');
      setActiveTab('security');
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

  const activateNode = () => {
    setAcceptedNodeTerms(true);
    toast.success(`Node activated with ${sharedSpaceGb} GB shared storage`);
  };

  return (
    <div className="min-h-screen bg-[#070b16] text-white">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_left,rgba(37,99,235,0.22),transparent_35%),radial-gradient(circle_at_bottom_right,rgba(20,184,166,0.16),transparent_30%)]" />

      <div className="relative mx-auto flex min-h-screen max-w-[1500px]">
        <aside className="hidden w-72 shrink-0 border-r border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl lg:block">
          <div className="mb-8 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-600 shadow-lg shadow-blue-600/30">
              <Cloud className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-lg font-bold">P2P Cloud</h1>
              <p className="text-xs text-slate-400">Encrypted Storage Browser</p>
            </div>
          </div>

          <div className="mb-6 rounded-2xl border border-white/10 bg-slate-950/70 p-4">
            <div className="mb-3 flex items-center justify-between text-sm">
              <span className="text-slate-400">Free storage</span>
              <span className="font-semibold">{usedStorageGb.toFixed(2)} / {FREE_STORAGE_GB} GB</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-800">
              <div className="h-full rounded-full bg-blue-500" style={{ width: `${freeUsagePercent}%` }} />
            </div>
            <p className="mt-3 text-xs text-slate-500">After 5 GB, users need paid P2P network storage.</p>
          </div>

          <nav className="space-y-2 text-sm">
            {[
              ['dashboard', 'Dashboard', Gauge],
              ['browser', 'My Files', Database],
              ['upload', 'Upload', Upload],
              ['node', 'Node Setup', Server],
              ['plans', 'Buy Storage', ShoppingCart],
              ['security', 'Security', KeyRound],
            ].map(([value, label, Icon]) => (
              <button
                key={value as string}
                onClick={() => setActiveTab(value as string)}
                className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition ${
                  activeTab === value ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-white'
                }`}
              >
                <Icon className="h-4 w-4" />
                {label as string}
              </button>
            ))}
          </nav>
        </aside>

        <main className="flex-1 p-4 md:p-8">
          <header className="mb-6 rounded-3xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur-xl md:p-6">
            <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-emerald-300">
                    <Wifi className="mr-1 inline h-3 w-3" /> P2P prototype
                  </span>
                  <span className="rounded-full border border-blue-400/30 bg-blue-400/10 px-3 py-1 text-blue-300">
                    <ShieldCheck className="mr-1 inline h-3 w-3" /> E2E encrypted by default
                  </span>
                </div>
                <h2 className="text-2xl font-bold md:text-4xl">Private browser for decentralized cloud storage</h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
                  Users connect a wallet, approve sharing local disk space, upload 5 GB free, then buy more encrypted P2P storage when needed.
                </p>
              </div>

              <div className="flex items-center gap-3">
                {wallet.isConnected ? (
                  <>
                    <div className="rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-right">
                      <p className="text-xs text-slate-500">Wallet connected</p>
                      <p className="font-mono text-sm">{wallet.address?.slice(0, 6)}...{wallet.address?.slice(-4)}</p>
                    </div>
                    <Button variant="outline" onClick={wallet.disconnect} className="gap-2 border-white/15 bg-white/5 text-white hover:bg-white/10">
                      <LogOut className="h-4 w-4" /> Disconnect
                    </Button>
                  </>
                ) : (
                  <Button onClick={wallet.connect} disabled={wallet.isLoading} className="gap-2 bg-blue-600 hover:bg-blue-700">
                    <Wallet className="h-4 w-4" /> {wallet.isLoading ? 'Connecting...' : 'Connect Wallet'}
                  </Button>
                )}
              </div>
            </div>
          </header>

          {!wallet.isConnected ? (
            <Card className="rounded-3xl border-white/10 bg-white/[0.04] p-10 text-center text-white">
              <Wallet className="mx-auto mb-4 h-16 w-16 text-blue-300" />
              <h2 className="mb-2 text-2xl font-bold">Start with wallet login</h2>
              <p className="mx-auto mb-6 max-w-xl text-slate-400">
                The wallet becomes the user account. Later, payments, storage plans, node rewards, and ownership proofs can all connect to this address.
              </p>
              <Button onClick={wallet.connect} disabled={wallet.isLoading} size="lg" className="bg-blue-600 hover:bg-blue-700">
                {wallet.isLoading ? 'Connecting...' : 'Connect MetaMask'}
              </Button>
            </Card>
          ) : (
            <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
              <TabsList className="grid h-auto grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-2 lg:hidden">
                <TabsTrigger value="dashboard">Home</TabsTrigger>
                <TabsTrigger value="browser">Files</TabsTrigger>
                <TabsTrigger value="upload">Upload</TabsTrigger>
              </TabsList>

              <TabsContent value="dashboard" className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <MetricCard icon={Database} label="Stored files" value={storage.files.length.toString()} detail={`${encryptedFiles} encrypted / ${publicFiles} indexed`} />
                  <MetricCard icon={HardDrive} label="Used free quota" value={`${usedStorageGb.toFixed(2)} GB`} detail={`${FREE_STORAGE_GB} GB free included`} />
                  <MetricCard icon={Server} label="Shared node space" value={`${sharedSpaceGb} GB`} detail={acceptedNodeTerms ? 'Node active' : 'Waiting approval'} />
                  <MetricCard icon={Coins} label="Base price" value="$1 / TB" detail="Prototype pricing model" />
                </div>

                <div className="grid gap-6 xl:grid-cols-[1.4fr_0.9fr]">
                  <Card className="rounded-3xl border-white/10 bg-white/[0.04] p-6 text-white">
                    <h3 className="mb-4 text-xl font-bold">Product flow</h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      {[
                        ['1', 'Connect wallet', 'Wallet works as login and payment identity.'],
                        ['2', 'Approve node storage', 'Every user contributes computer storage to the network.'],
                        ['3', 'Upload encrypted files', 'Files can stay private or be indexed for network search.'],
                        ['4', 'Buy more space', 'After 5 GB free, user upgrades through wallet payment.'],
                      ].map(([step, title, body]) => (
                        <div key={step} className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                          <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-sm font-bold">{step}</div>
                          <h4 className="font-semibold">{title}</h4>
                          <p className="mt-1 text-sm text-slate-400">{body}</p>
                        </div>
                      ))}
                    </div>
                  </Card>

                  <Card className="rounded-3xl border-white/10 bg-white/[0.04] p-6 text-white">
                    <h3 className="mb-4 text-xl font-bold">Node status</h3>
                    <div className="space-y-4">
                      <StatusRow label="Wallet" active={wallet.isConnected} />
                      <StatusRow label="Storage sharing approval" active={acceptedNodeTerms} />
                      <StatusRow label="Encryption default" active={isEncrypting} />
                      <StatusRow label="Network indexing optional" active={isIndexing} />
                    </div>
                    <Button onClick={() => setActiveTab('node')} className="mt-6 w-full bg-blue-600 hover:bg-blue-700">
                      Configure node
                    </Button>
                  </Card>
                </div>
              </TabsContent>

              <TabsContent value="browser" className="space-y-4">
                <Card className="rounded-3xl border-white/10 bg-white/[0.04] p-6 text-white">
                  <div className="mb-6 flex flex-col gap-3 md:flex-row">
                    <Input
                      placeholder="Search by file name, hash, or indexed metadata..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="border-white/10 bg-slate-950/70 text-white placeholder:text-slate-500"
                    />
                    <Button onClick={handleSearch} className="gap-2 bg-blue-600 hover:bg-blue-700">
                      <Search className="h-4 w-4" /> Search
                    </Button>
                  </div>

                  {storage.files.length === 0 ? (
                    <div className="rounded-3xl border border-dashed border-white/15 bg-slate-950/50 py-16 text-center">
                      <Cloud className="mx-auto mb-4 h-14 w-14 text-slate-500" />
                      <p className="text-slate-400">No files yet. Upload your first encrypted file.</p>
                      <Button onClick={() => setActiveTab('upload')} className="mt-5 bg-blue-600 hover:bg-blue-700">Upload file</Button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {storage.files.map((file) => (
                        <div key={file.hash} className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4 md:flex-row md:items-center md:justify-between">
                          <div className="flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-semibold">{file.name}</p>
                              {file.isEncrypted ? <Shield className="h-4 w-4 text-blue-300" /> : <ShieldOff className="h-4 w-4 text-slate-500" />}
                              <span className="rounded-full bg-white/10 px-2 py-1 text-xs text-slate-300">{file.isEncrypted ? 'Encrypted' : 'Indexed public'}</span>
                            </div>
                            <p className="mt-1 text-xs text-slate-500">
                              {(file.size / 1024 / 1024).toFixed(2)} MB • {new Date(file.uploadedAt).toLocaleString()} • {file.hash.slice(0, 18)}...
                            </p>
                          </div>
                          <div className="flex gap-2">
                            <Button variant="outline" size="sm" onClick={() => handleDownload(file.hash, file.isEncrypted)} className="border-white/10 bg-white/5 text-white hover:bg-white/10">
                              <Download className="h-4 w-4" />
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => handleDelete(file.hash)} className="border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20">
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
                <Card className="rounded-3xl border-white/10 bg-white/[0.04] p-6 text-white">
                  <div className="grid gap-6 xl:grid-cols-[1fr_0.8fr]">
                    <div>
                      <h3 className="mb-2 text-xl font-bold">Upload to encrypted P2P storage</h3>
                      <p className="mb-6 text-sm text-slate-400">Files are private by default. Turn on indexing only when the user wants the file searchable in the network.</p>

                      <label className="flex cursor-pointer flex-col items-center justify-center rounded-3xl border border-dashed border-blue-400/40 bg-blue-500/5 p-10 text-center hover:bg-blue-500/10">
                        <Upload className="mb-3 h-12 w-12 text-blue-300" />
                        <span className="font-semibold">Choose files from your computer</span>
                        <span className="mt-1 text-sm text-slate-400">Selected: {selectedFiles.length} file(s), {selectedUploadGb.toFixed(3)} GB</span>
                        <input type="file" multiple onChange={handleFileSelect} className="hidden" />
                      </label>
                    </div>

                    <div className="space-y-4 rounded-3xl border border-white/10 bg-slate-950/60 p-5">
                      <ToggleRow title="End-to-end encryption" description="Recommended. User keeps the secret key." active={isEncrypting} onChange={setIsEncrypting} />
                      {isEncrypting && (
                        <Input
                          type="password"
                          placeholder="Encryption key"
                          value={tempEncryptionKey}
                          onChange={(e) => setTempEncryptionKey(e.target.value)}
                          className="border-white/10 bg-slate-900 text-white"
                        />
                      )}
                      <ToggleRow title="Index for network search" description="Makes metadata discoverable, not recommended for private files." active={isIndexing} onChange={setIsIndexing} />
                      <Button onClick={handleUpload} disabled={storage.isLoading} className="w-full gap-2 bg-blue-600 hover:bg-blue-700" size="lg">
                        <Upload className="h-4 w-4" /> {storage.isLoading ? 'Uploading...' : 'Upload to P2P Network'}
                      </Button>
                    </div>
                  </div>
                </Card>
              </TabsContent>

              <TabsContent value="node" className="space-y-4">
                <Card className="rounded-3xl border-white/10 bg-white/[0.04] p-6 text-white">
                  <div className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
                    <div>
                      <h3 className="mb-2 text-2xl font-bold">Activate this computer as a storage node</h3>
                      <p className="mb-6 text-slate-400">This is the core idea: anyone using the browser agrees to contribute part of their disk to host encrypted chunks for other users.</p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {NETWORK_SHARE_OPTIONS.map((gb) => (
                          <button
                            key={gb}
                            onClick={() => setSharedSpaceGb(gb)}
                            className={`rounded-2xl border p-4 text-left transition ${sharedSpaceGb === gb ? 'border-blue-400 bg-blue-500/20' : 'border-white/10 bg-slate-950/60 hover:bg-white/5'}`}
                          >
                            <HardDrive className="mb-3 h-5 w-5 text-blue-300" />
                            <div className="text-xl font-bold">{gb} GB</div>
                            <div className="text-sm text-slate-400">shared network space</div>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-3xl border border-white/10 bg-slate-950/60 p-5">
                      <h4 className="mb-4 font-bold">Required consent</h4>
                      <div className="space-y-3 text-sm text-slate-300">
                        <p><CheckCircle2 className="mr-2 inline h-4 w-4 text-emerald-300" />Encrypted chunks from other users may be stored locally.</p>
                        <p><CheckCircle2 className="mr-2 inline h-4 w-4 text-emerald-300" />The app can reserve selected disk space for the network.</p>
                        <p><CheckCircle2 className="mr-2 inline h-4 w-4 text-emerald-300" />Future smart contract rewards can pay active host nodes.</p>
                      </div>
                      <Button onClick={activateNode} className="mt-6 w-full bg-emerald-600 hover:bg-emerald-700">
                        {acceptedNodeTerms ? 'Node active' : 'Approve and activate node'}
                      </Button>
                    </div>
                  </div>
                </Card>
              </TabsContent>

              <TabsContent value="plans" className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  {paidPlans.map((plan) => (
                    <Card key={plan.name} className="rounded-3xl border-white/10 bg-white/[0.04] p-5 text-white">
                      <Globe2 className="mb-4 h-8 w-8 text-blue-300" />
                      <h3 className="font-bold">{plan.name}</h3>
                      <div className="mt-4 text-3xl font-bold">{plan.size}</div>
                      <div className="text-blue-300">{plan.price}</div>
                      <p className="mt-3 min-h-10 text-sm text-slate-400">{plan.note}</p>
                      <Button className="mt-5 w-full gap-2 bg-blue-600 hover:bg-blue-700">
                        <Wallet className="h-4 w-4" /> Buy with wallet
                      </Button>
                    </Card>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="security" className="space-y-4">
                <Card className="rounded-3xl border-white/10 bg-white/[0.04] p-6 text-white">
                  <div className="max-w-2xl">
                    <Lock className="mb-4 h-10 w-10 text-blue-300" />
                    <h3 className="mb-2 text-2xl font-bold">Security and recovery keys</h3>
                    <p className="mb-6 text-slate-400">Encrypted files need the same key during download. Later this should become per-file key management, not one global input.</p>
                    <Input
                      type="password"
                      placeholder="Global decryption key"
                      value={decryptionKey}
                      onChange={(e) => setDecryptionKey(e.target.value)}
                      className="border-white/10 bg-slate-950/70 text-white"
                    />
                  </div>
                </Card>
              </TabsContent>
            </Tabs>
          )}
        </main>
      </div>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, detail }: { icon: typeof Activity; label: string; value: string; detail: string }) {
  return (
    <Card className="rounded-3xl border-white/10 bg-white/[0.04] p-5 text-white">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-500/15 text-blue-300">
        <Icon className="h-5 w-5" />
      </div>
      <p className="text-sm text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </Card>
  );
}

function StatusRow({ label, active }: { label: string; active: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-slate-950/60 p-3">
      <span className="text-sm text-slate-300">{label}</span>
      <span className={`rounded-full px-3 py-1 text-xs ${active ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-400/10 text-amber-300'}`}>
        {active ? 'Active' : 'Pending'}
      </span>
    </div>
  );
}

function ToggleRow({ title, description, active, onChange }: { title: string; description: string; active: boolean; onChange: (value: boolean) => void }) {
  return (
    <button onClick={() => onChange(!active)} className="flex w-full items-center justify-between gap-4 rounded-2xl border border-white/10 bg-slate-900/80 p-4 text-left hover:bg-slate-900">
      <div>
        <p className="font-semibold">{title}</p>
        <p className="mt-1 text-xs text-slate-400">{description}</p>
      </div>
      <span className={`h-6 w-11 rounded-full p-1 transition ${active ? 'bg-blue-600' : 'bg-slate-700'}`}>
        <span className={`block h-4 w-4 rounded-full bg-white transition ${active ? 'translate-x-5' : 'translate-x-0'}`} />
      </span>
    </button>
  );
}
