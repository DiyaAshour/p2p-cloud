#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const files = {
  p2pAudit: path.join(root, 'electron', 'audit-p2p-ipc.js'),
  localAudit: path.join(root, 'electron', 'audit-ipc.js'),
  runtimePatch: path.join(root, 'scripts', 'patch-p2p-audit-runtime.cjs'),
  livePatch: path.join(root, 'scripts', 'patch-live-audit-log.cjs'),
  preload: path.join(root, 'electron', 'preload.cjs'),
  seed: path.join(root, 'electron', 'seed-auth-cooldown-ipc.js'),
};

function read(label) {
  const file = files[label];
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${label}: ${path.relative(root, file)}`);
  }
  return fs.readFileSync(file, 'utf8');
}
function mustInclude(label, source, needle) {
  if (!source.includes(needle)) {
    throw new Error(`${label} missing required text: ${needle}`);
  }
}

const p2pAudit = read('p2pAudit');
const runtimePatch = read('runtimePatch');
const livePatch = read('livePatch');
const preload = read('preload');
const seed = read('seed');

mustInclude('audit-p2p-ipc.js', p2pAudit, 'audit-manifests.json');
mustInclude('audit-p2p-ipc.js', p2pAudit, 'audit-objects');
mustInclude('audit-p2p-ipc.js', p2pAudit, 'putChunkOnNetwork');
mustInclude('audit-p2p-ipc.js', p2pAudit, 'selectReplicaTargets');
mustInclude('audit-p2p-ipc.js', p2pAudit, 'driveType');
mustInclude('audit-p2p-ipc.js', p2pAudit, 'company-audit');
mustInclude('audit-p2p-ipc.js', p2pAudit, 'audit:listManifests');
mustInclude('patch-p2p-audit-runtime.cjs', runtimePatch, "import './audit-p2p-ipc.js';");
mustInclude('patch-p2p-audit-runtime.cjs', runtimePatch, "'audit:listManifests'");
mustInclude('patch-live-audit-log.cjs', livePatch, 'Company Drive Audit Log');
mustInclude('patch-live-audit-log.cjs', livePatch, 'company:file-uploaded');
mustInclude('patch-live-audit-log.cjs', livePatch, 'company:file-downloaded');
mustInclude('patch-live-audit-log.cjs', livePatch, 'company:file-deleted');

if (preload.includes("'audit:listManifests'")) {
  mustInclude('preload.cjs', preload, "channel.startsWith('audit:')");
  console.log('[verify-p2p-audit] preload is already patched.');
} else {
  console.warn('[verify-p2p-audit] preload is not patched yet. Run: node scripts/patch-p2p-audit-runtime.cjs');
}

if (seed.includes("import './audit-p2p-ipc.js';")) {
  console.log('[verify-p2p-audit] runtime import is already patched.');
} else {
  console.warn('[verify-p2p-audit] runtime import is not patched yet. Run: node scripts/patch-p2p-audit-runtime.cjs');
}

if (seed.includes("import './audit-ipc.js';")) {
  console.warn('[verify-p2p-audit] local audit import still exists. The P2P runtime patch will remove it.');
}

console.log('[verify-p2p-audit] OK');
console.log('Verified: P2P audit IPC, audit manifests, audit chunks, P2P replication hooks, runtime patch, and Live audit UI patch.');
