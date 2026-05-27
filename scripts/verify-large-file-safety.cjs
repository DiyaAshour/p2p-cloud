const fs = require('node:fs');
const path = require('node:path');
const { IPC_CHANNELS } = require('../electron/ipc-contract.cjs');

const root = process.cwd();
const ignoredDirs = new Set(['.git', 'node_modules', '.pnpm-store', 'dist', 'release', 'coverage', '.next', '.cache']);

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
    name: 'renderer must not create downloads from returned Blob objects for app file transfers',
    pattern: /URL\.createObjectURL\s*\(/,
  },
  {
    name: 'renderer must not convert returned payloads into ArrayBuffer for app file transfers',
    pattern: /\.arrayBuffer\s*\(/,
  },
  {
    name: 'renderer must not convert large returned payloads through base64 decode',
    pattern: /\batob\s*\(/,
  },
  {
    name: 'renderer must not construct file Buffers',
    pattern: /\bBuffer\.from\s*\(/,
  },
  {
    name: 'renderer must not use FileReader to materialize app file transfers in memory',
    pattern: /\bFileReader\b/,
  },
  {
    name: 'legacy p2p:download channel is forbidden; use p2p:downloadToPath',
    pattern: /['"]p2p:download['"]/,
  },
];

const electronForbidden = [
  {
    name: 'legacy p2p:download handler is forbidden; use p2p:downloadToPath',
    pattern: /ipcMain\.handle\(\s*['"]p2p:download['"]/,
  },
  {
    name: 'download handlers must not return base64 file payloads',
    pattern: /return\s+[^;\n]*(?:base64|fileBase64|dataBase64)/i,
  },
  {
    name: 'download handlers must not return raw Buffer payloads to renderer',
    pattern: /return\s+[^;\n]*Buffer\.(?:from|concat)\s*\(/,
  },
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) walk(absolute, files);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!/\.(cjs|mjs|js|jsx|ts|tsx)$/.test(entry.name)) continue;
    files.push({ absolute, relative });
  }
  return files;
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

for (const file of requiredRuntimeFiles) {
  const text = assertFile(file);
  if (!text.includes('downloadToPath') && file.includes('download')) failures.push(`${file}: expected downloadToPath implementation marker`);
  if (!text.includes('upload') && file.includes('upload')) failures.push(`${file}: expected upload streaming implementation marker`);
}

for (const file of walk(path.join(root, 'client', 'src'))) {
  const text = fs.readFileSync(file.absolute, 'utf8');
  for (const rule of rendererForbidden) {
    if (rule.pattern.test(text)) failures.push(`${file.relative}: ${rule.name}`);
  }
}

for (const file of walk(path.join(root, 'electron'))) {
  if (file.relative === 'electron/download-to-path-override.js') continue;
  const text = fs.readFileSync(file.absolute, 'utf8');
  for (const rule of electronForbidden) {
    if (rule.pattern.test(text)) failures.push(`${file.relative}: ${rule.name}`);
  }
}

if (failures.length > 0) {
  console.error('[verify-large-file-safety] failed: unsafe large file transfer path detected');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-large-file-safety] ok: large files stay out of renderer memory and use source-based transfer paths');
