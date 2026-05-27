const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const clientRoot = path.join(root, 'client', 'src');

const ignoredDirs = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const allowedFiles = new Set([
  // Keep this list intentionally small. Renderer code should use window.electron.invoke.
]);

const forbiddenPatterns = [
  {
    name: 'browser fetch is not allowed in renderer data path',
    pattern: /\bfetch\s*\(/,
  },
  {
    name: 'axios is not allowed in renderer data path',
    pattern: /\baxios\s*\./,
  },
  {
    name: 'axios import is not allowed in renderer data path',
    pattern: /from\s+['"]axios['"]|require\(\s*['"]axios['"]\s*\)/,
  },
  {
    name: 'direct XMLHttpRequest is not allowed in renderer data path',
    pattern: /\bXMLHttpRequest\b/,
  },
  {
    name: 'VITE_P2P_API_BASE_URL is forbidden; renderer must not know backend API URLs',
    pattern: /VITE_P2P_API_BASE_URL/,
  },
  {
    name: 'VITE_API_URL is forbidden for P2P renderer data path',
    pattern: /VITE_API_URL/,
  },
  {
    name: 'browser local P2P HTTP endpoint is forbidden in renderer',
    pattern: /http:\/\/(127\.0\.0\.1|localhost):(?:3000|4000|8787|8788|8790|8791|8792)/,
  },
  {
    name: 'browser P2P websocket endpoint is forbidden in renderer',
    pattern: /ws:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)/,
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
    if (!/\.(js|jsx|ts|tsx)$/.test(entry.name)) continue;
    if (allowedFiles.has(relative)) continue;
    files.push({ absolute, relative });
  }
  return files;
}

const failures = [];

for (const file of walk(clientRoot)) {
  const text = fs.readFileSync(file.absolute, 'utf8');
  for (const rule of forbiddenPatterns) {
    if (rule.pattern.test(text)) failures.push(`${file.relative}: ${rule.name}`);
  }
}

if (failures.length > 0) {
  console.error('[verify-electron-only-renderer] failed: renderer must use window.electron.invoke for app data');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-electron-only-renderer] ok: renderer data path is Electron-only');
