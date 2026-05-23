const fs = require('node:fs');

const file = 'electron/main-wrapper.js';
if (!fs.existsSync(file)) throw new Error(`${file} not found`);

let src = fs.readFileSync(file, 'utf8');
let changed = false;

if (!src.includes("./transfer-progress-network-summary-override.js")) {
  const needle = "    await importPrimaryRuntime();\n";
  const replacement = "    await importPrimaryRuntime();\n    await import('./transfer-progress-network-summary-override.js');\n    console.log('[main-wrapper] transfer progress network summary override import finished');\n";
  if (!src.includes(needle)) throw new Error('Could not find importPrimaryRuntime marker in main-wrapper.js');
  src = src.replace(needle, replacement);
  changed = true;
}

if (changed) {
  fs.writeFileSync(file, src, 'utf8');
  console.log('[patch-transfer-progress-runtime] patched main-wrapper.js');
} else {
  console.log('[patch-transfer-progress-runtime] already patched');
}
