import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { KeyRound, ShieldCheck, UserPlus, ClipboardCheck, Building2 } from "lucide-react";
import { toast } from "sonner";

type OfflineChannel = "company:createJoinRequest" | "company:approveJoinRequest" | "company:exportWorkspaceAccess" | "company:importWorkspaceAccess";
type Bridge = { invoke: <T>(channel: OfflineChannel, payload?: unknown) => Promise<T> };
type Workspace = { workspaceId: string; name: string };

type Props = {
  api: Bridge;
  activeWorkspace?: Workspace | null;
  busy?: boolean;
  onDone?: () => Promise<void> | void;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Operation failed";
}

async function copy(text: string, message: string) {
  await navigator.clipboard.writeText(text);
  toast.success(message);
}

export default function CompanyOfflineJoinPanel({ api, activeWorkspace, busy, onDone }: Props) {
  const [inviteToken, setInviteToken] = useState("");
  const [joinRequestToken, setJoinRequestToken] = useState("");
  const [workspaceAccessToken, setWorkspaceAccessToken] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [working, setWorking] = useState(false);

  const run = async (task: () => Promise<void>) => {
    setWorking(true);
    try {
      await task();
      await onDone?.();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Card className="rounded-2xl border-zinc-800 bg-zinc-900">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5" /> Offline company join
          <Badge variant="outline">No server</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
          <div className="flex items-center gap-2 font-medium"><UserPlus className="size-4" /> Employee side</div>
          <p className="text-xs text-zinc-500">Paste the invite token from the company admin. This device creates a signed join request.</p>
          <div className="space-y-2">
            <Label>Invite token</Label>
            <Input value={inviteToken} onChange={(e) => setInviteToken(e.target.value)} placeholder="chunknet://invite/..." />
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name" />
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email optional" />
          </div>
          <Button
            disabled={busy || working || !inviteToken.trim()}
            onClick={() => run(async () => {
              const result = await api.invoke<{ joinRequestToken: string }>("company:createJoinRequest", { inviteToken, displayName, email });
              setJoinRequestToken(result.joinRequestToken);
              await copy(result.joinRequestToken, "Join request copied. Send it to the admin.");
            })}
          >
            <KeyRound className="size-4" /> Generate join request
          </Button>
          {joinRequestToken && <Input readOnly value={joinRequestToken} onFocus={(e) => e.currentTarget.select()} />}
        </div>

        <div className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
          <div className="flex items-center gap-2 font-medium"><ClipboardCheck className="size-4" /> Admin side</div>
          <p className="text-xs text-zinc-500">Paste the employee join request. Admin approval returns a workspace access token.</p>
          <div className="space-y-2">
            <Label>Join request token</Label>
            <Input value={joinRequestToken} onChange={(e) => setJoinRequestToken(e.target.value)} placeholder="chunknet://join-request/..." />
          </div>
          <Button
            disabled={busy || working || !joinRequestToken.trim()}
            onClick={() => run(async () => {
              const result = await api.invoke<{ workspaceAccessToken: string }>("company:approveJoinRequest", { joinRequestToken });
              setWorkspaceAccessToken(result.workspaceAccessToken);
              await copy(result.workspaceAccessToken, "Workspace access copied. Send it back to the employee.");
            })}
          >
            <ShieldCheck className="size-4" /> Approve join request
          </Button>
          <Button
            variant="outline"
            disabled={busy || working || !activeWorkspace?.workspaceId}
            onClick={() => run(async () => {
              const result = await api.invoke<{ workspaceAccessToken: string }>("company:exportWorkspaceAccess", { workspaceId: activeWorkspace?.workspaceId });
              setWorkspaceAccessToken(result.workspaceAccessToken);
              await copy(result.workspaceAccessToken, "Workspace access copied.");
            })}
          >
            <Building2 className="size-4" /> Export current workspace access
          </Button>
        </div>

        <div className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-950 p-4 lg:col-span-2">
          <div className="flex items-center gap-2 font-medium"><Building2 className="size-4" /> Employee final step</div>
          <p className="text-xs text-zinc-500">After admin approval, paste the workspace access token here to join the company on this device.</p>
          <div className="space-y-2">
            <Label>Workspace access token</Label>
            <Input value={workspaceAccessToken} onChange={(e) => setWorkspaceAccessToken(e.target.value)} placeholder="chunknet://workspace-access/..." />
          </div>
          <Button
            disabled={busy || working || !workspaceAccessToken.trim()}
            onClick={() => run(async () => {
              await api.invoke("company:importWorkspaceAccess", { workspaceAccessToken });
              setWorkspaceAccessToken("");
              toast.success("Workspace imported on this device.");
            })}
          >
            <Building2 className="size-4" /> Import workspace access
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
