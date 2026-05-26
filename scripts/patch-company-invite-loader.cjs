#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const target = path.join(root, 'electron', 'company-drive-live-compat-ipc.js');
const line = "import './company-drive-offline-invite-ipc.js';";

if (!fs.existsSync(target)) {
  console.error('[patch-company-invite-loader] missing target file');
  process.exit(1);
}

let source = fs.readFileSync(target, 'utf8');
if (source.includes(line)) {
  console.log('[patch-company-invite-loader] already patched');
  process.exit(0);
}

fs.writeFileSync(target, `${line}\n${source}`, 'utf8');
console.log('[patch-company-invite-loader] patched');
