#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const liveFile = path.join(root, 'client', 'src', 'NativeP2PAppLive.tsx');
const preloadFile = path.join(root, 'electron', 'preload.cjs');
const seedFile = path.join(root, 'electron', 'seed-auth-cooldown-ipc.js');

function die(message) {
  console.error('[finalize-company-drive-live] ' + message);
  process.exit(1);
}

function read(file) {
  if (!fs.existsSync(file)) die('Missing ' + path.relative(root, file));
  return fs.readFileSync(file, 'utf8');
}

function write(file, content) {
  fs.writeFileSync(file, content, 'utf8');
}

function replaceOrWarn(source, needle, replacement, label) {
  if (!source.includes(needle)) {
    console.warn('[finalize-company-drive-live] skip: ' + label);
    return source;
  }
  return source.replace(needle, replacement);
}

function insertBefore(source, needle, insertion, label) {
  if (source.includes(insertion.trim().split('\n')[0])) return source;
  if (!source.includes(needle)) {
    console.warn('[finalize-company-drive-live] skip: ' + label);
    return source;
  }
  return source.replace(needle, insertion + '\n' + needle);
}

function patchPreload() {
  let source = read(preloadFile);

  const auditChannels = [
    "  'audit:list',",
    "  'audit:record',",
    "  'audit:clear',",
    "  'audit:listManifests',",
  ];

  if (!source.includes("'audit:record'")) {
    const anchor = "  'company:updateFile',";
    if (!source.includes(anchor)) die('preload company:updateFile anchor not found');
    source = source.replace(anchor, `${anchor}\n${auditChannels.join('\n')}`);
  }

  if (!source.includes("channel.startsWith('audit:')")) {
    source = source.replace(
      "channel.startsWith('company:') || channel.startsWith('drive:')",
      "channel.startsWith('company:') || channel.startsWith('audit:') || channel.startsWith('drive:')"
    );
    source = source.replace(
      "channel.startsWith('company:') || channel.startsWith('drive:')",
      "channel.startsWith('company:') || channel.startsWith('audit:') || channel.startsWith('drive:')"
    );
  }

  write(preloadFile, source);
  console.log('[finalize-company-drive-live] preload audit channels ready');
}

function patchSeedRuntime() {
  let source = read(seedFile);
  if (!source.includes("import './audit-p2p-ipc.js';")) {
    if (source.includes("import './company-drive-ipc.js';")) {
      source = source.replace(
        "import './company-drive-ipc.js';",
        "import './company-drive-ipc.js';\nimport './audit-p2p-ipc.js';"
      );
    } else {
      source = "import './audit-p2p-ipc.js';\n" + source;
    }
  }
  write(seedFile, source);
  console.log('[finalize-company-drive-live] audit runtime import ready');
}

function patchLive() {
  let source = read(liveFile);

  source = source.replace(
    `  | "company:addFile"\n  | "company:updateFile";`,
    `  | "company:addFile"\n  | "company:updateFile"\n  | "audit:list"\n  | "audit:record"\n  | "audit:clear"\n  | "audit:listManifests";`
  );

  if (!source.includes('type AuditEvent = {')) {
    source = insertBefore(
      source,
      'type P2PFile = {',
      `type AuditEvent = {\n  auditId: string;\n  action: string;\n  actor: string;\n  at: string;\n  details?: Record<string, unknown>;\n  p2p?: unknown;\n};\n`,
      'AuditEvent type'
    );
  }

  source = source.replace(
    `  ownerWallet?: string;\n  replicas?: string[];`,
    `  ownerWallet?: string;\n  uploadedByName?: string;\n  uploadedByWallet?: string;\n  uploadedByDeviceId?: string;\n  replicas?: string[];`
  );

  source = source.replace(
    `const ACTIVE_WORKSPACE_KEY = "chunknet.ui.activeWorkspace";`,
    `const ACTIVE_WORKSPACE_KEY = "chunknet.ui.activeWorkspace";\nconst PERSONAL_HIDDEN_COMPANY_FILES_KEY = "chunknet.ui.personalHiddenCompanyFiles";\nconst COMPANY_FOLDERS_KEY = "chunknet.ui.companyFolders";`
  );

  source = source.replace(
    `const PERSONAL_HIDDEN_COMPANY_FILES_KEY = "chunknet.ui.personalHiddenCompanyFiles";\nconst COMPANY_FOLDERS_KEY = "chunknet.ui.companyFolders";\nconst PERSONAL_HIDDEN_COMPANY_FILES_KEY = "chunknet.ui.personalHiddenCompanyFiles";\nconst COMPANY_FOLDERS_KEY = "chunknet.ui.companyFolders";`,
    `const PERSONAL_HIDDEN_COMPANY_FILES_KEY = "chunknet.ui.personalHiddenCompanyFiles";\nconst COMPANY_FOLDERS_KEY = "chunknet.ui.companyFolders";`
  );

  source = source.replace(
    `  const [company, setCompany] = useState<CompanyState | null>(null);\n  const [busy, setBusy] = useState(false);`,
    `  const [company, setCompany] = useState<CompanyState | null>(null);\n  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);\n  const [busy, setBusy] = useState(false);`
  );

  if (!source.includes('companyFoldersByWorkspace')) {
    source = source.replace(
      `  const [workspaceNameInput, setWorkspaceNameInput] = useState("");`,
      `  const [workspaceNameInput, setWorkspaceNameInput] = useState("");\n  const [companyFoldersByWorkspace, setCompanyFoldersByWorkspace] = useState<Record<string, string[]>>(\n    () => readJson<Record<string, string[]>>(COMPANY_FOLDERS_KEY, {})\n  );`
    );
  }

  if (!source.includes('personalHiddenCompanyFileKeys')) {
    source = source.replace(
      `  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());`,
      `  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());\n  const [personalHiddenCompanyFileKeys, setPersonalHiddenCompanyFileKeys] = useState<Set<string>>(\n    () => new Set(readJson<string[]>(PERSONAL_HIDDEN_COMPANY_FILES_KEY, []))\n  );`
    );
  }

  const personalFilesOld = `  const personalFiles = useMemo(\n    () =>\n      files.filter(\n        (file) =>\n          isRealFileManifest(file) &&\n          !companyFileByKey.has(keyFor(file)) &&\n          !companyFileByKey.has(file.hash)\n      ),\n    [files, companyFileByKey]\n  );`;
  const personalFilesNew = `  const personalFiles = useMemo(\n    () =>\n      files.filter(\n        (file) =>\n          isRealFileManifest(file) &&\n          !personalHiddenCompanyFileKeys.has(keyFor(file)) &&\n          !personalHiddenCompanyFileKeys.has(file.hash)\n      ),\n    [files, personalHiddenCompanyFileKeys]\n  );`;
  source = source.replace(personalFilesOld, personalFilesNew);

  const sidebarOld = `  // Manifest-based folder list for sidebar\n  const sidebarFolders = useMemo(() => {\n    if (view === "company" || view === "admin") {\n      const companyFolderNames = new Set(\n        (activeWorkspace?.files || [])\n          .map((file) => file.folder)\n          .filter(Boolean) as string[]\n      );\n\n      return [ALL_FILES, UNCATEGORIZED, ...Array.from(companyFolderNames).sort()];\n    }\n\n    return [\n      ALL_FILES,\n      UNCATEGORIZED,\n      ...manifestFolders\n        .filter((folder) => !folder.parentFolderId)\n        .map((folder) => folder.name)\n        .sort(),\n    ];\n  }, [view, manifestFolders, activeWorkspace]);`;
  const sidebarNew = `  // Company folders are isolated from My Drive folders\n  const companyFolderNames = useMemo(() => {\n    if (!activeWorkspace) return [];\n\n    const saved = companyFoldersByWorkspace[activeWorkspace.workspaceId] || [];\n    const fromFiles = (activeWorkspace.files || [])\n      .map((file) => file.folder)\n      .filter(Boolean) as string[];\n\n    return Array.from(new Set([...saved, ...fromFiles])).sort();\n  }, [activeWorkspace, companyFoldersByWorkspace]);\n\n  const sidebarFolders = useMemo(() => {\n    if (view === "company" || view === "admin") {\n      return [ALL_FILES, UNCATEGORIZED, ...companyFolderNames];\n    }\n\n    return [\n      ALL_FILES,\n      UNCATEGORIZED,\n      ...manifestFolders\n        .filter((folder) => !folder.parentFolderId)\n        .map((folder) => folder.name)\n        .sort(),\n    ];\n  }, [view, manifestFolders, companyFolderNames]);`;
  source = source.replace(sidebarOld, sidebarNew);

  if (!source.includes('const refreshAudit = async')) {
    const helpers = `  const refreshAudit = async (workspaceId?: string) => {\n    if (!api) return;\n\n    try {\n      const result = await api.invoke<{ events: AuditEvent[] }>("audit:list", {\n        workspaceId: workspaceId || activeWorkspace?.workspaceId || "",\n        limit: 200,\n      });\n      setAuditEvents(Array.isArray(result.events) ? result.events : []);\n    } catch (error) {\n      console.error("[audit] list failed", error);\n      setAuditEvents([]);\n    }\n  };\n\n  const recordAudit = async (action: string, details: Record<string, unknown> = {}) => {\n    if (!api) return;\n\n    try {\n      await api.invoke("audit:record", {\n        action,\n        details: {\n          view,\n          workspaceId: activeWorkspace?.workspaceId || "",\n          workspaceName: activeWorkspace?.name || "",\n          actorLabel: identityLabel,\n          ...details,\n        },\n      });\n      await refreshAudit(String(details.workspaceId || activeWorkspace?.workspaceId || ""));\n    } catch (error) {\n      console.error("[audit] record failed", error);\n      toast.error("Audit failed: " + err(error));\n    }\n  };\n\n  const uploaderLabel = (file: P2PFile, cf?: CompanyFile | null): string => {\n    const raw = String(\n      cf?.uploadedByName ||\n        cf?.uploadedByDeviceId ||\n        file.uploadedByName ||\n        file.uploadedByWallet ||\n        file.uploadedByDeviceId ||\n        file.ownerWallet ||\n        ""\n    ).trim();\n\n    const currentId = String(wallet?.accountId || wallet?.address || "").trim().toLowerCase();\n    const currentName = wallet?.username ? \`Seed: \${wallet.username}\` : identityLabel;\n\n    if (!raw) return currentName || "Unknown";\n    if (raw.toLowerCase() === currentId) return currentName || "You";\n    if (raw.startsWith("seed:") || raw.startsWith("0x")) return short(raw);\n    return raw.length > 36 ? short(raw) : raw;\n  };\n\n  const showCompanyFileInfo = (file: P2PFile) => {\n    const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);\n    const cf = match?.companyFile;\n    const workspace = match?.workspace || activeWorkspace;\n\n    const details = [\n      "File: " + (cf?.name || file.name),\n      "Company Drive: " + (workspace?.name || "Unknown"),\n      "Uploaded by: " + uploaderLabel(file, cf),\n      "Uploaded at: " + date(cf?.uploadedAt || file.uploadedAt),\n      "Size: " + bytes(file.size),\n      "Folder: " + (cf?.folder || file.folderName || file.folder || UNCATEGORIZED),\n      "Root hash: " + (cf?.rootHash || file.rootHash || file.hash),\n      "Hash: " + (cf?.hash || file.hash || ""),\n      "Total chunks: " + String(file.totalChunks || cf?.totalChunks || 0),\n      "Encrypted: " + (file.isEncrypted ? "Yes" : "No"),\n      "Replication: " + (file.replicationStatus || "unknown"),\n      "Workspace ID: " + (workspace?.workspaceId || ""),\n      "File ID: " + (cf?.fileId || file.id || file.rootHash || file.hash),\n    ].join("\\n");\n\n    void showInfo("Company file details", details);\n\n    if (match) {\n      void recordAudit("company:file-info-viewed", {\n        workspaceId: match.workspace.workspaceId,\n        workspaceName: match.workspace.name,\n        fileName: cf?.name || file.name,\n        rootHash: cf?.rootHash || file.rootHash || file.hash,\n      });\n    }\n  };\n\n`;
    source = insertBefore(source, '  const run = async (work: () => Promise<void>) => {', helpers, 'audit helpers');
  }

  if (!source.includes('Company folder "${name}" created')) {
    source = source.replace(
      `      const name = newFolder.trim();\n      if (!name) return;`,
      `      const name = newFolder.trim();\n      if (!name) return;\n\n      if (view === "company" || view === "admin") {\n        if (!activeWorkspace) throw new Error("Create or select a Company Drive first");\n\n        setCompanyFoldersByWorkspace((prev) => {\n          const current = prev[activeWorkspace.workspaceId] || [];\n          const nextFolders = Array.from(new Set([...current, name])).sort();\n          const next = { ...prev, [activeWorkspace.workspaceId]: nextFolders };\n          localStorage.setItem(COMPANY_FOLDERS_KEY, JSON.stringify(next));\n          return next;\n        });\n\n        setNewFolder("");\n        setActiveFolder(name);\n        setActiveFolderId("");\n\n        await recordAudit("company:folder-created", {\n          workspaceId: activeWorkspace.workspaceId,\n          workspaceName: activeWorkspace.name,\n          folder: name,\n        });\n\n        toast.success(\`Company folder "\${name}" created\`);\n        return;\n      }`
    );
  }

  if (!source.includes('const addFileToCompanyDrive = (file: P2PFile) =>')) {
    const addAction = `  const addFileToCompanyDrive = (file: P2PFile) =>\n    run(async () => {\n      if (!identityConnected) throw new Error("Connect wallet or sign in first");\n      if (!activeWorkspace) throw new Error("Create or select a Company Drive first");\n      if (!canUpload(localRole)) throw new Error("Your company role cannot add files");\n\n      const folderLabel = getPersonalFileFolder(file);\n      const companyFolder = folderLabel === UNCATEGORIZED ? "" : folderLabel;\n\n      await api.invoke("company:addFile", {\n        workspaceId: activeWorkspace.workspaceId,\n        file,\n        folder: companyFolder,\n      });\n\n      await recordAudit("company:file-added-from-my-drive", {\n        workspaceId: activeWorkspace.workspaceId,\n        workspaceName: activeWorkspace.name,\n        fileName: file.name,\n        rootHash: file.rootHash || file.hash,\n        size: file.size,\n        folder: companyFolder,\n      });\n\n      await refresh();\n      toast.success("Added to Company Drive. Original stays in My Drive.");\n    });\n\n`;
    source = insertBefore(source, '  const download = (file: P2PFile) =>', addAction, 'addFileToCompanyDrive');
  }

  source = source.replace(
    `<CardContent className="space-y-4 p-5">\n          {isPersonal && view === "personal" && (`,
    `<CardContent className="relative space-y-4 p-5">\n          {match && (\n            <button\n              type="button"\n              onClick={() => showCompanyFileInfo(file)}\n              className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-full border border-blue-500/60 bg-blue-500/10 text-xs font-bold text-blue-300 hover:bg-blue-500/20"\n              title="Company file info"\n              aria-label="Company file info"\n            >\n              !\n            </button>\n          )}\n\n          {isPersonal && view === "personal" && (`
  );

  source = source.replace(
    `            {cf?.uploadedByName && (\n              <p className="text-xs text-zinc-500">by: {cf.uploadedByName}</p>\n            )}`,
    `            <p className="text-[11px] text-zinc-500">\n              Uploaded by {uploaderLabel(file, cf)}\n            </p>`
  );

  if (!source.includes('Add to Company')) {
    const shareButton = `            <Button\n              variant="outline"\n              size="sm"\n              onClick={() => share(file)}\n              disabled={busy}\n              className="text-xs"\n            >\n              <Share2 className="size-3" />\n              Share\n            </Button>`;
    source = source.replace(
      shareButton,
      `${shareButton}\n\n            {isPersonal && view === "personal" && activeWorkspace && (\n              <Button\n                variant="outline"\n                size="sm"\n                onClick={() => addFileToCompanyDrive(file)}\n                disabled={busy || !identityConnected || !canUpload(localRole)}\n                className="text-xs"\n              >\n                <Building2 className="size-3" />\n                Add to Company\n              </Button>\n            )}`
    );
  }

  if (!source.includes('Company Drive Audit Log')) {
    const adminAnchor = `                  <div>\n                    <p className="mb-3 text-sm font-semibold">Company Files ({companyFiles.length})</p>`;
    const auditCard = `                  <Card className="border-zinc-800 bg-zinc-900">\n                    <CardHeader>\n                      <CardTitle className="flex items-center justify-between gap-2 text-sm">\n                        <span className="flex items-center gap-2">\n                          <ShieldCheck className="size-4" />\n                          Company Drive Audit Log\n                        </span>\n                        <Button size="sm" variant="outline" onClick={() => void refreshAudit(activeWorkspace.workspaceId)} disabled={busy}>\n                          <RefreshCw className="size-3" />\n                          Refresh\n                        </Button>\n                      </CardTitle>\n                    </CardHeader>\n                    <CardContent className="space-y-2">\n                      {auditEvents.length === 0 ? (\n                        <p className="text-sm text-zinc-500">No audit events yet.</p>\n                      ) : (\n                        <div className="max-h-80 space-y-2 overflow-auto pr-1">\n                          {auditEvents.map((event) => (\n                            <div key={event.auditId} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">\n                              <div className="flex flex-wrap items-center justify-between gap-2">\n                                <p className="text-sm font-medium text-zinc-100">{event.action}</p>\n                                <p className="text-xs text-zinc-500">{date(event.at)}</p>\n                              </div>\n                              <p className="mt-1 text-xs text-zinc-400">\n                                Actor: <span className="font-mono">{short(event.actor || "")}</span>\n                              </p>\n                              {event.details && (\n                                <pre className="mt-2 max-h-24 overflow-auto rounded bg-zinc-900 p-2 text-[11px] text-zinc-400">\n                                  {JSON.stringify(event.details, null, 2)}\n                                </pre>\n                              )}\n                            </div>\n                          ))}\n                        </div>\n                      )}\n                    </CardContent>\n                  </Card>\n\n`;
    source = source.replace(adminAnchor, auditCard + adminAnchor);
  }

  source = source.replace(
    `{view === "company" || view === "admin"\n              ? Array.from(\n                  new Set(\n                    (activeWorkspace?.files || [])\n                      .map((file) => file.folder)\n                      .filter(Boolean) as string[]\n                  )\n                )\n                  .sort()\n                  .map((folderName) => (`,
    `{view === "company" || view === "admin"\n              ? companyFolderNames.map((folderName) => (`
  );

  write(liveFile, source);
  console.log('[finalize-company-drive-live] NativeP2PAppLive patched');
}

patchPreload();
patchSeedRuntime();
patchLive();
console.log('[finalize-company-drive-live] OK');
