const fs = require('node:fs');

const file = 'electron/main-wrapper.js';
if (!fs.existsSync(file)) {
  console.log(`[patch-transfer-progress-runtime] skip: ${file} not found`);
  process.exit(0);
}

let src = fs.readFileSync(file, 'utf8');
let changed = false;

const importLine = "    await import('./transfer-progress-network-summary-override.js');\n    console.log('[main-wrapper] transfer progress network summary override import finished');\n";

if (src.includes("./transfer-progress-network-summary-override.js")) {
  console.log('[patch-transfer-progress-runtime] already patched');
  process.exit(0);
}

const markers = [
  "    await importPrimaryRuntime();\n",
  "    await import('./stream-upload-override.js');\n",
  "    await import('./protected-upload-override.js');\n",
  "    await import('./company-workspace-ipc.js');\n",
];

for (const marker of markers) {
  if (src.includes(marker)) {
    src = src.replace(marker, marker + importLine);
    changed = true;
    break;
  }
}

if (!changed) {
  console.log('[patch-transfer-progress-runtime] warning: no safe marker found; leaving main-wrapper.js unchanged');
  process.exit(0);
}

fs.writeFileSync(file, src, 'utf8');
console.log('[patch-transfer-progress-runtime] patched main-wrapper.js');
