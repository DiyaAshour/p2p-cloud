import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Building2,
  Cloud,
  Download,
  Eye,
  EyeOff,
  FileCheck2,
  FolderOpen,
  HardDrive,
  KeyRound,
  Lock,
  Pencil,
  RefreshCw,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Trash2,
  Upload,
  UserPlus,
  Users,
  Wallet,
  Wifi,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

type Channel =
  | "p2p:start"
  | "p2p:listFiles"
  | "p2p:uploadFiles"
  | "p2p:downloadToPath"
  | "p2p:delete"
  | "p2p:networkSummary"
  | "p2p:prepareProof"
  | "wallet:status"
  | "wallet:connect"
  | "wallet:disconnect"
  | "company:state"
  | "company:deviceIdentity"
  | "company:createWorkspace"
  | "company:inviteMember"
  | "company:changeMemberRole"
  | "company:removeMember"
  | "company:addFile"
  | "company:updateFile";

type Bridge = { invoke: <T>(channel: Channel, payload?: unknown) => Promise<T> };
type Plan = { id: string; name: string; quotaBytes: number; priceUsd: number };
type WalletState = {
  connected: boolean;
  address: string;
  planId?: string;
  accountId?: string;
  authMode?: "wallet" | "seed" | null;
  username?: string | null;
  seedFingerprint?: string | null;
  usedBytes: number;
  remainingBytes: number;
  plan: Plan;
  plans: Plan[];
  minDrivePasswordLength?: number;
};
type Summary = { totalFiles: number; encryptedFiles: number; totalBytes: number; connectedPeers: number; safetyPeerUrl?: string };
type Role = "owner" | "admin" | "manager" | "editor" | "viewer" | "guest";
type DeviceIdentity = { deviceId: string; displayName?: string; email?: string };
type Member = { memberId: string; deviceId: string; email: string; displayName?: string; role: Role; status: "active" | "invited"; inviteToken?: string };
type CompanyFile = { fileId: string; rootHash: string; hash?: string; name: string; size: number; totalChunks: number; folder?: string; uploadedAt: string; uploadedByDeviceId: string; uploadedByName?: string; hidden?: boolean; deleted?: boolean };
type Workspace = { workspaceId: string; name: string; ownerWallet?: string; signatureValid?: boolean; members: Member[]; files: CompanyFile[]; createdAt: string; updatedAt?: string };
type CompanyState = { ok: boolean; deviceIdentity: DeviceIdentity; workspaces: Workspace[] };
type P2PFile = { id?: string; name: string; size: number; hash: string; rootHash: string; uploadedAt: string; isEncrypted: boolean; totalChunks: number; ownerWallet?: string; replicas?: string[]; replicationStatus?: string; protectedChunks?: number; needsRepairChunks?: number };
type View = "personal" | "company" | "shared" | "admin";

declare global {
  interface Window {
    electron?: Bridge;
  }
}

const ALL_FILES = "All files";
const UNCATEGORIZED = "Uncategorized";
const FILE_FOLDERS_KEY = "chunknet.ui.fileFolders";
const ACTIVE_WORKSPACE_KEY = "chunknet.ui.activeWorkspace";

function getBridge(): Bridge | null {
  return typeof window !== "undefined" && typeof window.electron?.invoke === "function" ? window.electron : null;
}
function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function identityStorageId(wallet: WalletState | null) {
  if (!wallet?.connected) return "guest";
  if (wallet.authMode === "seed") return `seed:${wallet.accountId || wallet.seedFingerprint || wallet.username || "unknown"}`;
  return `wallet:${wallet.address || wallet.accountId || "unknown"}`;
}
function personalFolderKey(folder: string) { return `personal:folder:${folder}`; }
function companyFolderKey(workspaceId: string, folder: string) { return `company:${workspaceId}:folder:${folder}`; }
function bytes(n = 0) {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(2)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${n} B`;
}
function short(value = "") {
  return value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "Guest";
}
function date(value?: string) {
  const d = new Date(value || "");
  return Number.isNaN(d.getTime()) ? "unknown" : d.toLocaleString();
}
function err(error: unknown) {
  return error instanceof Error ? error.message : "Operation failed";
}
function canManage(role?: Role | null) {
  return role === "owner" || role === "admin" || role === "manager";
}
function canUpload(role?: Role | null) {
  return role === "owner" || role === "admin" || role === "manager" || role === "editor";
}
function keyFor(file: P2PFile) {
  return file.rootHash || file.hash;
}
function fileKeyMatches(companyFile: CompanyFile, file: P2PFile) {
  return companyFile.rootHash === file.rootHash || companyFile.hash === file.hash || companyFile.rootHash === file.hash;
}
function protection(file: P2PFile) {
  const status = file.replicationStatus || "protecting";
  if (status === "protected") return { label: "Protected", tone: "text-emerald-300", details: `${file.protectedChunks ?? file.totalChunks}/${file.totalChunks} chunks` };
  if (status === "needs-repair") return { label: "Needs repair", tone: "text-amber-300", details: `${file.needsRepairChunks ?? 0} chunk(s) need repair` };
  return { label: "Protecting", tone: "text-blue-300", details: `${file.protectedChunks ?? 0}/${file.totalChunks} protected` };
}

export default function NativeP2PAppLive() {
  const api = getBridge();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [files, setFiles] = useState<P2PFile[]>([]);
  const [company, setCompany] = useState<CompanyState | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>("personal");
  const [search, setSearch] = useState("");
  const [isEncrypted, setIsEncrypted] = useState(true);
  const [drivePassword, setDrivePassword] = useState("");
  const [activeFolder, setActiveFolder] = useState(ALL_FILES);
  const [newFolder, setNewFolder] = useState("");
  const [workspaceNameInput, setWorkspaceNameInput] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<Role>("viewer");
  const [fileFolders, setFileFolders] = useState<Record<string, string>>({});
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => readJson(ACTIVE_WORKSPACE_KEY, ""));

  const walletConnected = Boolean(wallet?.connected && (wallet.accountId || wallet.address));
  const identityLabel = wallet?.authMode === "seed" ? `Seed: ${wallet.username || short(wallet.accountId || wallet.address)}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";
  const folderStorageKey = `${FILE_FOLDERS_KEY}.${identityStorageId(wallet)}`;
  const workspaces = company?.workspaces || [];
  const activeWorkspace = workspaces.find((w) => w.workspaceId === activeWorkspaceId) || workspaces[0] || null;
  const deviceId = company?.deviceIdentity?.deviceId || "";
  const localMember = activeWorkspace?.members?.find((m) => m.deviceId === deviceId) || null;
  const localRole = localMember?.role || null;
  const minPasswordLength = wallet?.minDrivePasswordLength || 12;
  const peerCount = (summary?.connectedPeers || 0) + (summary?.safetyPeerUrl ? 1 : 0);
  const quota = wallet?.plan?.quotaBytes ? Math.min(100, (wallet.usedBytes / wallet.plan.quotaBytes) * 100) : 0;

  const companyFileByKey = useMemo(() => {
    const map = new Map<string, { workspace: Workspace; companyFile: CompanyFile }>();
    for (const workspace of workspaces) {
      for (const companyFile of workspace.files || []) {
        if (companyFile.deleted) continue;
        map.set(companyFile.rootHash, { workspace, companyFile });
        if (companyFile.hash) map.set(companyFile.hash, { workspace, companyFile });
      }
    }
    return map;
  }, [workspaces]);

  const personalFiles = useMemo(() => files.filter((file) => !companyFileByKey.has(keyFor(file)) && !companyFileByKey.has(file.hash)), [files, companyFileByKey]);
  const companyFiles = useMemo(() => {
    if (!activeWorkspace) return [];
    const allowed = (activeWorkspace.files || []).filter((file) => !file.deleted);
    return files.filter((file) => allowed.some((companyFile) => fileKeyMatches(companyFile, file)));
  }, [files, activeWorkspace]);
  const sharedFiles = useMemo(() => files.filter((file) => companyFileByKey.has(keyFor(file)) || companyFileByKey.has(file.hash)), [files, companyFileByKey]);
  const folders = useMemo(() => {
    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];
    const personalFileKeys = new Set(personalFiles.map((file) => file.hash));
    const personalFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith("personal:folder:") || personalFileKeys.has(key)).map(([, folder]) => folder).filter(Boolean);
    const companyPrefix = activeWorkspace ? `company:${activeWorkspace.workspaceId}:folder:` : "company:none:folder:";
    const companyFolders = Object.entries(fileFolders).filter(([key]) => key.startsWith(companyPrefix)).map(([, folder]) => folder).filter(Boolean);
    const sourceFolders = view === "company" || view === "admin" ? [...workspaceFolders, ...companyFolders] : personalFolders;
    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];
  }, [fileFolders, activeWorkspace, personalFiles, view]);
  const baseFiles = view === "company" || view === "admin" ? companyFiles : view === "shared" ? sharedFiles : personalFiles;
  const visibleFiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return baseFiles.filter((file) => {
      const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);
      const cf = match?.companyFile;
      const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;
      const displayName = cf?.name || file.name;
      const folderOk = activeFolder === ALL_FILES || activeFolder === folder;
      const queryOk = !q || [displayName, file.hash, file.rootHash, folder, match?.workspace.name, file.replicationStatus].some((value) => String(value || "").toLowerCase().includes(q));
      return folderOk && queryOk;
    });
  }, [baseFiles, search, activeFolder, fileFolders, companyFileByKey]);

  const companyBytes = companyFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
  const protectedCompanyFiles = companyFiles.filter((file) => file.replicationStatus === "protected").length;
  const repairCompanyFiles = companyFiles.filter((file) => file.replicationStatus === "needs-repair").length;

  useEffect(() => {
    setFileFolders(readJson(folderStorageKey, {}));
    setActiveFolder(ALL_FILES);
  }, [folderStorageKey]);
  useEffect(() => {
    localStorage.setItem(folderStorageKey, JSON.stringify(fileFolders));
  }, [fileFolders, folderStorageKey]);
  useEffect(() => {
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify(activeWorkspace?.workspaceId || ""));
  }, [activeWorkspace?.workspaceId]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast.error(err(error));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!api) return;
    const [nextSummary, nextFiles, nextWallet, nextCompany] = await Promise.all([
      api.invoke<Summary>("p2p:networkSummary"),
      api.invoke<P2PFile[]>("p2p:listFiles", { query: search }),
      api.invoke<WalletState>("wallet:status"),
      api.invoke<CompanyState>("company:state"),
    ]);
    setSummary(nextSummary);
    setFiles(Array.isArray(nextFiles) ? nextFiles : []);
    setWallet(nextWallet);
    setCompany(nextCompany);
    if (!activeWorkspaceId && nextCompany.workspaces?.[0]?.workspaceId) setActiveWorkspaceId(nextCompany.workspaces[0].workspaceId);
  };

  useEffect(() => {
    if (!api) return;
    void run(async () => {
      await api.invoke("p2p:start");
      await api.invoke("company:deviceIdentity", {});
      await refresh();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!api) {
    return <div className="min-h-screen bg-zinc-950 p-8 text-zinc-50">Electron required. Run pnpm run electron:dev</div>;
  }

  const password = () => {
    if (!isEncrypted) return null;
    const value = drivePassword.trim();
    if (value.length < minPasswordLength) throw new Error(`Drive Password must be at least ${minPasswordLength} characters.`);
    return value;
  };

  const connectWallet = () => run(async () => {
    const address = window.prompt("Wallet address 0x...")?.trim();
    if (!address) return;
    setWallet(await api.invoke<WalletState>("wallet:connect", { address }));
    await refresh();
  });
  const disconnectWallet = () => run(async () => {
    setWallet(await api.invoke<WalletState>("wallet:disconnect"));
    await refresh();
  });
  const createWorkspace = () => run(async () => {
    const name = workspaceNameInput.trim();
    if (!name) return;
    const ws = await api.invoke<Workspace>("company:createWorkspace", { name, ownerWallet: wallet?.address || wallet?.accountId || "" });
    setActiveWorkspaceId(ws.workspaceId);
    setWorkspaceNameInput("");
    setView("company");
    await refresh();
    toast.success("Company workspace created and signed");
  });
  const inviteMember = () => run(async () => {
    if (!activeWorkspace) throw new Error("Select a company first");
    const email = memberEmail.trim();
    if (!email) return;
    const result = await api.invoke<{ workspace: Workspace; inviteToken: string }>("company:inviteMember", { workspaceId: activeWorkspace.workspaceId, email, role: memberRole });
    await navigator.clipboard.writeText(result.inviteToken);
    setMemberEmail("");
    await refresh();
    toast.success("Invite token copied. Email sending comes later.");
  });
  const changeMemberRole = (memberId: string, role: Role) => run(async () => {
    if (!activeWorkspace) return;
    await api.invoke("company:changeMemberRole", { workspaceId: activeWorkspace.workspaceId, memberId, role });
    await refresh();
  });
  const removeMember = (memberId: string) => run(async () => {
    if (!activeWorkspace) return;
    await api.invoke("company:removeMember", { workspaceId: activeWorkspace.workspaceId, memberId });
    await refresh();
  });
  const createFolder = () => {
    const folder = newFolder.trim();
    if (!folder) return;
    const key = (view === "company" || view === "admin") && activeWorkspace ? companyFolderKey(activeWorkspace.workspaceId, folder) : personalFolderKey(folder);
    setFileFolders((current) => ({ ...current, [key]: folder }));
    setActiveFolder(folder);
    setNewFolder("");
  };
  const upload = () => run(async () => {
    if (!walletConnected) throw new Error("Connect wallet or sign in with Seed Account before uploading");
    if ((view === "company" || view === "admin") && !activeWorkspace) throw new Error("Create or select a company first");
    if ((view === "company" || view === "admin") && !canUpload(localRole)) throw new Error("Your company role cannot upload files");
    const result = await api.invoke<{ cancelled?: boolean; files?: P2PFile[] }>("p2p:uploadFiles", {
      isEncrypted,
      drivePassword: password(),
      workspaceId: view === "company" || view === "admin" ? activeWorkspace?.workspaceId : null,
      folderPath: activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED ? "" : activeFolder,
    });
    if ((view === "company" || view === "admin") && activeWorkspace && result?.files?.length) {
      for (const file of result.files) {
        await api.invoke("company:addFile", { workspaceId: activeWorkspace.workspaceId, file, folder: activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED ? "" : activeFolder });
      }
    }
    if (!((view === "company" || view === "admin")) && activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED && result?.files?.length) {
      setFileFolders((current) => {
        const next = { ...current };
        for (const file of result.files || []) next[file.hash] = activeFolder;
        return next;
      });
    }
    if (!result?.cancelled) toast.success(`${result?.files?.length || 1} file(s) stored safely`);
    await refresh();
  });
  const download = (file: P2PFile) => run(async () => {
    const result = await api.invoke<{ cancelled?: boolean; path?: string }>("p2p:downloadToPath", { hash: file.hash, drivePassword: file.isEncrypted ? password() : null });
    if (!result?.cancelled) toast.success(result?.path ? `Downloaded to ${result.path}` : "Download complete");
    await refresh();
  });
  const renameCompanyFile = (file: P2PFile) => run(async () => {
    const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);
    if (!match) return;
    const name = window.prompt("New file name", match.companyFile.name || file.name)?.trim();
    if (!name) return;
    await api.invoke("company:updateFile", { workspaceId: match.workspace.workspaceId, rootHash: match.companyFile.rootHash, patch: { name } });
    await refresh();
  });
  const toggleHideCompanyFile = (file: P2PFile) => run(async () => {
    const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);
    if (!match) return;
    await api.invoke("company:updateFile", { workspaceId: match.workspace.workspaceId, rootHash: match.companyFile.rootHash, patch: { hidden: !match.companyFile.hidden } });
    await refresh();
  });
  const remove = (file: P2PFile) => run(async () => {
    const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);
    if (match) {
      await api.invoke("company:updateFile", { workspaceId: match.workspace.workspaceId, rootHash: match.companyFile.rootHash, patch: { deleted: true } });
      await refresh();
      toast.success("Removed from company manifest. Encrypted chunks were not changed.");
      return;
    }
    await api.invoke("p2p:delete", { hash: file.hash });
    await refresh();
  });
  const proof = (file: P2PFile) => run(async () => {
    const result = await api.invoke<{ proof: unknown }>("p2p:prepareProof", { hash: file.hash });
    await navigator.clipboard.writeText(JSON.stringify(result.proof, null, 2));
    toast.success("Proof copied");
  });
  const share = (file: P2PFile) => {
    const link = `chunknet://file/${file.rootHash || file.hash}`;
    void navigator.clipboard.writeText(link).then(() => toast.success("Share link copied"));
  };

  const renderFileCard = (file: P2PFile) => {
    const p = protection(file);
    const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);
    const cf = match?.companyFile;
    const displayName = cf?.name || file.name;
    const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;
    const role = match?.workspace.members.find((m) => m.deviceId === deviceId)?.role;
    const canControl = Boolean(cf && (cf.uploadedByDeviceId === deviceId || role === "owner" || role === "admin"));

    return (
      <Card key={file.hash} className="rounded-2xl border-zinc-800 bg-zinc-900">
        <CardContent className="space-y-4 p-5">
          <div className="flex h-24 items-center justify-center rounded-2xl bg-zinc-950"><FileCheck2 className="size-10" /></div>
          <div>
            <p className="truncate font-semibold">{displayName}</p>
            <p className="text-sm text-zinc-400">{bytes(file.size)} · {date(file.uploadedAt)}</p>
            <p className="text-xs text-zinc-500"><FolderOpen className="mr-1 inline size-3" />{folder}</p>
            {cf?.uploadedByName && <p className="text-xs text-zinc-500">Uploaded by: {cf.uploadedByName}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              {file.isEncrypted && <Badge variant="secondary"><Lock className="mr-1 size-3" />Encrypted</Badge>}
              <Badge variant="outline" className={p.tone}><ShieldCheck className="mr-1 size-3" />{p.label}</Badge>}
              {match && <Badge variant="outline"><Building2 className="mr-1 size-3" />{match.workspace.name}</Badge>}
              {cf?.hidden && <Badge variant="outline" className="text-amber-300"><EyeOff className="mr-1 size-3" />Hidden</Badge>}
            </div>
            <p className="mt-1 text-xs text-zinc-500">{p.details}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => download(file)} disabled={busy}><Download className="size-4" />Download</Button>
            <Button variant="outline" size="sm" onClick={() => share(file)} disabled={busy}><Share2 className="size-4" />Share</Button>
            {match && <Button variant="outline" size="sm" onClick={() => renameCompanyFile(file)} disabled={busy || !canControl}><Pencil className="size-4" />Rename</Button>}
            {match && <Button variant="outline" size="sm" onClick={() => toggleHideCompanyFile(file)} disabled={busy || !canControl}>{cf?.hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}{cf?.hidden ? "Unhide" : "Hide"}</Button>}
            <Button variant="outline" size="sm" onClick={() => proof(file)} disabled={busy}>Proof</Button>
            <Button variant="destructive" size="sm" onClick={() => remove(file)} disabled={busy || (Boolean(match) && !canControl)}><Trash2 className="size-4" />Delete</Button>
          </div>
          <select
            value={folder}
            onChange={(event) => {
              const nextFolder = event.target.value === UNCATEGORIZED ? "" : event.target.value;
              if (match) void api.invoke("company:updateFile", { workspaceId: match.workspace.workspaceId, rootHash: match.companyFile.rootHash, patch: { folder: nextFolder } }).then(refresh);
              else setFileFolders((current) => ({ ...current, [file.hash]: nextFolder }));
            }}
            className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm"
          >
            <option>{UNCATEGORIZED}</option>
            {folders.filter((folderName) => folderName !== ALL_FILES && folderName !== UNCATEGORIZED).map((folderName) => <option key={folderName}>{folderName}</option>)}
          </select>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50">