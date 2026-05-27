const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const packagePath = path.join(root, 'package.json');
const workflowPath = path.join(root, '.github', 'workflows', 'verify.yml');
const readmePath = path.join(root, 'README.md');

function readRequired(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing required release readiness file: ${label}`);
  return fs.readFileSync(filePath, 'utf8');
}

const pkg = JSON.parse(readRequired(packagePath, 'package.json'));
const workflow = readRequired(workflowPath, '.github/workflows/verify.yml');
const readme = readRequired(readmePath, 'README.md');
const scripts = pkg.scripts || {};
const failures = [];

const requiredScripts = [
  'security:scan',
  'production:scan',
  'verify:ipc',
  'verify:renderer',
  'verify:large-files',
  'verify:manifest-auth',
  'verify:storage-peer',
  'verify:bootstrap',
  'verify:wallet-payment',
  'verify:encryption',
  'verify:release',
  'verify',
  'renderer:build',
  'package:win',
];

for (const script of requiredScripts) {
  if (!scripts[script]) failures.push(`package.json missing required script: ${script}`);
}

const verifyMustRun = [
  'security:scan',
  'production:scan',
  'verify:ipc',
  'verify:renderer',
  'verify:large-files',
  'verify:manifest-auth',
  'verify:storage-peer',
  'verify:bootstrap',
  'verify:wallet-payment',
  'verify:encryption',
];

for (const script of verifyMustRun) {
  if (!String(scripts.verify || '').includes(`pnpm run ${script}`)) failures.push(`pnpm verify does not run ${script}`);
  if (!String(scripts['prepare:final'] || '').includes(`pnpm run ${script}`)) failures.push(`pnpm prepare:final does not run ${script}`);
}

if (!String(scripts['renderer:build'] || '').startsWith('pnpm run prepare:final &&')) {
  failures.push('renderer:build must start with pnpm run prepare:final');
}
if (!String(scripts['package:win'] || '').includes('pnpm run renderer:build')) {
  failures.push('package:win must depend on renderer:build');
}
if (!String(scripts.build || '').includes('pnpm run package:win')) {
  failures.push('build must depend on package:win');
}

for (const script of verifyMustRun) {
  if (!workflow.includes(`pnpm ${script}`)) failures.push(`GitHub Actions workflow does not explicitly run pnpm ${script}`);
}
if (!workflow.includes('pnpm verify')) failures.push('GitHub Actions workflow must run pnpm verify');
if (!workflow.includes('pnpm renderer:build')) failures.push('GitHub Actions workflow must run pnpm renderer:build');

const requiredReadmeSections = [
  'Manifest Auth Safety Policy',
  'Large File Safety Policy',
  'Electron-only Renderer Policy',
  'IPC Contract Policy',
  'Core Runtime Rules',
  'Legacy Scripts Policy',
  'Local Environment Policy',
];
for (const section of requiredReadmeSections) {
  if (!readme.includes(section)) failures.push(`README missing release readiness section: ${section}`);
}

const forbiddenShortcuts = [
  ['build:fast', 'vite build'],
];
for (const [name, unsafe] of forbiddenShortcuts) {
  if (scripts[name] && String(scripts[name]).trim() === unsafe) {
    failures.push(`${name} bypasses verification and must not be used for release builds`);
  }
}

if (failures.length > 0) {
  console.error('[verify-release-readiness] failed: release path is not fully guarded');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-release-readiness] ok: release build path is guarded by security, runtime, network, storage, payment, and encryption checks');
