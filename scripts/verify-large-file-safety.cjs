const fs = require('node:fs');
const path = require('node:path');
const { IPC_CHANNELS } = require('../electron/ipc-contract.cjs');

const root = process.cwd();
const clientRoot = path.join(root, 'client', 'src');
const rendererEntry = path.join(clientRoot, 'App.tsx');
const ignoredDirs = new Set(['.git', 'node_modules', '.pnpm-store', 'dist', 'release', 'coverage', '.next', '.cache']);
const sourceExtensions = ['.tsx', '.ts', '.jsx', '.js'];

const requiredChannels = [
  'p2p:downloadToPath',
  'p2p:uploadFiles',
  'p2p:cancelTransfer',
];

const requiredRuntimeFiles = [
  'electron/download-to-path-override.js',
  'electron/stream-upload-override.js',
];

const rendererForbidden = [
  {
    name: 'active renderer must not create downloads from returned Blob objects for app file transfers',
    pattern: /URL\.createObjectURL\s*\(/,
  },
  {
    name: 'active renderer must not convert returned payloads into ArrayBuffer for app file transfers',
    pattern: /\.arrayBuffer\s*\(/,
  },
  {
    name: 'active renderer must not convert large returned payloads through base64 decode',
    pattern: /\batob\s*\(/,
  },
  {
    name: 'active renderer must not construct file Buffers',
    pattern: /\bBuffer\.from\s*\(/,
  },
  {
    name: 'active renderer must not use FileReader to materialize app file transfers in memory',
    pattern: /\bFileReader\b/,
  },
  {
    name: 'active renderer must not use legacy p2p:download; use p2p:downloadToPath',
    pattern: /['"]p2p:download['"]/,
  },
];

function toRelative(file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function isUnderIgnoredDir(file) {
  return toRelative(file).split('/').some((part) => ignoredDirs.has(part));
}

function resolveWithExtensions(basePath) {
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) return basePath;

  for (const ext of sourceExtensions) {
    const candidate = `${basePath}${ext}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }

  if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    for (const ext of sourceExtensions) {
      const candidate = path.join(basePath, `index${ext}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }

  return null;
}

function resolveImport(fromFile, specifier) {
  if (!specifier || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) return null;
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return null;

  const base = specifier.startsWith('@/')
    ? path.join(clientRoot, specifier.slice(2))
    : path.resolve(path.dirname(fromFile), specifier);

  const resolved = resolveWithExtensions(base);
  if (!resolved || !resolved.startsWith(clientRoot) || isUnderIgnoredDir(resolved)) return null;
  return resolved;
}

function extractImports(text) {
  const imports = [];
  const patterns = [
    /import\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /export\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) imports.push(match[1]);
  }

  return imports;
}

function collectActiveRendererFiles() {
  if (!fs.existsSync(rendererEntry)) throw new Error(`Missing renderer entry: ${toRelative(rendererEntry)}`);

  const seen = new Set();
  const stack = [rendererEntry];

  while (stack.length) {
    const file = stack.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);

    const text = fs.readFileSync(file, 'utf8');
    for (const specifier of extractImports(text)) {
      const resolved = resolveImport(file, specifier);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }

  return Array.from(seen).sort();
}

function assertFile(relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) throw new Error(`Missing required large-file runtime file: ${relative}`);
  return fs.readFileSync(absolute, 'utf8');
}

const failures = [];

for (const channel of requiredChannels) {
  if (!IPC_CHANNELS.includes(channel)) failures.push(`IPC contract missing required large-file channel: ${channel}`);
}

const downloadOverride = assertFile('electron/download-to-path-override.js');
const streamUpload = assertFile('electron/stream-upload-override.js');

if (!downloadOverride.includes('p2p:downloadToPath')) failures.push('electron/download-to-path-override.js: missing p2p:downloadToPath handler marker');
if (!downloadOverride.includes('p2p:download')) failures.push('electron/download-to-path-override.js: legacy p2p:download must be overridden to disk-first path');
if (!downloadOverride.includes('ipcMain.removeHandler(channel)')) failures.push('electron/download-to-path-override.js: expected legacy download handlers to be removed before override');
if (!downloadOverride.includes('fs.createWriteStream')) failures.push('electron/download-to-path-override.js: expected disk write stream for chunk download');
if (!downloadOverride.includes('dialog.showSaveDialog')) failures.push('electron/download-to-path-override.js: expected native save dialog path selection');
if (!downloadOverride.includes('bytes: []')) failures.push('electron/download-to-path-override.js: download result must not return file bytes to renderer');

if (!streamUpload.includes('fs.createReadStream')) failures.push('electron/stream-upload-override.js: expected fs.createReadStream upload path');
if (!streamUpload.includes('p2p:uploadFiles')) failures.push('electron/stream-upload-override.js: missing p2p:uploadFiles handler marker');

for (const relative of requiredRuntimeFiles) assertFile(relative);

const activeRendererFiles = collectActiveRendererFiles();
for (const file of activeRendererFiles) {
  const text = fs.readFileSync(file, 'utf8');
  for (const rule of rendererForbidden) {
    if (rule.pattern.test(text)) failures.push(`${toRelative(file)}: ${rule.name}`);
  }
}

if (!activeRendererFiles.some((file) => fs.readFileSync(file, 'utf8').includes('p2p:downloadToPath'))) {
  failures.push('active renderer does not use p2p:downloadToPath for downloads');
}

if (failures.length > 0) {
  console.error('[verify-large-file-safety] failed: unsafe large file transfer path detected');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-large-file-safety] ok: active large-file paths stay out of renderer memory and use disk-first transfer handlers', {
  rendererEntry: toRelative(rendererEntry),
  activeRendererFiles: activeRendererFiles.length,
});
