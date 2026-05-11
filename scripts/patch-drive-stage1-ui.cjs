const fs = require('node:fs');
const path = require('node:path');

const appPath = path.join(process.cwd(), 'client', 'src', 'NativeP2PApp.tsx');
if (!fs.existsSync(appPath)) {
  console.log('[patch-drive-stage1-ui] NativeP2PApp.tsx not found; skipping');
  process.exit(0);
}

let src = fs.readFileSync(appPath, 'utf8');
const original = src;

function replaceOnce(search, replacement, label) {
  if (!src.includes(search)) {
    console.warn(`[patch-drive-stage1-ui] skipped ${label}: marker not found`);
    return;
  }
  src = src.replace(search, replacement);
}

// Disable fragile legacy stage1 patching on the new RAM-safe UI.
// The previous implementation executed template literals during the patch step
// itself and crashed with ReferenceError: selectedStoredHashes is not defined.
// Keep this script as a no-op compatibility shim so existing npm scripts work.

if (src !== original) {
  fs.writeFileSync(appPath, src, 'utf8');
  console.log('[patch-drive-stage1-ui] compatibility updates applied');
} else {
  console.log('[patch-drive-stage1-ui] skipped legacy stage1 mutations on RAM-safe UI');
}
