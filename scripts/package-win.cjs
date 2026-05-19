const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function existingFile(filePath) {
  try {
    return Boolean(filePath && fs.existsSync(filePath));
  } catch {
    return false;
  }
}

function findPnpmExecutable() {
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'pnpm.cmd' : 'pnpm';
  const candidates = [
    process.env.PNPM_HOME && path.join(process.env.PNPM_HOME, exe),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', exe),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'pnpm', exe),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existingFile(candidate)) return candidate;
  }

  return exe;
}

function findElectronBuilderExecutable() {
  const exe = process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder';
  const local = path.join(process.cwd(), 'node_modules', '.bin', exe);
  return existingFile(local) ? local : exe;
}

const env = { ...process.env };

if (process.platform === 'win32') {
  const pnpmExecutable = findPnpmExecutable();
  env.npm_execpath = pnpmExecutable;
  env.npm_config_user_agent = env.npm_config_user_agent || `pnpm/10.33.2 node/${process.version} win32 x64`;
  console.log('[package-win] normalized npm_execpath for electron-builder:', pnpmExecutable);
}

const electronBuilder = findElectronBuilderExecutable();
const args = ['--win', 'nsis', '--x64'];
console.log('[package-win] running:', electronBuilder, args.join(' '));

const result = spawnSync(electronBuilder, args, {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error('[package-win] electron-builder failed to start:', result.error);
  process.exit(1);
}

process.exit(typeof result.status === 'number' ? result.status : 1);
