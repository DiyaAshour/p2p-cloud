/**
 * launch-electron.cjs
 * Launches Electron with a 2GB heap limit on the main process.
 * Use this instead of calling `electron .` directly.
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

// Set NODE_OPTIONS before spawning — Electron main process inherits and respects it
const existing = (process.env.NODE_OPTIONS || '').replace(/--max-old-space-size=\d+/g, '').trim();
process.env.NODE_OPTIONS = `${existing} --max-old-space-size=2048`.trim();

console.log('[launch-electron] NODE_OPTIONS:', process.env.NODE_OPTIONS);

const isWin = os.platform() === 'win32';
const electronBin = path.join(__dirname, '..', 'node_modules', '.bin', isWin ? 'electron.cmd' : 'electron');

const child = spawn(electronBin, ['.'], {
  stdio: 'inherit',
  env: process.env,
  shell: false,
});

child.on('error', (err) => {
  console.error('[launch-electron] failed to start:', err.message);
  process.exit(1);
});

child.on('exit', (code) => process.exit(code ?? 0));
