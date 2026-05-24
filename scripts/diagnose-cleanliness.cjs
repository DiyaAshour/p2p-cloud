const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
let failures = 0;
let warnings = 0;

function rel(file) {
  return path.relative(root, file).replaceAll('\\\\', '/');
}

function exists(file) {
  return fs.existsSync(path.join(root, file));
}

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function log(status, message) {
  const icon = status === 'ok' ? '✅' : status === 'warn' ? '⚠️ ' : '❌';
  console.log(`${icon} ${message}`);
}

function ok(message) { log('ok', message); }
function warn(message) { warnings += 1; log('warn', message); }
function fail(message) { failures += 1; log('fail', message); }

function listFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (['node_modules', '.git', 'release', 'dist'].includes(name)) continue;
      listFiles(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function checkRequiredFiles() {
  console.log('\n=== Required runtime files ===');
  const required = [
    'package.json',
    'pnpm-workspace.yaml',
    'electron/main-wrapper.js',
    'electron/main-stable.js',
    'electron/preload.cjs',
    'electron/stream-upload-override.js',
    'electron/stream-folder-upload-override.js',
    'electron/download-to-path-override.js',
    'electron/hard-delete-override.js',
    'electron/delete-tombstone-sync.js',
    'electron/transfer-progress-state.js',
    'electron/transfer-progress-network-summary-override.js',
    'electron/transfer-cancel-ipc.js',
    'server/manifest-sync.js',
    'server/manifest-sync/index.js',
    '.env.example',
  ];

  for (const file of required) {
    if (exists(file)) ok(`${file}`);
    else fail(`missing ${file}`);
  }
}

function checkPackageScripts() {
  console.log('\n=== package.json scripts ===');
  if (!exists('package.json')) return fail('package.json missing');
  const pkg = JSON.parse(read('package.json'));
  const prepare = String(pkg.scripts?.['prepare:final'] || '');
  if (!prepare) fail('prepare:final is missing');
  else ok('prepare:final exists');

  const patchScripts = prepare.split('&&').map((part) => part.trim()).filter((part) => part.startsWith('node scripts/'));
  if (patchScripts.length > 18) warn(`prepare:final has ${patchScripts.length} script steps; target cleanup is <= 8`);
  else ok(`prepare:final has ${patchScripts.length} script steps`);

  for (const part of patchScripts) {
    const script = part.replace(/^node\s+/, '').trim().split(/\s+/)[0];
    if (!exists(script)) fail(`prepare:final references missing ${script}`);
  }

  for (const name of ['electron:dev', 'electron:dev:fast', 'renderer:build', 'test']) {
    if (pkg.scripts?.[name]) ok(`script ${name}`);
    else warn(`script ${name} missing`);
  }
}

function checkSecretsAndArtifacts() {
  console.log('\n=== Secrets / generated artifacts ===');
  const badNames = ['.env', '.env.local', 'manifests.json', 'wallet.json'];
  for (const name of badNames) {
    if (exists(name)) fail(`${name} should not be committed or kept in repo root`);
    else ok(`${name} not in repo root`);
  }

  for (const name of ['node_modules', 'release', 'dist']) {
    if (exists(name)) warn(`${name}/ exists locally; fine for dev, do not commit`);
    else ok(`${name}/ not present`);
  }
}

function checkShellGarbage() {
  console.log('\n=== Shell garbage in source files ===');
  const files = listFiles(root).filter((file) => /\.(ts|tsx|js|cjs|mjs)$/.test(file));
  const patterns = [
    /cat > .*<<\s*['\"]?END/i,
    /^\s*PS\s+[A-Z]:\\/m,
    /```(?:powershell|bash|js|ts)?/,
    /Set-Content\s+-Path/i,
  ];
  let found = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        found += 1;
        fail(`possible pasted shell garbage in ${rel(file)} (${pattern})`);
        break;
      }
    }
  }
  if (!found) ok('no obvious pasted shell commands in source files');
}

function checkRuntimeHooks() {
  console.log('\n=== Critical runtime hooks ===');
  if (exists('electron/stream-upload-override.js')) {
    const s = read('electron/stream-upload-override.js');
    for (const token of [
      'startTransfer',
      'updateTransfer',
      'finishTransfer',
      'throwIfTransferCancelled',
      'rollbackUploadedChunks',
      'transfer-progress-network-summary-override',
      'transfer-cancel-ipc',
    ]) {
      if (s.includes(token)) ok(`upload hook: ${token}`);
      else fail(`upload hook missing: ${token}`);
    }
  }

  if (exists('electron/preload.cjs')) {
    const p = read('electron/preload.cjs');
    for (const channel of ['p2p:cancelTransfer', 'p2p:uploadPath', 'p2p:downloadToPath', 'p2p:delete']) {
      if (p.includes(channel)) ok(`preload allows ${channel}`);
      else fail(`preload missing ${channel}`);
    }
  }
}

function checkManifestAuth() {
  console.log('\n=== Manifest sync auth ===');
  if (exists('server/manifest-sync/index.js')) {
    const server = read('server/manifest-sync/index.js');
    for (const token of ['MANIFEST_SYNC_AUTH_SECRET', 'x-manifest-signature', 'nonce', 'timingSafeEqual']) {
      if (server.includes(token)) ok(`server auth token: ${token}`);
      else fail(`server auth missing: ${token}`);
    }
  }

  if (exists('electron/manifest-sync.js')) {
    const client = read('electron/manifest-sync.js');
    for (const token of ['P2P_MANIFEST_SYNC_AUTH_SECRET', 'x-manifest-signature', 'signManifestSyncRequest']) {
      if (client.includes(token)) ok(`client auth token: ${token}`);
      else fail(`client auth missing: ${token}`);
    }
  }
}

checkRequiredFiles();
checkPackageScripts();
checkSecretsAndArtifacts();
checkShellGarbage();
checkRuntimeHooks();
checkManifestAuth();

console.log('\n=== Summary ===');
console.log(`failures=${failures} warnings=${warnings}`);

if (failures) process.exitCode = 1;
