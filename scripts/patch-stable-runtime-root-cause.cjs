const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const mainPath = path.join(root, 'electron', 'main.js');
const stablePath = path.join(root, 'electron', 'main-stable.js');

function read(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
function write(file, value) { fs.writeFileSync(file, value, 'utf8'); }

function hasP2PHandlers(source) {
  return source.includes("ipcMain.handle('p2p:start'") && source.includes("ipcMain.handle('p2p:networkSummary'") && source.includes("ipcMain.handle('p2p:uploadFiles'") && source.includes("ipcMain.handle('p2p:updateFile'");
}

function patchAutoRepairStartup(source) {
  let next = source;
  next = next.replace(
    "  runAutoRepair('startup').catch((error) => console.warn('[auto-repair] startup failed:', error?.message || error));",
    "  const startDelayMs = Math.max(60_000, Number(process.env.P2P_AUTO_REPAIR_START_DELAY_MS || 5 * 60 * 1000));\n  setTimeout(() => {\n    runAutoRepair('delayed-startup').catch((error) => console.warn('[auto-repair] delayed startup failed:', error?.message || error));\n  }, startDelayMs).unref?.();"
  );
  return next;
}

function patchNetworkSummary(source) {
  let next = source;
  if (!next.includes('function safePeerList(') && next.includes('function networkSummary() {')) {
    next = next.replace(
      'function networkSummary() {',
      "function safePeerList(node) {\n  return Array.from(node.peerInfo?.values?.() || []).slice(0, 50).map((peer) => ({ peerId: String(peer.peerId || ''), url: peer.url || null, status: peer.status || null, direction: peer.direction || null, lastSeen: peer.lastSeen || null }));\n}\n\nfunction networkSummary() {"
    );
  }
  next = next.replace('peers: Array.from(node.peerInfo?.values?.() || [])', 'peers: safePeerList(node)');
  return next;
}

function patchSeedImport(source) {
  return source
    .replace("import './seed-auth-cooldown-ipc.js';\n", '')
    .replace("import './seed-auth-cooldown-ipc.js';\r\n", '');
}

if (!fs.existsSync(mainPath)) {
  console.warn('[stable-root-cause] electron/main.js missing; cannot restore main-stable');
  process.exit(0);
}

let main = read(mainPath);
if (!hasP2PHandlers(main)) {
  console.warn('[stable-root-cause] electron/main.js lacks required p2p handlers; leaving stable unchanged');
  process.exit(0);
}

main = patchSeedImport(patchNetworkSummary(patchAutoRepairStartup(main)));

const stable = read(stablePath);
if (!hasP2PHandlers(stable) || stable.length < main.length * 0.75) {
  write(stablePath, main);
  console.log('[stable-root-cause] restored electron/main-stable.js from complete main.js with safe startup repair');
} else {
  const patchedStable = patchSeedImport(patchNetworkSummary(patchAutoRepairStartup(stable)));
  if (patchedStable !== stable) {
    write(stablePath, patchedStable);
    console.log('[stable-root-cause] patched existing main-stable.js safe startup repair');
  } else {
    console.log('[stable-root-cause] main-stable.js already complete and safe');
  }
}
