const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const root = process.cwd();
const deep = process.argv.includes('--deep');

const errors = [];
const warnings = [];
const passes = [];

function rel(...parts) { return path.join(root, ...parts); }
function exists(file) { return fs.existsSync(rel(file)); }
function read(file) { try { return fs.readFileSync(rel(file), 'utf8'); } catch { return ''; } }
function readJson(file) { try { return JSON.parse(read(file)); } catch (error) { fail(`${file} is not valid JSON: ${error.message}`); return null; } }
function pass(message) { passes.push(message); }
function warn(message) { warnings.push(message); }
function fail(message) { errors.push(message); }
function assert(condition, message) { if (condition) pass(message); else fail(message); }
function assertFile(file) { assert(exists(file), `Required file exists: ${file}`); return read(file); }
function assertIncludes(source, needle, label) { assert(source.includes(needle), label || `Contains ${needle}`); }
function warnIfIncludes(source, needle, label) { if (source.includes(needle)) warn(label || `Found ${needle}`); else pass(label || `Did not find ${needle}`); }

function listFiles(dir, predicate = () => true) {
  const base = rel(dir);
  if (!fs.existsSync(base)) return [];
  const out = [];
  const stack = [base];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'release', '.git'].includes(entry.name)) stack.push(full);
      } else {
        const relative = path.relative(root, full).replaceAll('\\', '/');
        if (predicate(relative)) out.push(relative);
      }
    }
  }
  return out.sort();
}

function runNodeScript(script) {
  try {
    const output = childProcess.execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    pass(`Script passed: node ${script}`);
    return output.trim();
  } catch (error) {
    fail(`Script failed: node ${script}\n${error.stdout || ''}${error.stderr || error.message}`.trim());
    return '';
  }
}

function runCommand(command, args, label) {
  const result = childProcess.spawnSync(command, args, { cwd: root, shell: process.platform === 'win32', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0) pass(`${label || `${command} ${args.join(' ')}`} passed`);
  else fail(`${label || `${command} ${args.join(' ')}`} failed with code ${result.status}\n${result.stdout || ''}${result.stderr || ''}`.trim());
}

function section(title) { console.log(`\n=== ${title} ===`); }
function hasHandler(source, channel) { return source.includes(`ipcMain.handle('${channel}'`) || source.includes(`ipcMain.handle("${channel}"`); }

function checkPackage() {
  section('package.json scripts');
  const pkg = readJson('package.json');
  if (!pkg) return;
  const scripts = pkg.scripts || {};
  assert(scripts['prepare:final'] === 'node scripts/verify-runtime.cjs', 'prepare:final is verify-only, not patching');
  assert(scripts.health === 'node scripts/full-health-check.cjs', 'health script exists');
  assert(scripts['health:deep'] === 'node scripts/full-health-check.cjs --deep', 'health:deep script exists');
  assert(scripts.verify === 'node scripts/verify-runtime.cjs', 'verify script exists');
  assert(scripts['electron:dev'] && !scripts['electron:dev'].includes('prepare:final'), 'electron:dev does not run prepare:final patches before startup');
  assert(scripts['electron:dev'] && scripts['electron:dev'].includes('launch-electron.cjs'), 'electron:dev launches Electron through launch-electron.cjs');
  assert(scripts.dev === 'vite --host 127.0.0.1 --port 3000', 'dev starts Vite directly');
  for (const name of ['dev', 'electron:dev', 'electron:dev:fast', 'start', 'start:fast']) {
    assert(!/patch-[\w-]+\.cjs/.test(String(scripts[name] || '')), `${name} does not call patch scripts`);
  }
  const legacyPatchRefs = Object.entries(scripts).filter(([, value]) => /patch-[\w-]+\.cjs/.test(String(value)));
  if (legacyPatchRefs.length) warn(`Legacy patch script references still exist in non-startup scripts: ${legacyPatchRefs.map(([k]) => k).join(', ')}`);
  else pass('No patch script references remain in package scripts');
}

function checkRequiredFiles() {
  section('required runtime files');
  for (const file of [
    'electron/main-wrapper.js', 'electron/main.js', 'electron/main-stable.js', 'electron/preload.cjs',
    'electron/core/config.js', 'electron/core/identity.js', 'electron/core/storage-paths.js', 'electron/core/storage-json.js',
    'electron/transfer-progress-state.js', 'electron/transfer-cancel-ipc.js', 'electron/stream-upload-override.js', 'electron/download-to-path-override.js',
    'electron/hard-delete-override.js', 'electron/delete-tombstone-sync.js', 'electron/tombstone-sync-pull-override.js',
    'electron/shared-link-ipc.js', 'electron/file-update-ipc.js', 'electron/folder-item-ipc.js', 'electron/folder-crud-ipc.js',
    'electron/list-files-normalize-ipc.js', 'electron/network-summary-normalize-ipc.js', 'electron/ui-prefs-ipc.js',
    'electron/seed-auth-cooldown-ipc.js', 'scripts/verify-runtime.cjs', 'scripts/full-health-check.cjs'
  ]) assertFile(file);
}

function checkWrapper() {
  section('main-wrapper runtime wiring');
  const wrapper = assertFile('electron/main-wrapper.js');
  for (const needle of [
    'function mainStableHasP2PHandlers()', "await import('./main.js')", "await import('./main-stable.js')", 'installLazySeedIpc();',
    "await import('./p2p-transport-global-registry.js')", "await import('./p2p-delete-message-override.js')",
    "await import('./list-files-normalize-ipc.js')", "await import('./network-summary-normalize-ipc.js')",
    "await import('./shared-link-ipc.js')", "await import('./file-update-ipc.js')", "await import('./folder-item-ipc.js')",
    "await import('./folder-crud-ipc.js')", "await import('./ui-prefs-ipc.js')", "await import('./transfer-cancel-ipc.js')",
    "await import('./stream-upload-override.js')", "await import('./download-to-path-override.js')", "await import('./hard-delete-override.js')",
    "await import('./delete-tombstone-sync.js')", "await import('./tombstone-sync-pull-override.js')"
  ]) assertIncludes(wrapper, needle, `main-wrapper includes ${needle}`);
  warnIfIncludes(wrapper, "import './seed-auth-cooldown-ipc.js'", 'seed auth is not imported eagerly');
}

function checkPreload() {
  section('preload IPC allowlist');
  const preload = assertFile('electron/preload.cjs');
  for (const channel of [
    'p2p:start','p2p:listFiles','p2p:listFolders','p2p:createFolder','p2p:deleteFolder','p2p:deleteItem','p2p:renameItem',
    'p2p:moveItem','p2p:moveFile','p2p:renameFolder','p2p:moveFolder','p2p:uploadFiles','p2p:uploadFolder','p2p:uploadPath',
    'p2p:downloadToPath','p2p:importSharedLink','p2p:updateFile','p2p:delete','p2p:getUiPrefs','p2p:setUiPrefs','p2p:networkSummary',
    'p2p:cancelTransfer','wallet:status','wallet:connect','wallet:disconnect','wallet:setPlan','seed:create','seed:login','seed:recover','electron:diagnostics'
  ]) assertIncludes(preload, `'${channel}'`, `preload allows ${channel}`);
  assertIncludes(preload, 'assertAllowedChannel(channel)', 'preload blocks unknown IPC channels');
  assertIncludes(preload, 'invokeWithRuntimeRetry', 'preload retries while runtime handlers are loading');
}

function checkCoreModules() {
  section('core modules');
  const config = assertFile('electron/core/config.js');
  const identity = assertFile('electron/core/identity.js');
  const storageJson = assertFile('electron/core/storage-json.js');
  const storagePaths = assertFile('electron/core/storage-paths.js');
  for (const needle of ['PLANS','CHUNK_SIZE_BYTES','TARGET_REPLICAS','FOLDER_MANIFEST_KIND','UI_PREFS_MANIFEST_KIND']) assertIncludes(config, needle, `config exports/defines ${needle}`);
  for (const needle of ['normalizeIdentity','activeIdentity','assertVerified']) assertIncludes(identity, needle, `identity has ${needle}`);
  for (const needle of ['readWallet','writeWallet','readManifests','writeManifests']) assertIncludes(storageJson, needle, `storage-json has ${needle}`);
  for (const needle of ['storageRoot','dataDir','walletPath','manifestsPath','chunkStoreDir']) assertIncludes(storagePaths, needle, `storage-paths has ${needle}`);
}

function checkIpcModules() {
  section('IPC modules and handlers');
  const modules = {
    'electron/shared-link-ipc.js': ['p2p:importSharedLink','parseSharedFileLink','sanitizeSharedManifest'],
    'electron/file-update-ipc.js': ['p2p:updateFile','findFileManifest','syncPushSafe'],
    'electron/folder-item-ipc.js': ['p2p:renameItem','p2p:moveItem','p2p:deleteItem','findOrFallbackOwnedItem','fallbackFolderItem'],
    'electron/folder-crud-ipc.js': ['p2p:listFolders','p2p:createFolder','p2p:renameFolder','p2p:moveFolder','p2p:deleteFolder','p2p:moveFile'],
    'electron/ui-prefs-ipc.js': ['p2p:getUiPrefs','p2p:setUiPrefs','sanitizePrefs'],
    'electron/list-files-normalize-ipc.js': ['p2p:listFiles','normalizeStoredFolderLabels'],
    'electron/network-summary-normalize-ipc.js': ['p2p:networkSummary','walletCounts'],
    'electron/transfer-cancel-ipc.js': ['p2p:cancelTransfer','requestTransferCancel']
  };
  for (const [file, needles] of Object.entries(modules)) {
    const source = assertFile(file);
    for (const needle of needles) assertIncludes(source, needle, `${file} includes ${needle}`);
  }
}

function checkTransferAndDelete() {
  section('transfer, cancel, rollback, delete');
  const transferState = assertFile('electron/transfer-progress-state.js');
  const cancel = assertFile('electron/transfer-cancel-ipc.js');
  const upload = assertFile('electron/stream-upload-override.js');
  const download = assertFile('electron/download-to-path-override.js');
  const hardDelete = assertFile('electron/hard-delete-override.js');
  for (const needle of ['startTransfer','updateTransfer','finishTransfer','failTransfer','throwIfTransferCancelled','requestTransferCancel']) assertIncludes(transferState + cancel + upload, needle, `transfer progress has ${needle}`);
  assertIncludes(cancel, 'p2p:cancelTransfer', 'cancel transfer IPC exists');
  assertIncludes(upload, 'rollbackUploadedChunks', 'upload rollback function exists');
  assertIncludes(upload, 'throwIfTransferCancelled', 'upload checks cancellation');
  assertIncludes(upload, 'p2p:uploadFiles', 'stream upload override handles p2p:uploadFiles');
  assertIncludes(download, 'p2p:downloadToPath', 'download override handles p2p:downloadToPath');
  assertIncludes(hardDelete, 'p2p:delete', 'hard delete override handles p2p:delete');
  assertIncludes(hardDelete, 'deleteWalletManifest', 'hard delete syncs manifest delete');
}

function checkRuntimeCoreHandlers() {
  section('main runtime core handlers');
  const combined = `${assertFile('electron/main.js')}\n${assertFile('electron/main-stable.js')}`;
  for (const channel of ['p2p:start','p2p:networkSummary','p2p:listFiles','p2p:uploadFiles']) assert(hasHandler(combined, channel), `main/main-stable define core handler ${channel}`);
}

function checkClientPurity() {
  section('client Electron-only data path');
  const files = listFiles('client/src', (file) => /\.(ts|tsx|js|jsx)$/.test(file));
  assert(files.length > 0, 'client source files found');
  const forbidden = [
    { pattern: /\bfetch\s*\(/, label: 'browser fetch()' }, { pattern: /\baxios\b/, label: 'axios' }, { pattern: /\btrpc\b/i, label: 'TRPC' },
    { pattern: /VITE_P2P_API_BASE_URL/, label: 'VITE_P2P_API_BASE_URL' }, { pattern: /P2P API is not reachable/i, label: 'old browser API error text' }
  ];
  for (const file of files) {
    const source = read(file);
    for (const item of forbidden) if (item.pattern.test(source)) warn(`${file} contains ${item.label}; verify it is not used for runtime data path`);
  }
  const combined = files.map((file) => read(file)).join('\n');
  assert(/window\.electron\.invoke|api\.invoke/.test(combined), 'client uses Electron IPC invoke path');
  assert(/Electron required|No browser mode allowed|__P2P_PRELOAD_LOADED__|window\.electron/.test(combined), 'client has Electron/preload gating or diagnostics');
}

function checkLegacyPatchesNotStartup() {
  section('legacy patch safety');
  const pkg = readJson('package.json');
  if (!pkg) return;
  const startupValues = ['dev','electron:dev','electron:dev:fast','start','start:fast','renderer:build'].map((key) => String(pkg.scripts?.[key] || '')).join('\n');
  assert(!/scripts\/patch-|scripts\\patch-/.test(startupValues), 'startup/build scripts do not call legacy patch files');
  const patchFiles = listFiles('scripts', (file) => /(^|\/)patch-.*\.cjs$/.test(file));
  if (patchFiles.length) warn(`Legacy patch files still exist but are not part of dev startup: ${patchFiles.length}`);
  else pass('No legacy patch files remain');
}

function checkVerifyRuntime() { section('verify-runtime'); const output = runNodeScript('scripts/verify-runtime.cjs'); if (output) console.log(output); }
function deepChecks() { if (!deep) return; section('deep checks'); runCommand('pnpm', ['test'], 'pnpm test'); runCommand('pnpm', ['run', 'build:fast'], 'pnpm run build:fast'); }
function printSummary() {
  section('summary');
  for (const message of passes) console.log(`✅ ${message}`);
  for (const message of warnings) console.log(`⚠️  ${message}`);
  for (const message of errors) console.log(`❌ ${message}`);
  console.log('\n--- totals ---');
  console.log(`passes=${passes.length}`); console.log(`warnings=${warnings.length}`); console.log(`errors=${errors.length}`);
  if (errors.length) { console.log('\nFULL HEALTH CHECK FAILED'); process.exitCode = 1; }
  else { console.log('\nFULL HEALTH CHECK PASSED'); process.exitCode = 0; }
}

console.log('[full-health-check] starting', { deep });
checkPackage(); checkRequiredFiles(); checkWrapper(); checkPreload(); checkCoreModules(); checkIpcModules(); checkTransferAndDelete(); checkRuntimeCoreHandlers(); checkClientPurity(); checkLegacyPatchesNotStartup(); checkVerifyRuntime(); deepChecks(); printSummary();
