const fs = require('node:fs');

const files = [
  'electron/download-to-path-override.js',
  'electron/hard-delete-override.js',
  'electron/stream-upload-override.js',
];

function patchFile(file) {
  if (!fs.existsSync(file)) throw new Error(`${file} not found`);
  let src = fs.readFileSync(file, 'utf8');
  let changed = false;

  function patchRegex(regex, replacement, label) {
    if (!regex.test(src)) {
      console.log(`[refactor-storage-json] ${file}: skip ${label}`);
      return false;
    }
    src = src.replace(regex, replacement);
    changed = true;
    console.log(`[refactor-storage-json] ${file}: patched ${label}`);
    return true;
  }

  function ensureImport(specifiers) {
    if (src.includes("./core/storage-json.js")) return;
    const importLine = `import { ${specifiers.join(', ')} } from './core/storage-json.js';`;
    const anchor = /import \{[^\n]+\} from '\.\/core\/storage-paths\.js';\n/;
    if (!anchor.test(src)) throw new Error(`${file}: storage-paths import anchor not found`);
    src = src.replace(anchor, (match) => `${match}${importLine}\n`);
    changed = true;
    console.log(`[refactor-storage-json] ${file}: added storage-json import`);
  }

  if (file.includes('download-to-path')) {
    ensureImport(['readJson']);
    patchRegex(
      /\nfunction loadJson\(file, fallback\) \{\n[\s\S]*?\n\}\n\nfunction currentIdentity/m,
      `\nfunction currentIdentity`,
      'remove loadJson helper'
    );
    src = src.replaceAll('loadJson(', 'readJson(');
  }

  if (file.includes('hard-delete')) {
    ensureImport(['readJson', 'writeManifests', 'readManifests']);
    patchRegex(
      /\nfunction readJson\(file, fallback\) \{\n[\s\S]*?\n\}\nfunction writeJson\(file, value\) \{\n[\s\S]*?\n\}\nfunction wallet/m,
      `\nfunction wallet`,
      'remove read/write JSON helpers'
    );
    src = src.replace(/function manifests\(\)\s*\{[^\n]*\}/, 'function manifests()            { return readManifests(); }');
    src = src.replace(/function saveManifests\(v\)\s*\{[^\n]*\}/, 'function saveManifests(v)       { writeManifests(v); }');
  }

  if (file.includes('stream-upload')) {
    ensureImport(['readJson', 'writeJson', 'readManifests', 'writeManifests']);
    patchRegex(
      /\nfunction readJson\(file, fallback\) \{\n[\s\S]*?\n\}\n\nfunction writeJson\(file, value\) \{\n[\s\S]*?\n\}\n\nfunction wallet/m,
      `\nfunction wallet`,
      'remove read/write JSON helpers'
    );
    src = src.replace(/function manifests\(\)\s*\{[^\n]*\}/, 'function manifests() { return readManifests(); }');
    src = src.replace(/function saveManifests\(v\)\s*\{[^\n]*\}/, 'function saveManifests(v) { writeManifests(v); }');
  }

  const checks = {
    hasStorageJsonImport: src.includes("./core/storage-json.js"),
    noDuplicateReadJsonHelper: !/function\s+(readJson|loadJson)\s*\(/.test(src),
    noDuplicateWriteJsonHelper: !/function\s+writeJson\s*\(/.test(src),
  };

  fs.writeFileSync(file, src, 'utf8');
  console.log(`[refactor-storage-json] ${file}: checks`, checks);
  if (!checks.hasStorageJsonImport || !checks.noDuplicateReadJsonHelper || !checks.noDuplicateWriteJsonHelper) {
    console.warn(`[refactor-storage-json] ${file}: warning incomplete`, checks);
    process.exitCode = 1;
  } else if (changed) {
    console.log(`[refactor-storage-json] ${file}: complete`);
  } else {
    console.log(`[refactor-storage-json] ${file}: no changes needed`);
  }
}

for (const file of files) patchFile(file);
