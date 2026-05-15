import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { KeyRound, ShieldCheck, UserPlus, ClipboardCheck, Building2, Network, Link2 } from "lucide-react";
import { toast } from "sonner";

type OfflineChannel =
  | "company:createJoinRequest"
  | "company:approveJoinRequest"
  | "company:exportWorkspaceAccess"
  | "company:importWorkspaceAccess"
  | "company:publishObject"
  | "company:tokenFromObject";
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
  const [distributedInput, setDistributedInput] = useState("");
  const [objectUri, setObjectUri] = useState("");
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

  const publishToken = async (token: string) => {
    const result = await api.invoke<{ uri: string }>("company:publishObject", { token, workspaceId: activeWorkspace?.workspaceId || "" });
    setObjectUri(result.uri);
    await copy(result.uri, "Distributed object URI copied.");
  };

  return (
    <Card className="rounded-2xl border-zinc-800 bg-zinc-900">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5" /> Offline company join
          <Badge variant="outline">No server</Badge>
          <Badge variant="outline">P2P objects</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
          <div className="flex items-center gap-2 font-medium"><UserPlus className="size-4" /> Employee side</div>
          <p className="text-xs text-zinc-500">Paste the invite token from the company admin. This device creates a signed join request.</p>
          <div className="space-y-2">
            <Label>Invite token or object URI</Label>
            <Input value={inviteToken} onChange={(e) => setInviteToken(e.target.value)} placeholder="chunknet://invite/... or chunknet://object/..." />
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name" />
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email optional" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || working || !inviteToken.trim()}
              onClick={() => run(async () => {
                let token = inviteToken;
                if (token.startsWith("chunknet://object/")) {
                  const resolved = await api.invoke<{ token: string }>("company:tokenFromObject", { hashOrUri: token });
                  token = resolved.token;
                  setInviteToken(token);
                }
                const result = await api.invoke<{ joinRequestToken: string }>("company:createJoinRequest", { inviteToken: token, displayName, email });
                setJoinRequestToken(result.joinRequestToken);
                await copy(result.joinRequestToken, "Join request copied. Send it to the admin.");
              })}
            >
              <KeyRound className="size-4" /> Generate join request
            </Button>
            <Button variant="outline" disabled={busy || working || !joinRequestToken.trim()} onClick={() => run(() => publishToken(joinRequestToken))}>
              <Network className="size-4" /> Publish join request
            </Button>
          </div>
          {joinRequestToken && <Input readOnly value={joinRequestToken} onFocus={(e) => e.currentTarget.select()} />}
        </div>

        <div className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
          <div className="flex items-center gap-2 font-medium"><ClipboardCheck className="size-4" /> Admin side</div>
          <p className="text-xs text-zinc-500">Paste the employee join request. Admin approval returns a workspace access token.</p>
          <div className="space-y-2">
            <Label>Join request token or object URI</Label>
            <Input value={joinRequestToken} onChange={(e) => setJoinRequestToken(e.target.value)} placeholder="chunknet://join-request/... or chunknet://object/..." />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || working || !joinRequestToken.trim()}
              onClick={() => run(async () => {
                let token = joinRequestToken;
                if (token.startsWith("chunknet://object/")) {
                  const resolved = await api.invoke<{ token: string }>("company:tokenFromObject", { hashOrUri: token });
                  token = resolved.token;
                  setJoinRequestToken(token);
                }
                const result = await api.invoke<{ workspaceAccessToken: string }>("company:approveJoinRequest", { joinRequestToken: token });
                setWorkspaceAccessToken(result.workspaceAccessToken);
                await copy(result.workspaceAccessToken, "Workspace access copied. Send it back to the employee.");
              })}
            >
              <ShieldCheck className="size-4" /> Approve join request
            </Button>
            <Button variant="outline" disabled={busy || working || !activeWorkspace?.workspaceId} onClick={() => run(async () => {
              const result = await api.invoke<{ workspaceAccessToken: string }>("company:exportWorkspaceAccess", { workspaceId: activeWorkspace?.workspaceId });
              setWorkspaceAccessToken(result.workspaceAccessToken);
              await copy(result.workspaceAccessToken, "Workspace access copied.");
            })}>
              <Building2 className="size-4" /> Export access
            </Button>
            <Button variant="outline" disabled={busy || working || !workspaceAccessToken.trim()} onClick={() => run(() => publishToken(workspaceAccessToken))}>
              <Network className="size-4" /> Publish access
            </Button>
          </div>
        </div>

        <div className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-950 p-4 lg:col-span-2">
          <div className="flex items-center gap-2 font-medium"><Building2 className="size-4" /> Employee final step</div>
          <p className="text-xs text-zinc-500">After admin approval, paste the workspace access token or object URI here to join the company on this device.</p>
          <div className="space-y-2">
            <Label>Workspace access token or object URI</Label>
            <Input value={workspaceAccessToken} onChange={(e) => setWorkspaceAccessToken(e.target.value)} placeholder="chunknet://workspace-access/... or chunknet://object/..." />
          </div>
          <Button
            disabled={busy || working || !workspaceAccessToken.trim()}
            onClick={() => run(async () => {
              let token = workspaceAccessToken;
              if (token.startsWith("chunknet://object/")) {
                const resolved = await api.invoke<{ token: string }>("company:tokenFromObject", { hashOrUri: token });
                token = resolved.token;
              }
              await api.invoke("company:importWorkspaceAccess", { workspaceAccessToken: token });
              setWorkspaceAccessToken("");
              toast.success("Workspace imported on this device.");
            })}
          >
            <Building2 className="size-4" /> Import workspace access
          </Button>
        </div>

        <div className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-950 p-4 lg:col-span-2">
          <div className="flex items-center gap-2 font-medium"><Link2 className="size-4" /> Distributed object helper</div>
          <p className="text-xs text-zinc-500">Convert any long company token into a shorter content-addressed object URI, or resolve an object URI back into the original token.</p>
          <div className="space-y-2">
            <Label>Token or object URI</Label>
            <Input value={distributedInput} onChange={(e) => setDistributedInput(e.target.value)} placeholder="chunknet://invite/... or chunknet://object/..." />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy || working || !distributedInput.trim() || distributedInput.startsWith("chunknet://object/")} onClick={() => run(() => publishToken(distributedInput))}>
              <Network className="size-4" /> Publish token as object
            </Button>
            <Button variant="outline" disabled={busy || working || !distributedInput.trim()} onClick={() => run(async () => {
              const result = await api.invoke<{ token: string }>("company:tokenFromObject", { hashOrUri: distributedInput });
              setDistributedInput(result.token);
              await copy(result.token, "Resolved token copied.");
            })}>
              <Link2 className="size-4" /> Resolve object to token
            </Button>
          </div>
          {objectUri && <Input readOnly value={objectUri} onFocus={(e) => e.currentTarget.select()} />}
        </div>
      </CardContent>
    </Card>
  );
}
