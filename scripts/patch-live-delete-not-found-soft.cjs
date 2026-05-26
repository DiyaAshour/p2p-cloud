#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const target = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
if (!fs.existsSync(target)) {
  console.error('[patch-live-delete-not-found-soft] missing NativeP2PAppLive.tsx');
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');
if (src.includes('ignoreDeleteNotFound')) {
  console.log('[patch-live-delete-not-found-soft] already patched');
  process.exit(0);
}

const helperAnchor = 'const movePersonalFileTo = async (file: P2PFile, targetFolderId: string) => {';
if (!src.includes(helperAnchor)) {
  console.error('[patch-live-delete-not-found-soft] helper anchor not found');
  process.exit(1);
}

const helper = `function ignoreDeleteNotFound(error: unknown): boolean {
  const message = err(error);
  return /item not found/i.test(message) || /manifest not found/i.test(message);
}

`;
src = src.replace(helperAnchor, helper + helperAnchor);

const singleOld = `      await api.invoke("p2p:delete", {
        hash: file.hash,
        rootHash: file.rootHash,
        id: file.id,
        itemId: itemIdFor(file),
      });`;
const singleNew = `      try {
        await api.invoke("p2p:delete", {
          hash: file.hash,
          rootHash: file.rootHash,
          id: file.id,
          itemId: itemIdFor(file),
        });
      } catch (error) {
        if (!ignoreDeleteNotFound(error)) throw error;
        try {
          await api.invoke("audit:record" as Channel, {
            action: "drive:file-delete-already-gone",
            details: {
              fileName: file.name,
              rootHash: file.rootHash || file.hash,
              reason: "backend item not found",
            },
          });
        } catch {}
        toast.success("File was already removed from storage. View refreshed.");
      }`;
if (src.includes(singleOld)) {
  src = src.replace(singleOld, singleNew);
} else {
  console.warn('[patch-live-delete-not-found-soft] single delete block not found or already changed');
}

const bulkOld = `    filesToDelete.map((file) =>
      api.invoke("p2p:delete", {
        hash: file.hash,
        rootHash: file.rootHash,
        id: file.id,
        itemId: itemIdFor(file),
      })
    )`;
const bulkNew = `    filesToDelete.map(async (file) => {
      try {
        await api.invoke("p2p:delete", {
          hash: file.hash,
          rootHash: file.rootHash,
          id: file.id,
          itemId: itemIdFor(file),
        });
      } catch (error) {
        if (!ignoreDeleteNotFound(error)) throw error;
        try {
          await api.invoke("audit:record" as Channel, {
            action: "drive:file-delete-already-gone",
            details: {
              fileName: file.name,
              rootHash: file.rootHash || file.hash,
              reason: "backend item not found",
            },
          });
        } catch {}
      }
    })`;
if (src.includes(bulkOld)) {
  src = src.replace(bulkOld, bulkNew);
} else {
  console.warn('[patch-live-delete-not-found-soft] bulk delete block not found or already changed');
}

fs.writeFileSync(target, src, 'utf8');
console.log('[patch-live-delete-not-found-soft] OK');
