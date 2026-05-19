const fs = require('fs');
const path = require('path');

const file = path.join(process.cwd(), 'electron', 'main-wrapper.js');
if (!fs.existsSync(file)) {
  console.log('[main-wrapper-runtime-order] main-wrapper.js not found; skipping');
  process.exit(0);
}

let src = fs.readFileSync(file, 'utf8');

const replacement = String.raw`async function importOptionalRuntimeModule(modulePath, label) {
  try {
    await import(modulePath);
    console.log('[main-wrapper] ' + label + ' import finished');
    return { ok: true };
  } catch (error) {
    console.warn('[main-wrapper] optional ' + label + ' import failed:', error?.stack || error?.message || error);
    return { ok: false, error: error?.message || String(error) };
  }
}

async function importMainWhenReady() {
  if (mainImportStarted) return;
  mainImportStarted = true;
  console.log('[main-wrapper] importing runtime after app ready');

  try {
    // Critical: import the primary runtime first. It owns wallet, seed, and p2p IPC handlers.
    // Optional overrides must never block wallet:connect, seed:recover, or p2p:start.
    await importPrimaryRuntime();

    await importOptionalRuntimeModule('./p2p-transport-global-registry.js', 'p2p global registry');
    await importOptionalRuntimeModule('./company-workspace-ipc.js', 'company workspace IPC');
    await importOptionalRuntimeModule('./company-offline-invite-ipc.js', 'company offline invite IPC');
    await importOptionalRuntimeModule('./company-distributed-objects-ipc.js', 'company distributed objects IPC');
    await importOptionalRuntimeModule('./seed-auth-cooldown-ipc.js', 'seed auth cooldown IPC');
    await importOptionalRuntimeModule('./protected-upload-override.js', 'protected upload status override');
    await importOptionalRuntimeModule('./stream-upload-override.js', 'streaming upload override');
    await importOptionalRuntimeModule('./protection-retry-loop.js', 'protection retry loop');
    await importOptionalRuntimeModule('./download-to-path-override.js', 'download override');

    setTimeout(() => createFallbackWindow('runtime imported but no BrowserWindow appeared'), 3000);
  } catch (error) {
    console.error('[main-wrapper] primary runtime import failed:', error?.stack || error?.message || error);
    createFallbackWindow(error?.message || 'Electron startup import failed');
  }
}

`;

const pattern = /async function importMainWhenReady\(\) \{[\s\S]*?\n\}\n\napp\.on\('ready',/;
if (!pattern.test(src)) {
  console.log('[main-wrapper-runtime-order] importMainWhenReady anchor not found; skipping');
  process.exit(0);
}

src = src.replace(pattern, replacement + "app.on('ready',");
fs.writeFileSync(file, src, 'utf8');
console.log('[main-wrapper-runtime-order] primary runtime now imports before optional modules');
