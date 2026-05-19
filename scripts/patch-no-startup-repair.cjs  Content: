const fs = require('node:fs');

const files = ['electron/main-stable.js', 'electron/main.js'];

for (const file of files) {
  if (!fs.existsSync(file)) continue;

  let s = fs.readFileSync(file, 'utf8');
  const before = s;

  s = s.replace(
    "runAutoRepair('startup').catch((error) => console.warn('[auto-repair] startup failed:', error?.message || error));",
    "console.log('[auto-repair] startup repair skipped; use Repair manually after peers connect');"
  );

  if (s !== before) {
    fs.writeFileSync(file, s, 'utf8');
    console.log(`[no-startup-repair] patched ${file}`);
  } else {
    console.log(`[no-startup-repair] already safe or anchor not found: ${file}`);
  }
}
