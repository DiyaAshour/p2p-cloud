const { spawnSync, spawn } = require('node:child_process');
const process = require('node:process');

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' },
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

run('node', ['scripts/fix-native-p2p-jsx.cjs']);
run('node', ['scripts/patch-download-memory.cjs']);
run('node', ['scripts/patch-drive-download-ui.cjs']);
run('node', ['scripts/verify-runtime-safety.cjs']);
run('node', ['scripts/repair-encrypted-manifests.js']);
run('node', ['scripts/remove-bad-encrypted-manifests.js']);

const electronBin = process.platform === 'win32' ? 'electron.cmd' : 'electron';
const child = spawn(electronBin, ['--js-flags=--max-old-space-size=8192', '.'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' },
});

child.on('exit', (code) => process.exit(code || 0));
