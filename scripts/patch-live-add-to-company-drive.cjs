#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const target = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(target)) {
  console.error('[patch-live-add-to-company-drive] missing NativeP2PAppLive.tsx');
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');
if (src.includes('const addFileToCompanyDrive = (file: P2PFile) =>')) {
  console.log('[patch-live-add-to-company-drive] already patched');
  process.exit(0);
}

function must(anchor, label) {
  if (!src.includes(anchor)) {
    console.error(`[patch-live-add-to-company-drive] ${label} anchor not found`);
    process.exit(1);
  }
}

const actionAnchor = '  const download = (file: P2PFile) =>';
must(actionAnchor, 'download action');

const actions = `  const auditCompanyLink = async (action: string, details: Record<string, unknown>) => {
    try {
      await api.invoke("audit:record" as Channel, {
        action,
        details: {
          view,
          actorLabel: identityLabel,
          workspaceId: activeWorkspace?.workspaceId || "",
          workspaceName: activeWorkspace?.name || "",
          ...details,
        },
      });
    } catch {}
  };

  const addFileToCompanyDrive = (file: P2PFile) =>
    run(async () => {
      if (!identityConnected) {
        throw new Error("Connect wallet or sign in before adding to Company Drive");
      }

      if (!activeWorkspace) {
        throw new Error("Create or select a Company Drive first");
      }

      if (!canUpload(localRole)) {
        throw new Error("Your company role cannot add files");
      }

      const folderLabel = getPersonalFileFolder(file);
      const companyFolder = folderLabel === UNCATEGORIZED ? "" : folderLabel;

      await api.invoke("company:addFile", {
        workspaceId: activeWorkspace.workspaceId,
        file,
        folder: companyFolder,
      });

      await auditCompanyLink("company:file-added-from-my-drive", {
        fileName: file.name,
        rootHash: file.rootHash || file.hash,
        size: file.size,
        folder: companyFolder,
      });

      await refresh();
      toast.success("Added to Company Drive. Original stays in My Drive.");
    });

  const addFolderToCompanyDrive = (folder: DriveFolder) =>
    run(async () => {
      if (!identityConnected) {
        throw new Error("Connect wallet or sign in before adding to Company Drive");
      }

      if (!activeWorkspace) {
        throw new Error("Create or select a Company Drive first");
      }

      if (!canUpload(localRole)) {
        throw new Error("Your company role cannot add folders");
      }

      const folderIds = collectChildFolderIds(folder.folderId);
      const filesToAdd = personalFiles.filter((file) => {
        const folderId = getPersonalFileFolderId(file);
        return folderId && folderIds.has(folderId);
      });

      if (filesToAdd.length === 0) {
        throw new Error("This folder has no personal files to add");
      }

      for (const file of filesToAdd) {
        const folderLabel = getPersonalFileFolder(file);
        await api.invoke("company:addFile", {
          workspaceId: activeWorkspace.workspaceId,
          file,
          folder: folderLabel === UNCATEGORIZED ? "" : folderLabel,
        });
      }

      await auditCompanyLink("company:folder-added-from-my-drive", {
        folderName: folderPath(folder),
        folderId: folder.folderId,
        files: filesToAdd.length,
      });

      await refresh();
      toast.success(`${filesToAdd.length} file(s) added to Company Drive. Folder stays in My Drive.`);
    });

`;

src = src.replace(actionAnchor, actions + actionAnchor);

const personalFilesOld = `  const personalFiles = useMemo(
    () =>
      files.filter(
        (file) =>
          isRealFileManifest(file) &&
          !companyFileByKey.has(keyFor(file)) &&
          !companyFileByKey.has(file.hash)
      ),
    [files, companyFileByKey]
  );`;
const personalFilesNew = `  const personalFiles = useMemo(
    () => files.filter((file) => isRealFileManifest(file)),
    [files]
  );`;
if (src.includes(personalFilesOld)) {
  src = src.replace(personalFilesOld, personalFilesNew);
} else {
  console.warn('[patch-live-add-to-company-drive] personalFiles filter already changed or anchor not found');
}

const fileButtonAnchor = `            <Button
              variant="outline"
              size="sm"
              onClick={() => share(file)}
              disabled={busy}
              className="text-xs"
            >
              <Share2 className="size-3" />
              Share
            </Button>`;
must(fileButtonAnchor, 'share button');

const fileButton = `${fileButtonAnchor}

            {isPersonal && view === "personal" && activeWorkspace && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => addFileToCompanyDrive(file)}
                disabled={busy || !identityConnected || !canUpload(localRole)}
                className="text-xs"
              >
                <Building2 className="size-3" />
                Add to Company
              </Button>
            )}`;
src = src.replace(fileButtonAnchor, fileButton);

const folderButtonAnchor = `            <Button size="sm" onClick={() => openFolder(folder)} disabled={busy} className="text-xs">
              <FolderOpen className="size-3" />
              Open
            </Button>`;
must(folderButtonAnchor, 'folder open button');

const folderButton = `${folderButtonAnchor}

            {view === "personal" && activeWorkspace && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => addFolderToCompanyDrive(folder)}
                disabled={busy || !identityConnected || !canUpload(localRole)}
                className="text-xs"
              >
                <Building2 className="size-3" />
                Add to Company
              </Button>
            )}`;
src = src.replace(folderButtonAnchor, folderButton);

fs.writeFileSync(target, src, 'utf8');
console.log('[patch-live-add-to-company-drive] OK');
