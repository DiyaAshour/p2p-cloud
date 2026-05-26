#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const target = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(target)) {
  console.error('[patch-live-company-info] missing NativeP2PAppLive.tsx');
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');
if (src.includes('const showCompanyFileInfo = (file: P2PFile) =>')) {
  console.log('[patch-live-company-info] already patched');
  process.exit(0);
}

const helperAnchor = '  const renderFileCard = (file: P2PFile) => {';
if (!src.includes(helperAnchor)) {
  console.error('[patch-live-company-info] renderFileCard anchor not found');
  process.exit(1);
}

const helper = `  const showCompanyFileInfo = (file: P2PFile) => {
    const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);
    const cf = match?.companyFile;
    const workspace = match?.workspace || activeWorkspace;
    const uploadedBy = String(
      cf?.uploadedByName ||
        cf?.uploadedByDeviceId ||
        (file as any).uploadedByName ||
        (file as any).uploadedByWallet ||
        (file as any).uploadedByDeviceId ||
        file.ownerWallet ||
        "Unknown"
    );
    const details = [
      "File: " + (cf?.name || file.name),
      "Company Drive: " + (workspace?.name || "Unknown"),
      "Uploaded by: " + uploadedBy,
      "Uploaded at: " + date(cf?.uploadedAt || file.uploadedAt),
      "Size: " + bytes(file.size),
      "Folder: " + (cf?.folder || file.folderName || file.folder || UNCATEGORIZED),
      "Root hash: " + (cf?.rootHash || file.rootHash || file.hash),
      "Hash: " + (cf?.hash || file.hash || ""),
      "Total chunks: " + String(file.totalChunks || cf?.totalChunks || 0),
      "Encrypted: " + (file.isEncrypted ? "Yes" : "No"),
      "Replication: " + (file.replicationStatus || "unknown"),
      "Workspace ID: " + (workspace?.workspaceId || ""),
      "File ID: " + (cf?.fileId || file.id || file.rootHash || file.hash),
    ].join("\\n");

    void showInfo("Company file details", details);

    if (match) {
      void recordAudit("company:file-info-viewed", {
        workspaceId: match.workspace.workspaceId,
        workspaceName: match.workspace.name,
        fileName: cf?.name || file.name,
        rootHash: cf?.rootHash || file.rootHash || file.hash,
      });
    }
  };

`;

src = src.replace(helperAnchor, helper + helperAnchor);

const contentAnchor = '<CardContent className="space-y-4 p-5">';
if (!src.includes(contentAnchor)) {
  console.error('[patch-live-company-info] card content anchor not found');
  process.exit(1);
}

const contentReplacement = `<CardContent className="relative space-y-4 p-5">
          {match && (
            <button
              type="button"
              onClick={() => showCompanyFileInfo(file)}
              className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-full border border-blue-500/60 bg-blue-500/10 text-xs font-bold text-blue-300 hover:bg-blue-500/20"
              title="Company file info"
            >
              !
            </button>
          )}`;

src = src.replace(contentAnchor, contentReplacement);
fs.writeFileSync(target, src, 'utf8');
console.log('[patch-live-company-info] OK');
