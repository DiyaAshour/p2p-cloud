const fs = require('node:fs');

const file = 'electron/main-stable.js';
if (!fs.existsSync(file)) throw new Error(`${file} not found`);

let src = fs.readFileSync(file, 'utf8');
let changed = false;

function replaceOnce(find, replacement, label) {
  if (!src.includes(find)) {
    console.log(`[refactor-main-stable-config] skip ${label}: marker not found`);
    return false;
  }
  src = src.replace(find, replacement);
  changed = true;
  console.log(`[refactor-main-stable-config] patched ${label}`);
  return true;
}

if (!src.includes("./core/config.js")) {
  replaceOnce(
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

const localConstantsBlock = `const APP_TITLE = 'p2p.cloud';
const IS_DEV = !app.isPackaged;
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';
const CHUNK_SIZE_BYTES = Number(process.env.P2P_CHUNK_SIZE_BYTES || 1024 * 1024);
const TARGET_REPLICAS = Number(process.env.P2P_TARGET_REPLICAS || 3);
const AUTO_REPAIR_INTERVAL_MS = Math.max(30_000, Number(process.env.P2P_AUTO_REPAIR_INTERVAL_MS || 60_000));
const UPLOAD_CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.P2P_UPLOAD_CONCURRENCY || 4)));
const DOWNLOAD_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.P2P_DOWNLOAD_CONCURRENCY || 6)));
const FREE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY_SOURCE = 'wallet-password-v1';
function keySourceForIdentity() { return ENCRYPTION_KEY_SOURCE; }
const KDF_ALGORITHM = 'pbkdf2-sha256';
const KDF_ITERATIONS = 310000;
const MIN_DRIVE_PASSWORD_LENGTH = Number(process.env.P2P_MIN_DRIVE_PASSWORD_LENGTH || 12);
const WALLET_LOGIN_MAX_AGE_MS = 10 * 60 * 1000;
const WALLET_LOGIN_MAX_FUTURE_MS = 2 * 60 * 1000;
const FOLDER_MANIFEST_KIND = 'folder';
const UI_PREFS_KIND = 'ui:prefs';

const PLANS = {
  free: { id: 'free', name: 'Free', quotaBytes: FREE_QUOTA_BYTES, priceUsd: 0, locked: false },
  tb1: { id: 'tb1', name: '1 TB', quotaBytes: 1 * 1024 ** 4, priceUsd: 1, locked: true },
  tb3: { id: 'tb3', name: '3 TB', quotaBytes: 3 * 1024 ** 4, priceUsd: 2.5, locked: true },
  tb7: { id: 'tb7', name: '7 TB', quotaBytes: 7 * 1024 ** 4, priceUsd: 4.99, locked: true },
  tb10: { id: 'tb10', name: '10 TB', quotaBytes: 10 * 1024 ** 4, priceUsd: 7.99, locked: true },
};`;

replaceOnce(
  localConstantsBlock,
  `const IS_DEV = !app.isPackaged;
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';
const UI_PREFS_KIND = UI_PREFS_MANIFEST_KIND;
function keySourceForIdentity() { return ENCRYPTION_KEY_SOURCE; }`,
  'local config constants block'
);

const quotaRegex = /function\s+quotaBytesForPlan\s*\(\s*planId\s*=\s*['"]free['"]\s*\)\s*\{[\s\S]*?return\s+FREE_QUOTA_BYTES;\s*\}/m;
if (quotaRegex.test(src)) {
  src = src.replace(
    quotaRegex,
    `function quotaBytesForPlan(planId = 'free') {
  return quotaBytes(planId);
}`
  );
  changed = true;
  console.log('[refactor-main-stable-config] patched quotaBytesForPlan');
}

const forbidden = [
  "const CHUNK_SIZE_BYTES = Number(process.env.P2P_CHUNK_SIZE_BYTES",
  "const TARGET_REPLICAS = Number(process.env.P2P_TARGET_REPLICAS",
  "const FREE_QUOTA_BYTES = 5 * 1024",
  "const KDF_ITERATIONS = 310000",
  "const PLANS = {",
];

const checks = {
  hasCoreConfigImport: src.includes("./core/config.js"),
  hasAppTitle: src.includes('APP_TITLE'),
  hasChunkSize: src.includes('CHUNK_SIZE_BYTES'),
  hasTargetReplicas: src.includes('TARGET_REPLICAS'),
  hasPlans: src.includes('PLANS'),
  removedLocalDuplicates: forbidden.every((token) => !src.includes(token)),
};

fs.writeFileSync(file, src, 'utf8');
console.log('[refactor-main-stable-config] checks', checks);

if (!checks.hasCoreConfigImport || !checks.removedLocalDuplicates) {
  console.warn('[refactor-main-stable-config] warning: refactor incomplete', checks);
  process.exitCode = 1;
} else if (changed) {
  console.log('[refactor-main-stable-config] complete');
} else {
  console.log('[refactor-main-stable-config] no changes needed');
}
