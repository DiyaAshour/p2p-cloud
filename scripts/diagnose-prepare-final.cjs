const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const prepare = String(pkg.scripts?.['prepare:final'] || '');
const steps = prepare
  .split('&&')
  .map((step) => step.trim())
  .filter(Boolean)
  .map((step) => step.replace(/^node\s+/, '').trim());

const runtimeFiles = [
  'electron/main.js',
  'electron/main-stable.js',
  'electron/main-wrapper.js',
  'electron/preload.cjs',
  'electron/stream-upload-override.js',
  'electron/download-to-path-override.js',
  'electron/hard-delete-override.js',
  'client/src/NativeP2PApp.tsx',
  'client/src/NativeP2PAppStable.tsx',
  'client/src/NativeP2PAppLive.tsx',
];

function read(file) {
  try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return ''; }
}

function exists(file) {
  return fs.existsSync(path.join(root, file));
}

function classify(script) {
  const src = read(script);
  const writes = runtimeFiles.filter((file) => src.includes(file) || src.includes(file.replaceAll('/', '\\\\')) || src.includes(path.basename(file)));
  const usesSetContentStyle = /writeFileSync|appendFileSync|fs\.writeFile|Set-Content|replace\(/.test(src);
  const anchorRisk = /anchor not found|Missing anchor|throw new Error\([^)]*anchor|if \(!src\.includes/.test(src);
  const likelyIdempotent = /already|no changes needed|skip|skipping|includes\(/i.test(src);
  return { script, exists: exists(script), writes, usesSetContentStyle, anchorRisk, likelyIdempotent };
}

const rows = steps.map(classify);
const missing = rows.filter((r) => !r.exists);
const risky = rows.filter((r) => r.exists && r.usesSetContentStyle && r.writes.length);
const noDirectRuntimeWrites = rows.filter((r) => r.exists && !r.writes.length);

console.log('\n=== prepare:final summary ===');
console.log(`steps=${steps.length}`);
console.log(`missing=${missing.length}`);
console.log(`runtimeWriteSteps=${risky.length}`);
console.log(`noDirectRuntimeWrites=${noDirectRuntimeWrites.length}`);

console.log('\n=== runtime write steps ===');
for (const row of risky) {
  console.log(`- ${row.script}`);
  console.log(`  writes: ${row.writes.join(', ') || '(unknown)'}`);
  console.log(`  anchorRisk=${row.anchorRisk} likelyIdempotent=${row.likelyIdempotent}`);
}

if (missing.length) {
  console.log('\n=== missing scripts ===');
  for (const row of missing) console.log(`- ${row.script}`);
}

console.log('\n=== suggested next cleanup targets ===');
for (const row of risky.filter((r) => r.likelyIdempotent).slice(0, 8)) {
  console.log(`- ${row.script}`);
}

process.exitCode = missing.length ? 1 : 0;
