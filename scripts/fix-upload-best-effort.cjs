const fs = require('node:fs');

const mainPath = 'electron/main.js';
let main = fs.readFileSync(mainPath, 'utf8');
let changed = false;

function replaceAllExact(from, to, label) {
  let count = 0;
  while (main.includes(from)) {
    main = main.replace(from, to);
    changed = true;
    count += 1;
  }
  if (count) console.log(`[fix-upload-best-effort] ${label}: ${count}`);
  return count;
}

function insertOnce(anchor, insert, label) {
  if (main.includes(insert.trim())) {
    console.log(`[fix-upload-best-effort] ${label}: already present`);
    return false;
  }
  const idx = main.indexOf(anchor);
  if (idx === -1) throw new Error(`[fix-upload-best-effort] missing anchor: ${label}`);
  main = main.slice(0, idx + anchor.length) + insert + main.slice(idx + anchor.length);
  changed = true;
  console.log(`[fix-upload-best-effort] ${label}: inserted`);
  return true;
}

const helpers = `

async function syncPullBestEffort(reason = 'manual') {
  try {
    return await syncPull();
  } catch (error) {
    const message = error?.message || String(error);
    lastSyncStatus = { ...lastSyncStatus, ok: false, error: message };
    console.warn(`[manifest-sync] optional pull failed (${reason}):`, message);
    return { ok: false, skipped: false, error: message };
  }
}

async function syncPushBestEffort(manifest, reason = 'manual') {
  try {
    return await syncPush(manifest);
  } catch (error) {
    const message = error?.message || String(error);
    lastSyncStatus = { ...lastSyncStatus, ok: false, error: message };
    console.warn(`[manifest-sync] optional push failed (${reason}):`, message);
    return { ok: false, skipped: false, error: message };
  }
}
`;

insertOnce(
  "async function syncDelete(ownerWallet, hash) { try { if (isManifestSyncEnabled()) await deleteWalletManifest(ownerWallet, hash); } catch (e) { console.warn('[manifest-sync] delete failed:', e?.message || e); } }",
  helpers,
  'best-effort sync helpers'
);

replaceAllExact(
`      try {
        await putChunkToSafetyPeer(chunkPayload, node.peerId);
        replicas.push('aws-safety-peer');
      } catch (error) {
        throw new Error(\`Safety peer upload failed for chunk \${chunk.hash}: \${error?.message || error}\`);
      }`,
`      try {
        await putChunkToSafetyPeer(chunkPayload, node.peerId);
        replicas.push('aws-safety-peer');
      } catch (error) {
        console.warn(\`[safety-peer] optional upload failed for chunk \${chunk.hash}:\`, error?.message || error);
      }`,
  'safety peer optional template'
);

replaceAllExact(
`          throw new Error(\`Safety peer upload failed for chunk \${chunk.hash}: \${error?.message || error}\`);`,
`          console.warn(\`[safety-peer] optional upload failed for chunk \${chunk.hash}:\`, error?.message || error);`,
  'safety peer optional single-line'
);

replaceAllExact(
`  await syncPush(manifest);
  await syncPull();
  finishProgress('upload');
  return { ok: true, file: manifest, summary: networkSummary(), sync: lastSyncStatus, progress: transferProgress.upload };`,
`  await syncPushBestEffort(manifest, 'p2p:upload');
  await syncPullBestEffort('p2p:upload-after-push');
  finishProgress('upload');
  return { ok: true, file: manifest, summary: networkSummary(), sync: lastSyncStatus, progress: transferProgress.upload, warning: lastSyncStatus?.ok === false ? lastSyncStatus.error : null };`,
  'legacy p2p:upload sync optional'
);

replaceAllExact(
`    await syncPush(manifest);
    uploaded.push(manifest);`,
`    await syncPushBestEffort(manifest, 'p2p:uploadFiles');
    uploaded.push(manifest);`,
  'p2p:uploadFiles push optional'
);

replaceAllExact(
`  await syncPull();

  return { ok: true, cancelled: false, files: uploaded, summary: networkSummary(), sync: lastSyncStatus };`,
`  await syncPullBestEffort('p2p:uploadFiles-after-upload');

  return { ok: true, cancelled: false, files: uploaded, summary: networkSummary(), sync: lastSyncStatus, warning: lastSyncStatus?.ok === false ? lastSyncStatus.error : null };`,
  'p2p:uploadFiles final pull optional'
);

if (changed) {
  fs.writeFileSync(mainPath, main, 'utf8');
  console.log('[fix-upload-best-effort] done: upload no longer fails because safety peer or manifest sync is offline/slow');
} else {
  console.log('[fix-upload-best-effort] no changes needed');
}
