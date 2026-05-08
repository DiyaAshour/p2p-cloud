const fs = require('node:fs');

const p = 'electron/main.js';
if (!fs.existsSync(p)) process.exit(0);
let s = fs.readFileSync(p, 'utf8');
const before = s;

function insertAfter(marker, code) {
  if (!s.includes(marker) || s.includes(code.trim().split('\n')[0])) return;
  s = s.replace(marker, marker + '\n' + code);
}

function replaceAll(from, to) {
  if (s.includes(from)) s = s.split(from).join(to);
}

insertAfter(
  "let transferProgress = { upload: null, download: null };",
  `let transferControl = { upload: { paused: false, cancelled: false }, download: { paused: false, cancelled: false } };

function normalizeTransferType(type = 'upload') {
  return type === 'download' ? 'download' : 'upload';
}

function resetTransferControl(kind) {
  transferControl[kind] = { paused: false, cancelled: false };
}

async function waitForTransferControl(kind) {
  const type = normalizeTransferType(kind);
  while (transferControl[type]?.paused && !transferControl[type]?.cancelled) {
    updateProgress(type, { phase: 'paused' });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (transferControl[type]?.cancelled) throw new Error(type === 'upload' ? 'Upload cancelled' : 'Download cancelled');
}
`
);

replaceAll(
  "  const now = Date.now();\n  transferProgress[kind] = {",
  "  resetTransferControl(kind);\n  const now = Date.now();\n  transferProgress[kind] = {"
);

replaceAll(
  "    error: null,\n  };",
  "    error: null,\n    paused: false,\n    cancellable: true,\n  };"
);

replaceAll(
  "    phase,\n    transferredBytes,",
  "    phase: transferControl[kind]?.paused ? 'paused' : phase,\n    transferredBytes,"
);

replaceAll(
  "    error,\n  };",
  "    error,\n    paused: Boolean(transferControl[kind]?.paused),\n    cancellable: true,\n  };"
);

// Check pause/cancel before each chunk operation in upload and download workers.
replaceAll(
  "await mapWithConcurrency(chunkMetas, uploadConcurrency, async (chunk) => {\n      const chunkPayload",
  "await mapWithConcurrency(chunkMetas, uploadConcurrency, async (chunk) => {\n      await waitForTransferControl('upload');\n      const chunkPayload"
);
replaceAll(
  "await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {\n      const local",
  "await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {\n      await waitForTransferControl('download');\n      const local"
);

const handlerMarker = "ipcMain.handle('electron:diagnostics'";
if (s.includes(handlerMarker) && !s.includes("ipcMain.handle('p2p:pauseTransfer'")) {
  const idx = s.indexOf(handlerMarker);
  const controls = `ipcMain.handle('p2p:pauseTransfer', async (_event, payload = {}) => {
  const type = normalizeTransferType(payload.type);
  transferControl[type].paused = true;
  updateProgress(type, { phase: 'paused' });
  return { ok: true, type, progress: transferProgress[type] };
});

ipcMain.handle('p2p:resumeTransfer', async (_event, payload = {}) => {
  const type = normalizeTransferType(payload.type);
  transferControl[type].paused = false;
  updateProgress(type, { phase: 'running' });
  return { ok: true, type, progress: transferProgress[type] };
});

ipcMain.handle('p2p:cancelTransfer', async (_event, payload = {}) => {
  const type = normalizeTransferType(payload.type);
  transferControl[type].cancelled = true;
  transferControl[type].paused = false;
  finishProgress(type, 'error', type === 'upload' ? 'Upload cancelled' : 'Download cancelled');
  return { ok: true, type, progress: transferProgress[type] };
});

`;
  s = s.slice(0, idx) + controls + s.slice(idx);
}

if (s !== before) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-transfer-controls] installed pause/resume/cancel controls');
} else {
  console.log('[patch-transfer-controls] transfer controls already installed');
}
