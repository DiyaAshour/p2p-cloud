#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const file = path.join(root, 'client', 'src', 'NativeP2PAppLive.tsx');

function fail(message) {
  console.error('[patch-live-audit-log] ' + message);
  process.exit(1);
}
function replaceOnce(source, needle, replacement, label) {
  if (!source.includes(needle)) fail(label + ' anchor not found');
  return source.replace(needle, replacement);
}

if (!fs.existsSync(file)) fail('Missing NativeP2PAppLive.tsx');
let source = fs.readFileSync(file, 'utf8');

if (source.includes('type AuditEvent = {')) {
  console.log('[patch-live-audit-log] already patched');
  process.exit(0);
}

source = replaceOnce(
  source,
  `  | "company:addFile"\n  | "company:updateFile";`,
  `  | "company:addFile"\n  | "company:updateFile"\n  | "audit:list"\n  | "audit:record"\n  | "audit:clear";`,
  'Channel union'
);

source = replaceOnce(
  source,
  `type CompanyState = {\n  ok: boolean;\n  deviceIdentity: DeviceIdentity;\n  workspaces: Workspace[];\n};`,
  `type CompanyState = {\n  ok: boolean;\n  deviceIdentity: DeviceIdentity;\n  workspaces: Workspace[];\n};\n\ntype AuditEvent = {\n  auditId: string;\n  action: string;\n  actor: string;\n  at: string;\n  details?: Record<string, unknown>;\n};`,
  'CompanyState type'
);

source = replaceOnce(
  source,
  `  const [company, setCompany] = useState<CompanyState | null>(null);\n  const [busy, setBusy] = useState(false);`,
  `  const [company, setCompany] = useState<CompanyState | null>(null);\n  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);\n  const [busy, setBusy] = useState(false);`,
  'state section'
);

source = replaceOnce(
  source,
  `  const run = async (work: () => Promise<void>) => {`,
  `  const refreshAudit = async (workspaceId?: string) => {\n    if (!api) return;\n\n    try {\n      const result = await api.invoke<{ events: AuditEvent[] }>(\"audit:list\", {\n        workspaceId: workspaceId || activeWorkspace?.workspaceId || \"\",\n        limit: 200,\n      });\n      setAuditEvents(Array.isArray(result.events) ? result.events : []);\n    } catch {\n      setAuditEvents([]);\n    }\n  };\n\n  const recordAudit = async (action: string, details: Record<string, unknown> = {}) => {\n    if (!api) return;\n\n    try {\n      await api.invoke(\"audit:record\", {\n        action,\n        details: {\n          view,\n          workspaceId: activeWorkspace?.workspaceId || \"\",\n          workspaceName: activeWorkspace?.name || \"\",\n          actorLabel: identityLabel,\n          ...details,\n        },\n      });\n      await refreshAudit(String(details.workspaceId || activeWorkspace?.workspaceId || \"\"));\n    } catch {}\n  };\n\n  const run = async (work: () => Promise<void>) => {`,
  'run anchor'
);

source = replaceOnce(
  source,
  `    setCompany(nextCompany);\n    setManifestFolders(Array.isArray(nextFolders) ? nextFolders : []);`,
  `    setCompany(nextCompany);\n    setManifestFolders(Array.isArray(nextFolders) ? nextFolders : []);\n\n    try {\n      const audit = await api.invoke<{ events: AuditEvent[] }>(\"audit:list\", {\n        workspaceId: activeWorkspaceId || nextCompany.workspaces?.[0]?.workspaceId || \"\",\n        limit: 200,\n      });\n      setAuditEvents(Array.isArray(audit.events) ? audit.events : []);\n    } catch {\n      setAuditEvents([]);\n    }`,
  'refresh audit load'
);

source = replaceOnce(
  source,
  `      setView("company");\n      await refresh();\n      toast.success("Company workspace created and signed");`,
  `      setView("company");\n      await recordAudit("company:created", {\n        workspaceId: ws.workspaceId,\n        workspaceName: ws.name,\n      });\n      await refresh();\n      toast.success("Company workspace created and signed");`,
  'createWorkspace audit'
);

source = replaceOnce(
  source,
  `      await navigator.clipboard.writeText(result.inviteToken);\n      setMemberEmail("");\n      await refresh();\n      toast.success("Invite token copied.");`,
  `      await navigator.clipboard.writeText(result.inviteToken);\n      await recordAudit("company:member-invited", {\n        workspaceId: activeWorkspace.workspaceId,\n        workspaceName: activeWorkspace.name,\n        invited: email,\n        role: memberRole,\n      });\n      setMemberEmail("");\n      await refresh();\n      toast.success("Invite token copied.");`,
  'invite audit'
);

source = replaceOnce(
  source,
  `      await api.invoke("company:changeMemberRole", {\n        workspaceId: activeWorkspace.workspaceId,\n        memberId,\n        role,\n      });\n\n      await refresh();`,
  `      await api.invoke("company:changeMemberRole", {\n        workspaceId: activeWorkspace.workspaceId,\n        memberId,\n        role,\n      });\n\n      await recordAudit("company:member-role-changed", {\n        workspaceId: activeWorkspace.workspaceId,\n        workspaceName: activeWorkspace.name,\n        memberId,\n        role,\n      });\n      await refresh();`,
  'role audit'
);

source = replaceOnce(
  source,
  `      await api.invoke("company:removeMember", {\n        workspaceId: activeWorkspace.workspaceId,\n        memberId,\n      });\n\n      await refresh();`,
  `      await api.invoke("company:removeMember", {\n        workspaceId: activeWorkspace.workspaceId,\n        memberId,\n      });\n\n      await recordAudit("company:member-removed", {\n        workspaceId: activeWorkspace.workspaceId,\n        workspaceName: activeWorkspace.name,\n        memberId,\n      });\n      await refresh();`,
  'remove member audit'
);

source = replaceOnce(
  source,
  `          await api.invoke("company:addFile", {\n            workspaceId: activeWorkspace.workspaceId,\n            file,\n            folder:\n              activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED ? "" : activeFolder,\n          });`,
  `          const folderName = activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED ? "" : activeFolder;\n          await api.invoke("company:addFile", {\n            workspaceId: activeWorkspace.workspaceId,\n            file,\n            folder: folderName,\n          });\n          await recordAudit("company:file-uploaded", {\n            workspaceId: activeWorkspace.workspaceId,\n            workspaceName: activeWorkspace.name,\n            fileName: file.name,\n            rootHash: file.rootHash || file.hash,\n            size: file.size,\n            folder: folderName,\n          });`,
  'company upload audit'
);

source = replaceOnce(
  source,
  `          await api.invoke("company:addFile", {\n            workspaceId: activeWorkspace.workspaceId,\n            file,\n            folder: activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED ? "" : activeFolder,\n          });`,
  `          const folderName = activeFolder === ALL_FILES || activeFolder === UNCATEGORIZED ? "" : activeFolder;\n          await api.invoke("company:addFile", {\n            workspaceId: activeWorkspace.workspaceId,\n            file,\n            folder: folderName,\n          });\n          await recordAudit("company:file-uploaded", {\n            workspaceId: activeWorkspace.workspaceId,\n            workspaceName: activeWorkspace.name,\n            fileName: file.name,\n            rootHash: file.rootHash || file.hash,\n            size: file.size,\n            folder: folderName,\n            source: "folder-upload",\n          });`,
  'company folder upload audit'
);

source = replaceOnce(
  source,
  `      if (!result?.cancelled) {\n        toast.success(result?.path ? \`Downloaded to \${result.path}\` : "Download complete");\n      }\n\n      await refresh();`,
  `      if (!result?.cancelled) {\n        const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);\n        await recordAudit(match ? "company:file-downloaded" : "drive:file-downloaded", {\n          workspaceId: match?.workspace.workspaceId || "",\n          workspaceName: match?.workspace.name || "",\n          fileName: match?.companyFile.name || file.name,\n          rootHash: file.rootHash || file.hash,\n          path: result?.path || "",\n        });\n        toast.success(result?.path ? \`Downloaded to \${result.path}\` : "Download complete");\n      }\n\n      await refresh();`,
  'download audit'
);

source = replaceOnce(
  source,
  `      await api.invoke("company:updateFile", {\n        workspaceId: match.workspace.workspaceId,\n        rootHash: match.companyFile.rootHash,\n        patch: { name },\n      });\n\n      await refresh();`,
  `      await api.invoke("company:updateFile", {\n        workspaceId: match.workspace.workspaceId,\n        rootHash: match.companyFile.rootHash,\n        patch: { name },\n      });\n\n      await recordAudit("company:file-renamed", {\n        workspaceId: match.workspace.workspaceId,\n        workspaceName: match.workspace.name,\n        rootHash: match.companyFile.rootHash,\n        oldName: match.companyFile.name || file.name,\n        newName: name,\n      });\n      await refresh();`,
  'rename audit'
);

source = replaceOnce(
  source,
  `      await api.invoke("company:updateFile", {\n        workspaceId: match.workspace.workspaceId,\n        rootHash: match.companyFile.rootHash,\n        patch: { hidden: !match.companyFile.hidden },\n      });\n\n      await refresh();`,
  `      const nextHidden = !match.companyFile.hidden;\n      await api.invoke("company:updateFile", {\n        workspaceId: match.workspace.workspaceId,\n        rootHash: match.companyFile.rootHash,\n        patch: { hidden: nextHidden },\n      });\n\n      await recordAudit(nextHidden ? "company:file-hidden" : "company:file-unhidden", {\n        workspaceId: match.workspace.workspaceId,\n        workspaceName: match.workspace.name,\n        rootHash: match.companyFile.rootHash,\n        fileName: match.companyFile.name || file.name,\n      });\n      await refresh();`,
  'hide audit'
);

source = replaceOnce(
  source,
  `      await api.invoke("company:updateFile", {\n        workspaceId: match.workspace.workspaceId,\n        rootHash: match.companyFile.rootHash,\n        patch: { deleted: true },\n      });\n\n      await refresh();\n      toast.success("Removed from company manifest.");`,
  `      await api.invoke("company:updateFile", {\n        workspaceId: match.workspace.workspaceId,\n        rootHash: match.companyFile.rootHash,\n        patch: { deleted: true },\n      });\n\n      await recordAudit("company:file-deleted", {\n        workspaceId: match.workspace.workspaceId,\n        workspaceName: match.workspace.name,\n        rootHash: match.companyFile.rootHash,\n        fileName: match.companyFile.name || file.name,\n      });\n      await refresh();\n      toast.success("Removed from company manifest.");`,
  'company delete audit'
);

source = replaceOnce(
  source,
  `      await refresh();\n    }\n  });`,
  `      await recordAudit("drive:file-deleted", {\n        fileName: file.name,\n        rootHash: file.rootHash || file.hash,\n      });\n      await refresh();\n    }\n  });`,
  'personal delete audit'
);

source = replaceOnce(
  source,
  `                  <div>\n                    <p className="mb-3 text-sm font-semibold">Company Files ({companyFiles.length})</p>`,
  `                  <Card className="border-zinc-800 bg-zinc-900">\n                    <CardHeader>\n                      <CardTitle className="flex items-center justify-between gap-2 text-sm">\n                        <span className="flex items-center gap-2">\n                          <ShieldCheck className="size-4" />\n                          Company Drive Audit Log\n                        </span>\n                        <span className="flex gap-2">\n                          <Button size="sm" variant="outline" onClick={() => void refreshAudit(activeWorkspace.workspaceId)} disabled={busy}>\n                            <RefreshCw className="size-3" />\n                            Refresh\n                          </Button>\n                          <Button\n                            size="sm"\n                            variant="destructive"\n                            onClick={() =>\n                              run(async () => {\n                                await api.invoke(\"audit:clear\", {});\n                                await refreshAudit(activeWorkspace.workspaceId);\n                              })\n                            }\n                            disabled={busy}\n                          >\n                            Clear\n                          </Button>\n                        </span>\n                      </CardTitle>\n                    </CardHeader>\n                    <CardContent className="space-y-2">\n                      {auditEvents.length === 0 ? (\n                        <p className="text-sm text-zinc-500">No audit events yet.</p>\n                      ) : (\n                        <div className="max-h-80 space-y-2 overflow-auto pr-1">\n                          {auditEvents.map((event) => (\n                            <div key={event.auditId} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">\n                              <div className="flex flex-wrap items-center justify-between gap-2">\n                                <p className="text-sm font-medium text-zinc-100">{event.action}</p>\n                                <p className="text-xs text-zinc-500">{date(event.at)}</p>\n                              </div>\n                              <p className="mt-1 text-xs text-zinc-400">\n                                Actor: <span className="font-mono">{short(event.actor || \"\")}</span>\n                              </p>\n                              {event.details && (\n                                <pre className="mt-2 max-h-24 overflow-auto rounded bg-zinc-900 p-2 text-[11px] text-zinc-400">\n                                  {JSON.stringify(event.details, null, 2)}\n                                </pre>\n                              )}\n                            </div>\n                          ))}\n                        </div>\n                      )}\n                    </CardContent>\n                  </Card>\n\n                  <div>\n                    <p className="mb-3 text-sm font-semibold">Company Files ({companyFiles.length})</p>`,
  'audit card'
);

fs.writeFileSync(file, source, 'utf8');
console.log('[patch-live-audit-log] patched NativeP2PAppLive.tsx');
