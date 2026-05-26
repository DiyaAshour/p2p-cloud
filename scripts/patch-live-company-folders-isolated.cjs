#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const target = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(target)) {
  console.error('[patch-live-company-folders-isolated] missing NativeP2PAppLive.tsx');
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');
if (src.includes('COMPANY_FOLDERS_KEY')) {
  console.log('[patch-live-company-folders-isolated] already patched');
  process.exit(0);
}

function fail(message) {
  console.error('[patch-live-company-folders-isolated] ' + message);
  process.exit(1);
}
function replaceOne(needle, replacement, label) {
  if (!src.includes(needle)) fail(label + ' anchor not found');
  src = src.replace(needle, replacement);
}

replaceOne(
  'const ACTIVE_WORKSPACE_KEY = "chunknet.ui.activeWorkspace";',
  'const ACTIVE_WORKSPACE_KEY = "chunknet.ui.activeWorkspace";\nconst COMPANY_FOLDERS_KEY = "chunknet.ui.companyFolders";',
  'active workspace key'
);

replaceOne(
  '  const [workspaceNameInput, setWorkspaceNameInput] = useState("");',
  '  const [workspaceNameInput, setWorkspaceNameInput] = useState("");\n  const [companyFoldersByWorkspace, setCompanyFoldersByWorkspace] = useState<Record<string, string[]>>(\n    () => readJson<Record<string, string[]>>(COMPANY_FOLDERS_KEY, {})\n  );',
  'workspace state'
);

const sidebarOld = `  const sidebarFolders = useMemo(() => {
    if (view === "company" || view === "admin") {
      const companyFolderNames = new Set(
        (activeWorkspace?.files || [])
          .map((file) => file.folder)
          .filter(Boolean) as string[]
      );

      return [ALL_FILES, UNCATEGORIZED, ...Array.from(companyFolderNames).sort()];
    }

    return [
      ALL_FILES,
      UNCATEGORIZED,
      ...manifestFolders
        .filter((folder) => !folder.parentFolderId)
        .map((folder) => folder.name)
        .sort(),
    ];
  }, [view, manifestFolders, activeWorkspace]);`;

const sidebarNew = `  const companyFolderNames = useMemo(() => {
    if (!activeWorkspace) return [];

    const saved = companyFoldersByWorkspace[activeWorkspace.workspaceId] || [];
    const fromFiles = (activeWorkspace.files || [])
      .map((file) => file.folder)
      .filter(Boolean) as string[];

    return Array.from(new Set([...saved, ...fromFiles])).sort();
  }, [activeWorkspace, companyFoldersByWorkspace]);

  const sidebarFolders = useMemo(() => {
    if (view === "company" || view === "admin") {
      return [ALL_FILES, UNCATEGORIZED, ...companyFolderNames];
    }

    return [
      ALL_FILES,
      UNCATEGORIZED,
      ...manifestFolders
        .filter((folder) => !folder.parentFolderId)
        .map((folder) => folder.name)
        .sort(),
    ];
  }, [view, manifestFolders, companyFolderNames]);`;

replaceOne(sidebarOld, sidebarNew, 'sidebar folders');

const createOld = `  const createFolder = () =>
    run(async () => {
      const name = newFolder.trim();
      if (!name) return;

      const response = await api.invoke<CreateFolderResponse>("p2p:createFolder", {
        name,
        parentFolderId: activeFolderId || "",
      });`;

const createNew = `  const createFolder = () =>
    run(async () => {
      const name = newFolder.trim();
      if (!name) return;

      if (view === "company" || view === "admin") {
        if (!activeWorkspace) throw new Error("Create or select a Company Drive first");

        setCompanyFoldersByWorkspace((prev) => {
          const current = prev[activeWorkspace.workspaceId] || [];
          const nextFolders = Array.from(new Set([...current, name])).sort();
          const next = { ...prev, [activeWorkspace.workspaceId]: nextFolders };
          localStorage.setItem(COMPANY_FOLDERS_KEY, JSON.stringify(next));
          return next;
        });

        setNewFolder("");
        setActiveFolder(name);
        setActiveFolderId("");

        try {
          await api.invoke("audit:record" as any, {
            action: "company:folder-created",
            details: {
              workspaceId: activeWorkspace.workspaceId,
              workspaceName: activeWorkspace.name,
              folder: name,
            },
          });
        } catch {}

        toast.success(`Company folder "${name}" created`);
        return;
      }

      const response = await api.invoke<CreateFolderResponse>("p2p:createFolder", {
        name,
        parentFolderId: activeFolderId || "",
      });`;

replaceOne(createOld, createNew, 'createFolder');

const sidebarRenderOld = `            {view === "company" || view === "admin"
              ? Array.from(
                  new Set(
                    (activeWorkspace?.files || [])
                      .map((file) => file.folder)
                      .filter(Boolean) as string[]
                  )
                )
                  .sort()
                  .map((folderName) => (`;
const sidebarRenderNew = `            {view === "company" || view === "admin"
              ? companyFolderNames.map((folderName) => (`;
replaceOne(sidebarRenderOld, sidebarRenderNew, 'company sidebar render start');

const extraClosing = `                  ))
              : (folderChildren.get("") || []).map((folder) => renderFolderNode(folder))}`;
if (!src.includes(extraClosing)) {
  console.warn('[patch-live-company-folders-isolated] sidebar closing block may already be patched');
} else {
  src = src.replace(extraClosing, `                  ))
              : (folderChildren.get("") || []).map((folder) => renderFolderNode(folder))}`);
}

const selectOld = `                {Array.from(
                  new Set(
                    (activeWorkspace?.files || [])
                      .map((item) => item.folder)
                      .filter(Boolean) as string[]
                  )
                )
                  .sort()
                  .map((folderName) => (`;
const selectNew = `                {companyFolderNames.map((folderName) => (`;
if (src.includes(selectOld)) src = src.replace(selectOld, selectNew);

fs.writeFileSync(target, src, 'utf8');
console.log('[patch-live-company-folders-isolated] OK');
