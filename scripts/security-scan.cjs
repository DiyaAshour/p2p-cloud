const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();

const ignoredDirs = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  'dist',
  'release',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  'tmp',
  'temp',
]);

const ignoredFiles = new Set([
  '.env.example',
  'scripts/security-scan.cjs',
  'المرجع.md',
]);

const secretPatterns = [
  {
    name: 'WalletConnect project id assigned in committed file',
    pattern: /VITE_WALLETCONNECT_PROJECT_ID\s*=\s*(?!$|replace-|your-|YOUR_|\s)([A-Za-z0-9_-]{16,})/i,
  },
  {
    name: 'PayPal client secret assigned in committed file',
    pattern: /PAYPAL_CLIENT_SECRET\s*=\s*(?!$|replace-|your-|YOUR_|\s)([^\s#]+)/i,
  },
  {
    name: 'Manifest sync auth secret assigned in committed file',
    pattern: /(?:P2P_)?MANIFEST_SYNC_AUTH_SECRET\s*=\s*(?!$|replace-|your-|YOUR_|\s)([^\s#]+)/i,
  },
  {
    name: 'Private key assigned in committed file',
    pattern: /(?:PRIVATE_KEY|WALLET_PRIVATE_KEY|DEPLOYER_PRIVATE_KEY)\s*=\s*(0x)?[a-f0-9]{64}/i,
  },
];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) walk(absolute, files);
      continue;
    }

    if (!entry.isFile()) continue;
    if (ignoredFiles.has(relative)) continue;
    if (entry.name.endsWith('.png') || entry.name.endsWith('.jpg') || entry.name.endsWith('.jpeg') || entry.name.endsWith('.ico') || entry.name.endsWith('.zip')) continue;
    files.push(relative);
  }
  return files;
}

function readText(relative) {
  const absolute = path.join(root, relative);
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) return '';
  return buffer.toString('utf8');
}

const failures = [];

for (const file of walk(root)) {
  const text = readText(file);
  if (!text) continue;

  if (file === '.env') {
    const unsafeEnv = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    if (unsafeEnv.length > 0) {
      failures.push({ file, issue: '.env must not contain committed environment values' });
    }
  }

  for (const rule of secretPatterns) {
    if (rule.pattern.test(text)) failures.push({ file, issue: rule.name });
  }
}

if (failures.length > 0) {
  console.error('[security-scan] failed: possible committed secrets or unsafe env values found');
  for (const failure of failures) console.error(`- ${failure.file}: ${failure.issue}`);
  process.exit(1);
}

console.log('[security-scan] ok: no committed secrets detected by project rules');
