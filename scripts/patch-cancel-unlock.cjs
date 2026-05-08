const fs = require('node:fs');

function patchNativeApp() {
  const p = 'client/src/NativeP2PApp.tsx';
  if (!fs.existsSync(p)) return;
  let s = fs.readFileSync(p, 'utf8');
  const before = s;

  const marker = '  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);';
  const listener = `
  useEffect(() => {
    const unlockAfterTransferCancel = () => {
      setBusy(false);
      setSelectedFiles([]);
      void refreshAll().catch(() => {});
    };
    window.addEventListener('chunknet:transfer-cancelled', unlockAfterTransferCancel);
    return () => window.removeEventListener('chunknet:transfer-cancelled', unlockAfterTransferCancel);
  }, []);`;

  if (s.includes(marker) && !s.includes('chunknet:transfer-cancelled')) {
    s = s.replace(marker, marker + '\n' + listener);
  }

  if (s !== before) {
    fs.writeFileSync(p, s, 'utf8');
    console.log('[patch-cancel-unlock] Native app unlocks upload UI after cancel');
  }
}

function patchOverlay() {
  const p = 'client/src/TransferProgressOverlay.tsx';
  if (!fs.existsSync(p)) return;
  let s = fs.readFileSync(p, 'utf8');
  const before = s;

  const oldCancel = "onClick={() => void controlTransfer(type, 'cancel')}";
  const newCancel = "onClick={() => { void controlTransfer(type, 'cancel').finally(() => { window.dispatchEvent(new CustomEvent('chunknet:transfer-cancelled', { detail: { type } })); onDismiss(); }); }}";
  if (s.includes(oldCancel)) s = s.replace(oldCancel, newCancel);

  if (s !== before) {
    fs.writeFileSync(p, s, 'utf8');
    console.log('[patch-cancel-unlock] Cancel now unlocks upload UI immediately');
  }
}

patchNativeApp();
patchOverlay();
