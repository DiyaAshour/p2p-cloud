const fs = require('node:fs');

const files = [
  'client/src/NativeP2PAppStable.tsx',
  'client/src/NativeP2PAppLive.tsx',
];

const before = `const deleteFile = (file: P2PFile) => runBusy(async () => {
    if (!bridge) return;
    await bridge.invoke("p2p:delete", { hash: file.hash });
    setFileFolders((current) => { const next = { ...current }; delete next[file.hash]; return next; });
    await refreshAll();
  });`;

const after = `const deleteFile = (file: P2PFile) => runBusy(async () => {
    if (!bridge) return;

    await bridge.invoke("p2p:delete", { hash: file.hash, rootHash: file.rootHash, id: file.id });

    // Local-first UX: the native delete path already removes the manifest/chunks
    // immediately and schedules remote cleanup in the background. Do not block the
    // UI on networkSummary / manifest sync after delete.
    setFiles((current) => current.filter((candidate) =>
      candidate.hash !== file.hash &&
      candidate.rootHash !== file.rootHash &&
      candidate.id !== file.id
    ));

    setFileFolders((current) => {
      const next = { ...current };
      delete next[file.hash];
      delete next[file.rootHash];
      delete next[file.id];
      return next;
    });

    toast.success("File deleted");
    void refreshAll();
  });`;

let changed = false;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`[fast-delete-ui] skip missing ${file}`);
    continue;
  }

  const source = fs.readFileSync(file, 'utf8');

  if (source.includes('Local-first UX: the native delete path')) {
    console.log(`[fast-delete-ui] already patched ${file}`);
    continue;
  }

  let next = source;

  if (next.includes(before)) {
    next = next.replace(before, after);
  } else {
    next = next.replace(
      /const deleteFile = \(file: P2PFile\) => runBusy\(async \(\) => \{[\s\S]*?\n\s*\}\);/,
      after
    );
  }

  if (next !== source) {
    fs.writeFileSync(file, next, 'utf8');
    changed = true;
    console.log(`[fast-delete-ui] patched ${file}`);
  } else {
    console.log(`[fast-delete-ui] deleteFile block not found in ${file}`);
  }
}

if (!changed) {
  console.log('[fast-delete-ui] no changes needed');
}
