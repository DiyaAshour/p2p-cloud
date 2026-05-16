import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Wallet } from "lucide-react";
import { toast } from "sonner";
import { connectWalletWithWalletConnect } from "./walletConnect";

type WalletState = { connected: boolean; address: string; accountId?: string; authMode?: "wallet" | "seed" | null; username?: string | null; usedBytes: number; remainingBytes: number; plan: { id: string; name: string; quotaBytes: number; priceUsd: number }; plans: unknown[]; minDrivePasswordLength?: number };
type Bridge = { invoke: <T>(channel: string, payload?: unknown) => Promise<T> };

type Props = { api: Bridge; busy: boolean; identityLabel: string; walletConnected: boolean; onWallet: (wallet: WalletState) => void; onRefresh: () => Promise<void>; onDisconnect: () => void };

export default function IdentityAccountCard({ api, busy, identityLabel, walletConnected, onWallet, onRefresh, onDisconnect }: Props) {
  const [manualOpen, setManualOpen] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");
  const [mode, setMode] = useState<"login" | "create" | "recover">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [recovery, setRecovery] = useState("");
  const [createdCode, setCreatedCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [working, setWorking] = useState(false);

  async function run(task: () => Promise<void>) { setWorking(true); try { await task(); } catch (error) { toast.error(error instanceof Error ? error.message : "Operation failed"); } finally { setWorking(false); } }

  const connectWallet = () => run(async () => {
    const session = await connectWalletWithWalletConnect();
    const wallet = await api.invoke<WalletState>("wallet:connect", session);
    onWallet(wallet); setCreatedCode(""); setSaved(false); await onRefresh();
  });

  const connectManualWallet = () => run(async () => {
    const address = walletAddress.trim();
    if (!address) throw new Error("Enter wallet address first.");
    const wallet = await api.invoke<WalletState>("wallet:connect", { address });
    onWallet(wallet); setWalletAddress(""); setCreatedCode(""); setSaved(false); await onRefresh();
  });

  const submitAccount = () => run(async () => {
    if (createdCode && !saved) throw new Error("Save and confirm your recovery code first.");
    if (!username.trim() || !password.trim()) throw new Error("Username and password are required.");
    if (mode === "recover" && !recovery.trim()) throw new Error("Recovery code is required.");
    const channel = mode === "create" ? "seed:create" : mode === "recover" ? "seed:recover" : "seed:login";
    const payload = mode === "recover" ? { username: username.trim(), password: password.trim(), seed: recovery.trim() } : { username: username.trim(), password: password.trim() };
    const wallet = await api.invoke<WalletState & { seed?: string }>(channel, payload);
    onWallet(wallet); setCreatedCode(wallet.seed || ""); setSaved(false); if (!wallet.seed) { setPassword(""); setRecovery(""); } await onRefresh();
    toast.success(mode === "create" ? "Account created. Save your recovery code." : mode === "recover" ? "Account recovered." : "Signed in.");
  });

  return (
    <Card className="rounded-2xl border-zinc-800 bg-zinc-900">
      <CardContent className="space-y-4 p-5">
        <p className="text-sm text-zinc-400">Identity</p>
        <p className="truncate font-medium">{identityLabel}</p>
        {walletConnected ? <Button variant="outline" onClick={onDisconnect} disabled={busy || working}>Disconnect</Button> : <div className="space-y-2"><Button className="w-full" onClick={connectWallet} disabled={busy || working}><Wallet className="size-4" />Connect Wallet / QR</Button><button type="button" onClick={() => setManualOpen((value) => !value)} className="text-xs text-zinc-500 hover:text-zinc-300">Manual address fallback</button>{manualOpen && <div className="space-y-2"><Input value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} placeholder="Wallet address 0x..." /><Button className="w-full" variant="outline" onClick={connectManualWallet} disabled={busy || working}>Use manual address</Button></div>}</div>}
        <div className="border-t border-zinc-800 pt-4">
          <p className="mb-2 text-sm font-medium">Username Account</p>
          <div className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-zinc-950 p-1 text-xs">{(["login", "create", "recover"] as const).map((item) => <button key={item} type="button" onClick={() => setMode(item)} className={`rounded-lg px-2 py-2 ${mode === item ? "bg-zinc-800" : "text-zinc-500"}`}>{item}</button>)}</div>
          <div className="space-y-2"><Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" /><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "recover" ? "New password" : "Password"} />{mode === "recover" && <Input value={recovery} onChange={(e) => setRecovery(e.target.value)} placeholder="Recovery code" />}{createdCode && <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3"><p className="text-xs font-medium text-amber-200">Recovery code — save it now</p><p className="mt-2 break-all rounded-lg bg-zinc-950 p-2 text-xs">{createdCode}</p><Button className="mt-2 w-full" size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(createdCode).then(() => toast.success("Copied"))}>Copy</Button><label className="mt-3 flex items-start gap-2 text-xs text-amber-100"><Checkbox checked={saved} onCheckedChange={(v) => setSaved(Boolean(v))} /><span>I saved it.</span></label></div>}<Button className="w-full" variant="outline" onClick={submitAccount} disabled={busy || working || Boolean(createdCode && !saved)}>{createdCode && !saved ? "Confirm saved first" : mode === "create" ? "Create Account" : mode === "recover" ? "Recover Account" : "Login"}</Button></div>
        </div>
      </CardContent>
    </Card>
  );
}
