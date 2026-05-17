const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = process.cwd();
const livePath = path.join(root, 'client', 'src', 'NativeP2PAppLive.tsx');
const safeRef = '9d64d69b05a89ca28c6677162230b5f1ef2fa7c9';

function isProbablyBroken(src) {
  return !src.includes('export default function NativeP2PAppLive') || !src.includes('<main className=') || !src.includes('</main>') || !src.includes('</div>') || src.length < 25000;
}

function restoreSafeLiveIfNeeded() {
  const current = fs.existsSync(livePath) ? fs.readFileSync(livePath, 'utf8') : '';
  if (!isProbablyBroken(current)) return;
  try {
    const content = execFileSync('git', ['show', `${safeRef}:client/src/NativeP2PAppLive.tsx`], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    fs.writeFileSync(livePath, content, 'utf8');
    console.log('[live-network-folders] restored NativeP2PAppLive.tsx from known-good UI commit because current file was truncated');
  } catch (error) {
    console.warn('[live-network-folders] could not restore known-good UI:', error?.message || error);
  }
}

function patch() {
  let src = fs.readFileSync(livePath, 'utf8');
  const before = src;

  if (!src.includes('| "p2p:updateFile"')) {
    src = src.replace('  | "p2p:prepareProof"\n', '  | "p2p:prepareProof"\n  | "p2p:updateFile"\n');
  }
  src = src.replace('type Bridge = { invoke: <T>(channel: Channel, payload?: unknown) => Promise<T> };', 'type Bridge = { invoke: <T>(channel: string, payload?: unknown) => Promise<T> };');
  if (!src.includes('folder?: string; ownerWallet?: string')) {
    src = src.replace('totalChunks: number; ownerWallet?: string;', 'totalChunks: number; folder?: string; ownerWallet?: string;');
  }

  src = src.replace(
    '    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const localFolders = Object.values(fileFolders).filter(Boolean);\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set([...localFolders, ...workspaceFolders])).sort()];\n  }, [fileFolders, activeWorkspace]);',
    '    const workspaceFolders = (activeWorkspace?.files || []).map((file) => file.folder).filter(Boolean) as string[];\n    const personalManifestFolders = personalFiles.map((file) => file.folder).filter(Boolean) as string[];\n    const localFolders = Object.values(fileFolders).filter(Boolean);\n    const sourceFolders = view === "company" || view === "admin" ? workspaceFolders : [...personalManifestFolders, ...localFolders];\n    return [ALL_FILES, UNCATEGORIZED, ...Array.from(new Set(sourceFolders)).sort()];\n  }, [fileFolders, activeWorkspace, personalFiles, view]);'
  );

  src = src.replace(
    '      const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;',
    '      const folder = cf?.folder || file.folder || fileFolders[file.hash] || UNCATEGORIZED;'
  );
  src = src.replace(
    '    const folder = cf?.folder || fileFolders[file.hash] || UNCATEGORIZED;',
    '    const folder = cf?.folder || file.folder || fileFolders[file.hash] || UNCATEGORIZED;'
  );

  src = src.replace(
    '    if (activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED && result?.files?.length) {\n      setFileFolders((current) => {\n        const next = { ...current };\n        for (const file of result.files || []) next[file.hash] = activeFolder;\n        return next;\n      });\n    }',
    '    if (activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED && result?.files?.length) {\n      setFileFolders((current) => {\n        const next = { ...current };\n        for (const file of result.files || []) next[file.hash] = file.folder || activeFolder;\n        return next;\n      });\n    }'
  );

  src = src.replace(
    '              if (match) void api.invoke("company:updateFile", { workspaceId: match.workspace.workspaceId, rootHash: match.companyFile.rootHash, patch: { folder: nextFolder } }).then(refresh);\n              else setFileFolders((current) => ({ ...current, [file.hash]: nextFolder }));',
    '              if (match) void api.invoke("company:updateFile", { workspaceId: match.workspace.workspaceId, rootHash: match.companyFile.rootHash, patch: { folder: nextFolder } }).then(refresh);\n              else void api.invoke("p2p:updateFile", { hash: file.hash, patch: { folder: nextFolder } }).then(refresh);'
  );

  if (src !== before) {
    fs.writeFileSync(livePath, src, 'utf8');
    console.log('[live-network-folders] patched My Drive folders to use network manifests');
  } else {
    console.log('[live-network-folders] already patched');
  }
}

restoreSafeLiveIfNeeded();
patch();
