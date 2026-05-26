#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const file = path.join(root, 'client', 'src', 'NativeP2PAppLive.tsx');

function die(message) {
  console.error('[patch-live-join-company-drive] ' + message);
  process.exit(1);
}

if (!fs.existsSync(file)) die('Missing NativeP2PAppLive.tsx');
let src = fs.readFileSync(file, 'utf8');

if (src.includes('const joinCompanyDrive = () =>')) {
  console.log('[patch-live-join-company-drive] already patched');
  process.exit(0);
}

const channelAnchor = '  | "company:createWorkspace"\n  | "company:inviteMember"';
if (!src.includes(channelAnchor)) die('Channel anchor not found');
src = src.replace(
  channelAnchor,
  '  | "company:createWorkspace"\n  | "company:importWorkspaceAccess"\n  | "company:inviteMember"'
);

const actionAnchor = `  const inviteMember = () =>
    run(async () => {
      if (!activeWorkspace) throw new Error("Select a company first");

      const email = memberEmail.trim();
      if (!email) return;

      const result = await api.invoke<{ workspace: Workspace; inviteToken: string }>(
        "company:inviteMember",
        { workspaceId: activeWorkspace.workspaceId, email, role: memberRole }
      );

      await navigator.clipboard.writeText(result.inviteToken);
      setMemberEmail("");
      await refresh();
      toast.success("Invite token copied.");
    });`;

if (!src.includes(actionAnchor)) die('inviteMember action anchor not found');

const joinAction = `${actionAnchor}

  const joinCompanyDrive = () =>
    run(async () => {
      if (!identityConnected) {
        throw new Error("Connect wallet or sign in with Seed Account before joining a company");
      }

      const token = (
        await askText({
          title: "Join Company Drive",
          message: "Paste the invite token you received from the Company Drive owner.",
          placeholder: "chunknet-invite:... or exported workspace access token",
          confirmText: "Join",
        })
      )?.trim();

      if (!token) return;

      await api.invoke("company:importWorkspaceAccess", {
        access: token,
        token,
      });

      await refresh();
      setView("shared");
      toast.success("Company Drive joined. Check Shared With Me.");
    });`;

src = src.replace(actionAnchor, joinAction);

const companyCardAnchor = `              {canManage(localRole) || !activeWorkspace ? (
                <Card className="border-zinc-800 bg-zinc-900">
                  <CardHeader>
                    <CardTitle className="text-sm">Create Company Workspace</CardTitle>
                  </CardHeader>
                  <CardContent className="flex gap-2">
                    <Input
                      placeholder="Company name"
                      value={workspaceNameInput}
                      onChange={(event) => setWorkspaceNameInput(event.target.value)}
                      className="border-zinc-700 bg-zinc-950"
                    />
                    <Button onClick={createWorkspace} disabled={busy}>
                      <Building2 className="size-4" />
                      Create
                    </Button>
                  </CardContent>
                </Card>
              ) : null}`;

if (!src.includes(companyCardAnchor)) die('company create card anchor not found');

const companyCardReplacement = `              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {canManage(localRole) || !activeWorkspace ? (
                  <Card className="border-zinc-800 bg-zinc-900">
                    <CardHeader>
                      <CardTitle className="text-sm">Create Company Workspace</CardTitle>
                    </CardHeader>
                    <CardContent className="flex gap-2">
                      <Input
                        placeholder="Company name"
                        value={workspaceNameInput}
                        onChange={(event) => setWorkspaceNameInput(event.target.value)}
                        className="border-zinc-700 bg-zinc-950"
                      />
                      <Button onClick={createWorkspace} disabled={busy}>
                        <Building2 className="size-4" />
                        Create
                      </Button>
                    </CardContent>
                  </Card>
                ) : null}

                <Card className="border-zinc-800 bg-zinc-900">
                  <CardHeader>
                    <CardTitle className="text-sm">Join Company Drive</CardTitle>
                  </CardHeader>
                  <CardContent className="flex items-center justify-between gap-3">
                    <p className="text-xs text-zinc-400">
                      Paste an invite token from an owner. Works even if you were offline when invited.
                    </p>
                    <Button onClick={joinCompanyDrive} disabled={busy || !identityConnected} variant="outline">
                      <UserPlus className="size-4" />
                      Join
                    </Button>
                  </CardContent>
                </Card>
              </div>`;

src = src.replace(companyCardAnchor, companyCardReplacement);

const sharedAnchor = `            <TabsContent value="shared" className="p-6">
              {sharedFiles.length === 0 ? (`;
if (!src.includes(sharedAnchor)) die('shared tab anchor not found');
src = src.replace(
  sharedAnchor,
  `            <TabsContent value="shared" className="space-y-4 p-6">
              <Card className="border-zinc-800 bg-zinc-900">
                <CardHeader>
                  <CardTitle className="text-sm">Join Company Drive</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-3">
                  <p className="text-xs text-zinc-400">
                    Have an invite token? Paste it here to join later, even if the owner invited you while offline.
                  </p>
                  <Button onClick={joinCompanyDrive} disabled={busy || !identityConnected} variant="outline">
                    <UserPlus className="size-4" />
                    Join with token
                  </Button>
                </CardContent>
              </Card>

              {sharedFiles.length === 0 ? (`
);

fs.writeFileSync(file, src, 'utf8');
console.log('[patch-live-join-company-drive] patched NativeP2PAppLive.tsx');
