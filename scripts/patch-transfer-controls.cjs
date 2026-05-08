const fs = require('node:fs');

const p = 'electron/main.js';
if (!fs.existsSync(p)) process.exit(0);
let s = fs.readFileSync(p, 'utf8');
const before = s;

function replaceAll(from, to) {
  if (s.includes(from)) s = s.split(from).join(to);
}
function insertAfter(marker, code) {
  if (!s.includes(marker) || s.includes(code.trim().split('\n')[0])) return;
  s = s.replace(marker, marker + '\n' + code);
}

// Emergency stabilization: remove unstable pause/resume code inserted by older patches.
s = s.replace(/\nfunction ensureTransferControlState\(\) \{[\s\S]*?\n\}\n(?=function normalizeTransferType)/g, '\n');
s = s.replace(/\nfunction bindTransferControlToReadStream\(stream, kind\) \{[\s\S]*?\n\}\n(?=function resetTransferControl)/g, '\n');
s = s.replace(/\n\s*bindTransferControlToReadStream\(input, 'upload'\);/g, '');
s = s.replace(/ipcMain\.handle\('p2p:pauseTransfer',[\s\S]*?\n\}\);\n\n/g, '');
s = s.replace(/ipcMain\.handle\('p2p:resumeTransfer',[\s\S]*?\n\}\);\n\n/g, '');

insertAfter(
  "let transferProgress = { upload: null, download: null };",
  `let transferControl = { upload: { cancelled: false }, download: { cancelled: false } };

function normalizeTransferType(type = 'upload') {
  return type === 'download' ? 'download' : 'upload';
}

function resetTransferControl(kind) {
  transferControl[kind] = { cancelled: false };
}

async function waitForTransferControl(kind) {
  const type = normalizeTransferType(kind);
  if (transferControl[type]?.cancelled) throw new Error(type === 'upload' ? 'Upload cancelled' : 'Download cancelled');
}
`
);

// Remove duplicate helper blocks if older patches inserted them multiple times.
s = s.replace(/let transferControl = \{ upload: \{ cancelled: false \}, download: \{ cancelled: false \} \};\n\nlet transferControl = \{ upload: \{[^\n]+\n/g, "let transferControl = { upload: { cancelled: false }, download: { cancelled: false } };\n");
s = s.replace(/function normalizeTransferType\(type = 'upload'\) \{[\s\S]*?\n\}\n\nfunction normalizeTransferType\(type = 'upload'\)/g, "function normalizeTransferType(type = 'upload')");
s = s.replace(/function resetTransferControl\(kind\) \{[\s\S]*?\n\}\n\nfunction resetTransferControl\(kind\)/g, "function resetTransferControl(kind)");
s = s.replace(/async function waitForTransferControl\(kind\) \{[\s\S]*?\n\}\n\nasync function waitForTransferControl\(kind\)/g, "async function waitForTransferControl(kind)");

// Reset stale cancel state before each new upload.
replaceAll(
  "ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => {\n  const result = await dialog.showOpenDialog",
  "ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => {\n  resetTransferControl('upload');\n  const result = await dialog.showOpenDialog"
);
replaceAll(
  "ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => {\n  resetTransferControl('upload');\n  resetTransferControl('upload');\n  const result = await dialog.showOpenDialog",
  "ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => {\n  resetTransferControl('upload');\n  const result = await dialog.showOpenDialog"
);
replaceAll(
  "async function uploadFilePathStreaming(filePath, payload = {}) {\n  const node = ensureTransport({});",
  "async function uploadFilePathStreaming(filePath, payload = {}) {\n  resetTransferControl('upload');\n  const node = ensureTransport({});"
);
replaceAll(
  "async function uploadFilePathStreaming(filePath, payload = {}) {\n  resetTransferControl('upload');\n  resetTransferControl('upload');\n  const node = ensureTransport({});",
  "async function uploadFilePathStreaming(filePath, payload = {}) {\n  resetTransferControl('upload');\n  const node = ensureTransport({});"
);

// Check cancel before each chunk operation.
replaceAll(
  "await mapWithConcurrency(chunkMetas, uploadConcurrency, async (chunk) => {\n      const chunkPayload",
  "await mapWithConcurrency(chunkMetas, uploadConcurrency, async (chunk) => {\n      await waitForTransferControl('upload');\n      const chunkPayload"
);
replaceAll(
  "await mapWithConcurrency(chunkMetas, uploadConcurrency, async (chunk) => {\n      await waitForTransferControl('upload');\n      await waitForTransferControl('upload');\n      const chunkPayload",
  "await mapWithConcurrency(chunkMetas, uploadConcurrency, async (chunk) => {\n      await waitForTransferControl('upload');\n      const chunkPayload"
);
replaceAll(
  "await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {\n      const local",
  "await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {\n      await waitForTransferControl('download');\n      const local"
);
replaceAll(
  "await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {\n      await waitForTransferControl('download');\n      await waitForTransferControl('download');\n      const local",
  "await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {\n      await waitForTransferControl('download');\n      const local"
);

const handlerMarker = "ipcMain.handle('electron:diagnostics'";
if (s.includes(handlerMarker) && !s.includes("ipcMain.handle('p2p:cancelTransfer'")) {
  const idx = s.indexOf(handlerMarker);
  const controls = `ipcMain.handle('p2p:cancelTransfer', async (_event, payload = {}) => {
  const type = normalizeTransferType(payload.type);
  transferControl[type].cancelled = true;
  finishProgress(type, 'error', type === 'upload' ? 'Upload cancelled' : 'Download cancelled');
  return { ok: true, type, progress: transferProgress[type] };
});

`;
  s = s.slice(0, idx) + controls + s.slice(idx);
}

// Upgrade any existing cancel handler to the minimal stable implementation.
s = s.replace(/ipcMain\.handle\('p2p:cancelTransfer',[\s\S]*?\n\}\);/, `ipcMain.handle('p2p:cancelTransfer', async (_event, payload = {}) => {
  const type = normalizeTransferType(payload.type);
  transferControl[type].cancelled = true;
  finishProgress(type, 'error', type === 'upload' ? 'Upload cancelled' : 'Download cancelled');
  return { ok: true, type, progress: transferProgress[type] };
});`);

if (s !== before) {
  fs.writeFileSync(p, s, 'utf8');
  console.log('[patch-transfer-controls] installed stable cancel-only transfer control');
} else {
  console.log('[patch-transfer-controls] stable cancel-only transfer control already installed');
}
