const fs = require('node:fs');
const path = require('node:path');

const mainStablePath = path.join(process.cwd(), 'electron', 'main-stable.js');

if (!fs.existsSync(mainStablePath)) {
  console.warn('[main-stable-startup] electron/main-stable.js not found; skipping');
  process.exit(0);
}

let source = fs.readFileSync(mainStablePath, 'utf8');
const before = source;

source = source.replace("import './seed-auth-cooldown-ipc.js';\n", '');
source = source.replace("import './seed-auth-cooldown-ipc.js';\r\n", '');

if (source !== before) {
  fs.writeFileSync(mainStablePath, source, 'utf8');
  console.log('[main-stable-startup] removed early seed-auth import from main-stable.js');
} else {
  console.log('[main-stable-startup] main-stable.js startup import order already safe');
}
