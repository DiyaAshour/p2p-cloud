const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const packagePath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const scripts = pkg.scripts || {};

const productionScripts = [
  'prepare:final',
  'verify',
  'renderer:build',
  'build',
  'package:dir',
  'package:win',
  'dist',
  'electron:dev',
  'start',
];

const forbiddenRuntimeTokens = [
  'apply-download-streaming',
  'patch-streaming',
  'patch-main',
  'patch-live',
  'patch-seed',
  'enable-seed-account',
];

const failures = [];

for (const name of productionScripts) {
  const command = String(scripts[name] || '');
  for (const token of forbiddenRuntimeTokens) {
    if (command.includes(token)) {
      failures.push(`${name} runs legacy patch/apply code: ${token}`);
    }
  }
}

for (const [name, command] of Object.entries(scripts)) {
  if (name.startsWith('patch:') || name.startsWith('apply:')) {
    failures.push(`${name} is a legacy patch/apply script exposed as a first-class package script`);
  }

  if ((name.startsWith('legacy:') || name.startsWith('experimental:')) && !String(command).includes('scripts/')) {
    failures.push(`${name} must point to an explicit script file or command`);
  }
}

if (failures.length > 0) {
  console.error('[production-scan] failed: production package scripts are not clean');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[production-scan] ok: production scripts are source-based and do not depend on legacy patch/apply scripts');
