#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const target = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(target)) {
  console.error('[patch-live-company-delete-safe] missing NativeP2PAppLive.tsx');
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');
if (src.includes('personalHiddenCompanyFileKeys')) {
  console.log('[patch-live-company-delete-safe] already patched');
  process.exit(0);
}

function fail(message) {
  console.error('[patch-live-company-delete-safe] ' + message);
  process.exit(1);
}

function replaceOne(needle, replacement, label) {
  if (!src.includes(needle)) fail(label + ' anchor not found');
  src = src.replace(needle, replacement);
}

replaceOne(
  'const ACTIVE_WORKSPACE_KEY = "chunknet.ui.activeWorkspace";',
  'const ACTIVE_WORKSPACE_KEY = "chunknet.ui.activeWorkspace";\nconst PERSONAL_HIDDEN_COMPANY_FILES_KEY = "chunknet.ui.personalHiddenCompanyFiles";',
  'active workspace key'
);

replaceOne(
  '  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());',
  '  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());\n  const [personalHiddenCompanyFileKeys, setPersonalHiddenCompanyFileKeys] = useState<Set<string>>(\n    () => new Set(readJson<string[]>(PERSONAL_HIDDEN_COMPANY_FILES_KEY, []))\n  );',
  'expanded folders state'
);

const personalRegex = /  const personalFiles = useMemo\([\s\S]*?\n  \);\n\n  const companyFiles = useMemo\(\(\) => \{/;
const personalReplacement = `  const personalFiles = useMemo(
    () =>
      files.filter(
        (file) =>
          isRealFileManifest(file) &&
          !personalHiddenCompanyFileKeys.has(keyFor(file)) &&
          !personalHiddenCompanyFileKeys.has(file.hash)
      ),
    [files, personalHiddenCompanyFileKeys]
  );

  const companyFiles = useMemo(() => {`;
if (!personalRegex.test(src)) fail('personalFiles block not found');
src = src.replace(personalRegex, personalReplacement);

const companyRegex = /  const companyFiles = useMemo\(\(\) => \{\n    if \(!activeWorkspace\) return \[\];\n\n    const allowed = \(activeWorkspace\.files \|\| \[\]\)\.filter\(\(file\) => !file\.deleted\);\n\n    return files\n      \.filter\(isRealFileManifest\)\n      \.filter\(\(file\) => allowed\.some\(\(companyFile\) => fileKeyMatches\(companyFile, file\)\)\);\n  \}, \[files, activeWorkspace\]\);/;
const companyReplacement = `  const companyFiles = useMemo(() => {
    if (!activeWorkspace) return [];

    const allowed = (activeWorkspace.files || []).filter((file) => !file.deleted);
    const linked = files
      .filter(isRealFileManifest)
      .filter((file) => allowed.some((companyFile) => fileKeyMatches(companyFile, file)));

    const linkedKeys = new Set(
      linked.flatMap((file) => [file.rootHash, file.hash, file.id].filter(Boolean) as string[])
    );

    const companyOnly = allowed
      .filter((companyFile) => {
        const keys = [companyFile.rootHash, companyFile.hash, companyFile.fileId].filter(Boolean) as string[];
        return !keys.some((key) => linkedKeys.has(key));
      })
      .map((companyFile) =>
        ({
          id: companyFile.fileId || companyFile.rootHash || companyFile.hash,
          name: companyFile.name,
          size: companyFile.size || 0,
          hash: companyFile.hash || companyFile.rootHash || companyFile.fileId,
          rootHash: companyFile.rootHash || companyFile.hash || companyFile.fileId,
          uploadedAt: companyFile.uploadedAt,
          isEncrypted: true,
          totalChunks: companyFile.totalChunks || 1,
          ownerWallet: companyFile.uploadedByDeviceId || companyFile.uploadedByName || "company",
          folder: companyFile.folder || "",
          folderName: companyFile.folder || "",
          replicationStatus: "company-linked",
        }) as P2PFile
      );

    return [...linked, ...companyOnly];
  }, [files, activeWorkspace]);`;
if (!companyRegex.test(src)) fail('companyFiles block not found');
src = src.replace(companyRegex, companyReplacement);

const removeAnchor = `    if (match) {
      await api.invoke("company:updateFile", {
        workspaceId: match.workspace.workspaceId,
        rootHash: match.companyFile.rootHash,
        patch: { deleted: true },
      });`;
const safeBlock = `    if (view === "personal" && match) {
      const keysToHide = [keyFor(file), file.hash, file.rootHash, file.id].filter(Boolean) as string[];
      setPersonalHiddenCompanyFileKeys((prev) => {
        const next = new Set(prev);
        for (const key of keysToHide) next.add(String(key));
        localStorage.setItem(PERSONAL_HIDDEN_COMPANY_FILES_KEY, JSON.stringify(Array.from(next)));
        return next;
      });

      try {
        await api.invoke("audit:record" as Channel, {
          action: "drive:file-removed-from-my-drive-view",
          details: {
            workspaceId: match.workspace.workspaceId,
            workspaceName: match.workspace.name,
            fileName: match.companyFile.name || file.name,
            rootHash: match.companyFile.rootHash || file.rootHash || file.hash,
            keptInCompanyDrive: true,
          },
        });
      } catch {}

      toast.success("Removed from My Drive view. Company Drive keeps the file.");
      return;
    }

` + removeAnchor;
replaceOne(removeAnchor, safeBlock, 'company delete branch');

fs.writeFileSync(target, src, 'utf8');
console.log('[patch-live-company-delete-safe] OK');
