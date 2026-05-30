const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const clientRoot = path.join(root, 'client', 'src');
const entryPath = path.join(clientRoot, 'App.tsx');

const extensions = ['.tsx', '.ts', '.jsx', '.js'];
const ignoredDirs = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

const forbiddenPatterns = [
  {
    name: 'browser fetch is not allowed in active renderer data path',
    pattern: /\bfetch\s*\(/,
  },
  {
    name: 'axios is not allowed in active renderer data path',
    pattern: /\baxios\s*\./,
  },
  {
    name: 'axios import is not allowed in active renderer data path',
    pattern: /from\s+['"]axios['"]|require\(\s*['"]axios['"]\s*\)/,
  },
  {
    name: 'direct XMLHttpRequest is not allowed in active renderer data path',
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
    name: 'browser local P2P HTTP endpoint is forbidden in active renderer',
    pattern: /http:\/\/(127\.0\.0\.1|localhost):(?:3000|4000|8787|8788|8790|8791|8792)/,
  },
  {
    name: 'browser P2P websocket endpoint is forbidden in active renderer',
    pattern: /ws:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)/,
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

  for (const ext of extensions) {
    const candidate = `${basePath}${ext}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }

  if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    for (const ext of extensions) {
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
  if (!fs.existsSync(entryPath)) throw new Error(`Missing renderer entry: ${toRelative(entryPath)}`);

  const seen = new Set();
  const stack = [entryPath];

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

const failures = [];
const activeFiles = collectActiveRendererFiles();

for (const file of activeFiles) {
  if (!/\.(js|jsx|ts|tsx)$/.test(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const rule of forbiddenPatterns) {
    if (rule.pattern.test(text)) failures.push(`${toRelative(file)}: ${rule.name}`);
  }
}

if (failures.length > 0) {
  console.error('[verify-electron-only-renderer] failed: active renderer must use window.electron.invoke for app data');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-electron-only-renderer] ok: active renderer data path is Electron-only', {
  entry: toRelative(entryPath),
  activeFiles: activeFiles.length,
});
