#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const seedFile = path.join(root, 'electron', 'seed-auth-cooldown-ipc.js');
const preloadFile = path.join(root, 'electron', 'preload.cjs');

function patchSeed() {
  if (!fs.existsSync(seedFile)) throw new Error('Missing electron/seed-auth-cooldown-ipc.js');
  let source = fs.readFileSync(seedFile, 'utf8');
  const line = "import './audit-ipc.js';";
  if (!source.includes(line)) {
    const anchor = "import './company-drive-ipc.js';";
    if (!source.includes(anchor)) throw new Error('Company drive import anchor not found');
    source = source.replace(anchor, `${anchor}\n${line}`);
    fs.writeFileSync(seedFile, source, 'utf8');
    console.log('[patch-audit-runtime] added audit import');
  } else {
    console.log('[patch-audit-runtime] audit import already present');
  }
}

function patchPreload() {
  if (!fs.existsSync(preloadFile)) throw new Error('Missing electron/preload.cjs');
  let source = fs.readFileSync(preloadFile, 'utf8');
  const channels = ["'audit:list'", "'audit:record'", "'audit:clear'"];
  if (!channels.every((channel) => source.includes(channel))) {
    const anchor = "  'electron:openDevTools',";
    if (!source.includes(anchor)) throw new Error('Electron channel anchor not found');
    source = source.replace(anchor, `  'audit:list',\n  'audit:record',\n  'audit:clear',\n\n${anchor}`);
  }
  source = source.replace(
    "channel.startsWith('company:') || channel.startsWith('drive:')",
    "channel.startsWith('company:') || channel.startsWith('audit:') || channel.startsWith('drive:')"
  );
  fs.writeFileSync(preloadFile, source, 'utf8');
  console.log('[patch-audit-runtime] preload audit channels ready');
}

patchSeed();
patchPreload();
console.log('[patch-audit-runtime] OK');
