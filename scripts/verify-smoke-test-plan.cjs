const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const smokePath = path.join(root, 'docs', 'RELEASE_SMOKE_TEST.md');
const releaseVerifierPath = path.join(root, 'scripts', 'verify-release-readiness.cjs');
const packagePath = path.join(root, 'package.json');

function readRequired(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing required smoke test file: ${label}`);
  return fs.readFileSync(filePath, 'utf8');
}

const smoke = readRequired(smokePath, 'docs/RELEASE_SMOKE_TEST.md');
const releaseVerifier = readRequired(releaseVerifierPath, 'scripts/verify-release-readiness.cjs');
const pkg = JSON.parse(readRequired(packagePath, 'package.json'));
const failures = [];

const requiredSections = [
  'Automated Gate',
  'Clean Install Smoke Test',
  'Identity / Wallet Smoke Test',
  'Local Upload / Download Smoke Test',
  'Multi-Peer Network Smoke Test',
  'Manifest Sync Smoke Test',
  'Storage Peer Smoke Test',
  'Payment / Paid Plan Smoke Test',
  'Encryption / Cross-Device Smoke Test',
  'Release Decision',
];

for (const section of requiredSections) {
  if (!smoke.includes(section)) failures.push(`Smoke test plan missing section: ${section}`);
}

const requiredCommands = [
  'pnpm install --frozen-lockfile',
  'pnpm verify',
  'pnpm renderer:build',
  'pnpm package:win',
];
for (const command of requiredCommands) {
  if (!smoke.includes(command)) failures.push(`Smoke test plan missing command: ${command}`);
}

const requiredSignals = [
  '1 GB+',
  'downloadToPath',
  'MANIFEST_SYNC_REQUIRE_AUTH=true',
  'STORAGE_PEER_ADMIN_TOKEN',
  'P2P_PLAN_UNLOCK_SECRET',
  'PLAN_UNLOCK_SECRET',
  'planUnlockToken',
  'same wallet/seed and drive password',
  'Wrong identity/password fails authentication',
  'Record test results in the release notes',
];
for (const signal of requiredSignals) {
  if (!smoke.includes(signal)) failures.push(`Smoke test plan missing required signal: ${signal}`);
}

if (!releaseVerifier.includes('docs/RELEASE_SMOKE_TEST.md') && !releaseVerifier.includes('RELEASE_SMOKE_TEST.md')) {
  failures.push('Release readiness verifier must require docs/RELEASE_SMOKE_TEST.md');
}
if (!pkg.scripts?.['verify:smoke-plan']) failures.push('package.json missing verify:smoke-plan script');
if (!String(pkg.scripts?.verify || '').includes('verify:smoke-plan')) failures.push('pnpm verify must run verify:smoke-plan');
if (!String(pkg.scripts?.['prepare:final'] || '').includes('verify:smoke-plan')) failures.push('pnpm prepare:final must run verify:smoke-plan');

if (failures.length > 0) {
  console.error('[verify-smoke-test-plan] failed: release smoke test plan is incomplete or not enforced');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-smoke-test-plan] ok: release smoke test checklist covers install, identity, transfer, network, manifest, storage, payment, and encryption');
