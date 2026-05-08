const fs = require('node:fs');

const file = 'electron/main.js';
if (!fs.existsSync(file)) process.exit(0);
let s = fs.readFileSync(file, 'utf8');
const before = s;

s = s.replace(
  "  runAutoRepair('startup').catch((error) => console.warn('[auto-repair] startup failed:', error?.message || error));",
  "  lastAutoRepairStatus = { ...lastAutoRepairStatus, active: Boolean(autoRepairTimer), skippedReason: 'delayed-startup' };"
);

s = s.replace(
  "const AUTO_REPAIR_INTERVAL_MS = Math.max(30_000, Number(process.env.P2P_AUTO_REPAIR_INTERVAL_MS || 60_000));",
  "const AUTO_REPAIR_INTERVAL_MS = Math.max(30_000, Number(process.env.P2P_AUTO_REPAIR_INTERVAL_MS || 10_800_000));"
);

if (s !== before) {
  fs.writeFileSync(file, s, 'utf8');
  console.log('[emergency-disable-startup-repair] disabled immediate startup repair');
} else {
  console.log('[emergency-disable-startup-repair] no changes needed');
}
