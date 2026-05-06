const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function write(rel, content) { fs.writeFileSync(path.join(root, rel), content, 'utf8'); console.log(`[stability-mode] patched ${rel}`); }

function replaceAllExact(src, pairs) {
  for (const [from, to] of pairs) {
    if (src.includes(from)) src = src.replaceAll(from, to);
  }
  return src;
}

function patchMain() {
  const rel = 'electron/main.js';
  let src = read(rel);

  // Progress polling must be instant/local only. Pulling manifests every second makes the app feel frozen.
  src = replaceAllExact(src, [
    ["ipcMain.handle('p2p:networkSummary', async () => { await syncPull(); return networkSummary(); });", "ipcMain.handle('p2p:networkSummary', async () => networkSummary());"],
    ["ipcMain.handle('p2p:networkSummary', async (_event, payload = {}) => { await syncPull(); return networkSummary(); });", "ipcMain.handle('p2p:networkSummary', async () => networkSummary());"],
    ["ipcMain.handle('p2p:networkSummary', async (_event) => { await syncPull(); return networkSummary(); });", "ipcMain.handle('p2p:networkSummary', async () => networkSummary());"],
  ]);

  // If the older handler got patched with try/catch, still keep it fully local.
  src = src.replace(/ipcMain\.handle\('p2p:networkSummary',\s*async\s*\([^)]*\)\s*=>\s*\{\s*try\s*\{\s*await syncPull\(\);\s*\}\s*catch\s*\([^)]*\)\s*\{[^}]*\}\s*return networkSummary\(\);\s*\}\);/s, "ipcMain.handle('p2p:networkSummary', async () => networkSummary());");

  // Auto repair during upload/download competes for CPU, disk, network, and makes controls feel stuck.
  if (!src.includes("[auto-repair] skipped during active transfer")) {
    src = src.replace(
      "async function runAutoRepair(reason = 'interval') {\n",
      "async function runAutoRepair(reason = 'interval') {\n  if (transferProgress.upload?.active || transferProgress.download?.active) {\n    lastAutoRepairStatus = { ...lastAutoRepairStatus, active: Boolean(autoRepairTimer), skippedReason: 'active-transfer', error: null };\n    console.log('[auto-repair] skipped during active transfer');\n    return lastAutoRepairStatus;\n  }\n"
    );
  }

  // Keep safety peer from making the desktop heavy by default. Users can raise these later.
  src = replaceAllExact(src, [
    ["const SAFETY_UPLOAD_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.P2P_SAFETY_UPLOAD_CONCURRENCY || 2)));", "const SAFETY_UPLOAD_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.P2P_SAFETY_UPLOAD_CONCURRENCY || 1)));"] ,
    ["const SAFETY_UPLOAD_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.P2P_SAFETY_UPLOAD_CONCURRENCY || 2)));", "const SAFETY_UPLOAD_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.P2P_SAFETY_UPLOAD_CONCURRENCY || 1)));"] ,
    ["const SAFETY_UPLOAD_MAX_QUEUE = Math.max(0, Number(process.env.P2P_SAFETY_UPLOAD_MAX_QUEUE || 32));", "const SAFETY_UPLOAD_MAX_QUEUE = Math.max(0, Number(process.env.P2P_SAFETY_UPLOAD_MAX_QUEUE || 4));"],
    ["const SAFETY_UPLOAD_MAX_QUEUE = Math.max(0, Number(process.env.P2P_SAFETY_UPLOAD_MAX_QUEUE || 8));", "const SAFETY_UPLOAD_MAX_QUEUE = Math.max(0, Number(process.env.P2P_SAFETY_UPLOAD_MAX_QUEUE || 4));"],
  ]);

  // Make cancel clear queued safety work immediately, even if the earlier transfer-control patch exists.
  if (src.includes("function setTransferCanceled(kind)")) {
    src = src.replace(/function setTransferCanceled\(kind\) \{[\s\S]*?return \{ ok: true, kind, paused: false, canceled: true \};\n\}/, `function setTransferCanceled(kind) {
  if (!transferControl[kind]) transferControl[kind] = { paused: false, canceled: false };
  transferControl[kind].canceled = true;
  transferControl[kind].paused = false;
  if (kind === 'upload') backgroundSafetyQueue = [];
  finishProgress(kind, 'canceled', 'Canceled by user');
  return { ok: true, kind, paused: false, canceled: true };
}`);
  }

  write(rel, src);
}

function patchOverlay() {
  const rel = 'client/src/TransferProgressOverlay.tsx';
  let src = read(rel);

  // Polling every second was causing repeated IPC work; 2s is smoother and still accurate enough.
  src = src.replace('const timer = window.setInterval(() => void tick(), 1000);', 'const timer = window.setInterval(() => void tick(), 2000);');

  // Show paused/canceled clearly.
  src = src.replace("{isError ? 'Error' : `${percent.toFixed(0)}%`}", "{progress.phase === 'canceled' ? 'Canceled' : progress.phase === 'paused' ? 'Paused' : isError ? 'Error' : `${percent.toFixed(0)}%`}");

  write(rel, src);
}

function patchPreload() {
  const rel = 'electron/preload.cjs';
  let src = read(rel);
  for (const channel of ['p2p:pauseTransfer', 'p2p:resumeTransfer', 'p2p:cancelTransfer']) {
    if (!src.includes(`'${channel}'`)) src = src.replace("  'p2p:networkSummary',\n", `  'p2p:networkSummary',\n  '${channel}',\n`);
  }
  write(rel, src);
}

patchPreload();
patchMain();
patchOverlay();
console.log('[stability-mode] done');
