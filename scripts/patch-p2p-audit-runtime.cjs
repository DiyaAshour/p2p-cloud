#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const seedFile = path.join(root, 'electron', 'seed-auth-cooldown-ipc.js');
const preloadFile = path.join(root, 'electron', 'preload.cjs');

function ensureFile(file, label) {
  if (!fs.existsSync(file)) {
    console.error(`[patch-p2p-audit-runtime] Missing ${label}`);
    process.exit(1);
  }
}

function patchSeed() {
  ensureFile(seedFile, 'electron/seed-auth-cooldown-ipc.js');
  let source = fs.readFileSync(seedFile, 'utf8');
  source = source.replace("import './audit-ipc.js';\n", '');
  const line = "import './audit-p2p-ipc.js';";
  if (!source.includes(line)) {
    const anchor = "import './company-drive-ipc.js';";
    if (!source.includes(anchor)) {
      console.error('[patch-p2p-audit-runtime] company-drive import anchor not found');
      process.exit(1);
    }
    source = source.replace(anchor, `${anchor}\n${line}`);
  }
  fs.writeFileSync(seedFile, source, 'utf8');
  console.log('[patch-p2p-audit-runtime] audit-p2p import ready');
}

function patchPreload() {
  ensureFile(preloadFile, 'electron/preload.cjs');
  let source = fs.readFileSync(preloadFile, 'utf8');
  const needed = ["'audit:list'", "'audit:record'", "'audit:clear'", "'audit:listManifests'"];
  if (!needed.every((channel) => source.includes(channel))) {
    const anchor = "  'electron:openDevTools',";
    if (!source.includes(anchor)) {
      console.error('[patch-p2p-audit-runtime] electron channel anchor not found');
      process.exit(1);
    }
    source = source.replace(anchor, `  'audit:list',\n  'audit:record',\n  'audit:clear',\n  'audit:listManifests',\n\n${anchor}`);
  }
  source = source.replace(
    "channel.startsWith('company:') || channel.startsWith('drive:')",
    "channel.startsWith('company:') || channel.startsWith('audit:') || channel.startsWith('drive:')"
  );
  fs.writeFileSync(preloadFile, source, 'utf8');
  console.log('[patch-p2p-audit-runtime] preload audit channels ready');
}

patchSeed();
patchPreload();
console.log('[patch-p2p-audit-runtime] OK');
