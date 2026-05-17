const fs = require('node:fs');
for (const f of ['electron/main.js', 'electron/main-stable.js']) {
  if (!fs.existsSync(f)) continue;
  let s = fs.readFileSync(f, 'utf8');
  const before = s;
  s = s.replace("ipcMain.handle('wallet:status', async () => walletSummary());", "ipcMain.handle('wallet:status', async () => { loadWallet(); return walletSummary(); });");
  s = s.replace("ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => { if (!walletState.connected || !walletState.verified) return [];", "ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => { loadWallet(); if (!walletState.connected || !walletState.verified) return [];");
  if (s !== before) fs.writeFileSync(f, s, 'utf8');
  console.log(s === before ? `[wallet-status-reload] ok ${f}` : `[wallet-status-reload] patched ${f}`);
}
