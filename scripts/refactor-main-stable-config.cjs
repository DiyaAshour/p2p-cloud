const fs = require('node:fs');

const file = 'electron/main-stable.js';
if (!fs.existsSync(file)) throw new Error(`${file} not found`);

let src = fs.readFileSync(file, 'utf8');
let changed = false;

function patchText(find, replacement, label) {
  if (!src.includes(find)) {
    console.log(`[refactor-main-stable-config] skip ${label}: marker not found`);
    return false;
  }
  src = src.replace(find, replacement);
  changed = true;
  console.log(`[refactor-main-stable-config] patched ${label}`);
  return true;
}

function patchRegex(regex, replacement, label) {
  if (!regex.test(src)) {
    console.log(`[refactor-main-stable-config] skip ${label}: regex not found`);
    return false;
  }
  src = src.replace(regex, replacement);
  changed = true;
  console.log(`[refactor-main-stable-config] patched ${label}`);
  return true;
}

if (!src.includes("./core/config.js")) {
  patchText(
    "import './seed-auth-cooldown-ipc.js';",
    `import './seed-auth-cooldown-ipc.js';
import {
  APP_TITLE,
  PLANS,
  FREE_QUOTA_BYTES,
  CHUNK_SIZE_BYTES,
  TARGET_REPLICAS,
  AUTO_REPAIR_INTERVAL_MS,
  UPLOAD_CONCURRENCY,
  DOWNLOAD_CONCURRENCY,
  ENCRYPTION_ALGORITHM,
  ENCRYPTION_KEY_SOURCE,
  KDF_ALGORITHM,
  KDF_ITERATIONS,
  MIN_DRIVE_PASSWORD_LENGTH,
  WALLET_LOGIN_MAX_AGE_MS,
  WALLET_LOGIN_MAX_FUTURE_MS,
  FOLDER_MANIFEST_KIND,
  UI_PREFS_MANIFEST_KIND,
  quotaBytes,
} from './core/config.js';`,
    'core config import'
  );
}

// Remove duplicated single-line runtime constants. Keep IS_DEV and DEV_SERVER_URL local.
const singleLineConstRegexes = [
  [/^const APP_TITLE\s*=\s*['"][^'"]+['"];\s*\n/m, 'APP_TITLE'],
  [/^const CHUNK_SIZE_BYTES\s*=.*;\s*\n/m, 'CHUNK_SIZE_BYTES'],
  [/^const TARGET_REPLICAS\s*=.*;\s*\n/m, 'TARGET_REPLICAS'],
  [/^const AUTO_REPAIR_INTERVAL_MS\s*=.*;\s*\n/m, 'AUTO_REPAIR_INTERVAL_MS'],
  [/^const UPLOAD_CONCURRENCY\s*=.*;\s*\n/m, 'UPLOAD_CONCURRENCY'],
  [/^const DOWNLOAD_CONCURRENCY\s*=.*;\s*\n/m, 'DOWNLOAD_CONCURRENCY'],
  [/^const FREE_QUOTA_BYTES\s*=.*;\s*\n/m, 'FREE_QUOTA_BYTES'],
  [/^const ENCRYPTION_ALGORITHM\s*=.*;\s*\n/m, 'ENCRYPTION_ALGORITHM'],
  [/^const ENCRYPTION_KEY_SOURCE\s*=.*;\s*\n/m, 'ENCRYPTION_KEY_SOURCE'],
  [/^const KDF_ALGORITHM\s*=.*;\s*\n/m, 'KDF_ALGORITHM'],
  [/^const KDF_ITERATIONS\s*=.*;\s*\n/m, 'KDF_ITERATIONS'],
  [/^const MIN_DRIVE_PASSWORD_LENGTH\s*=.*;\s*\n/m, 'MIN_DRIVE_PASSWORD_LENGTH'],
  [/^const WALLET_LOGIN_MAX_AGE_MS\s*=.*;\s*\n/m, 'WALLET_LOGIN_MAX_AGE_MS'],
  [/^const WALLET_LOGIN_MAX_FUTURE_MS\s*=.*;\s*\n/m, 'WALLET_LOGIN_MAX_FUTURE_MS'],
  [/^const FOLDER_MANIFEST_KIND\s*=.*;\s*\n/m, 'FOLDER_MANIFEST_KIND'],
];

for (const [regex, label] of singleLineConstRegexes) {
  patchRegex(regex, '', label);
}

if (/^const UI_PREFS_KIND\s*=\s*['"]ui:prefs['"];\s*$/m.test(src)) {
  patchRegex(
    /^const UI_PREFS_KIND\s*=\s*['"]ui:prefs['"];\s*$/m,
    'const UI_PREFS_KIND = UI_PREFS_MANIFEST_KIND;',
    'UI_PREFS_KIND alias'
  );
} else if (!src.includes('const UI_PREFS_KIND = UI_PREFS_MANIFEST_KIND;')) {
  patchText(
    "const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';",
    "const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';\nconst UI_PREFS_KIND = UI_PREFS_MANIFEST_KIND;",
    'UI_PREFS_KIND alias insertion'
  );
}

patchRegex(
  /^const PLANS\s*=\s*\{[\s\S]*?^\};\s*\n/m,
  '',
  'PLANS block'
);

const quotaRegexes = [
  /function\s+quotaBytesForPlan\s*\(\s*planId\s*=\s*['"]free['"]\s*\)\s*\{[\s\S]*?\n\}/m,
  /function\s+quotaBytesForPlan\s*\(\s*planId\s*\)\s*\{[\s\S]*?\n\}/m,
];
for (const regex of quotaRegexes) {
  if (regex.test(src)) {
    src = src.replace(regex, `function quotaBytesForPlan(planId = 'free') {
  return quotaBytes(planId);
}`);
    changed = true;
    console.log('[refactor-main-stable-config] patched quotaBytesForPlan');
    break;
  }
}

const forbiddenPatterns = [
  /^const APP_TITLE\s*=/m,
  /^const CHUNK_SIZE_BYTES\s*=/m,
  /^const TARGET_REPLICAS\s*=/m,
  /^const FREE_QUOTA_BYTES\s*=/m,
  /^const ENCRYPTION_ALGORITHM\s*=/m,
  /^const ENCRYPTION_KEY_SOURCE\s*=/m,
  /^const KDF_ITERATIONS\s*=/m,
  /^const PLANS\s*=/m,
];

const checks = {
  hasCoreConfigImport: src.includes("./core/config.js"),
  hasAppTitle: src.includes('APP_TITLE'),
  hasChunkSize: src.includes('CHUNK_SIZE_BYTES'),
  hasTargetReplicas: src.includes('TARGET_REPLICAS'),
  hasPlans: src.includes('PLANS'),
  hasUiPrefsAlias: src.includes('const UI_PREFS_KIND = UI_PREFS_MANIFEST_KIND;'),
  removedLocalDuplicates: forbiddenPatterns.every((pattern) => !pattern.test(src)),
};

fs.writeFileSync(file, src, 'utf8');
console.log('[refactor-main-stable-config] checks', checks);

if (!checks.hasCoreConfigImport || !checks.removedLocalDuplicates || !checks.hasUiPrefsAlias) {
  console.warn('[refactor-main-stable-config] warning: refactor incomplete', checks);
  process.exitCode = 1;
} else if (changed) {
  console.log('[refactor-main-stable-config] complete');
} else {
  console.log('[refactor-main-stable-config] no changes needed');
}
