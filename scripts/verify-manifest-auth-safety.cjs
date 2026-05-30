const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const manifestServerPath = path.join(root, 'server', 'manifest-sync', 'index.js');
const envExamplePath = path.join(root, '.env.example');

function readRequired(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing required file for manifest auth verification: ${label}`);
  return fs.readFileSync(filePath, 'utf8');
}

function assertIncludes(text, needle, label, failures) {
  if (!text.includes(needle)) failures.push(`Missing ${label}: ${needle}`);
}

function assertMatches(text, pattern, label, failures) {
  if (!pattern.test(text)) failures.push(`Missing or invalid ${label}`);
}

const server = readRequired(manifestServerPath, 'server/manifest-sync/index.js');
const envExample = readRequired(envExamplePath, '.env.example');
const failures = [];

// Auth must default to required. It may be disabled only deliberately via env at runtime,
// but the source must not default to open writes.
assertMatches(
  server,
  /const\s+REQUIRE_AUTH\s*=\s*String\(process\.env\.MANIFEST_SYNC_REQUIRE_AUTH\s*\?\?\s*["']true["']\)\.toLowerCase\(\)\s*!==\s*["']false["']/,
  'MANIFEST_SYNC_REQUIRE_AUTH default true guard',
  failures,
);

// Required primitives for request authentication.
for (const [needle, label] of [
  ['const AUTH_VERSION = "hmac-sha256-v1"', 'auth version'],
  ['MANIFEST_SYNC_AUTH_SECRET', 'manifest auth secret env'],
  ['P2P_MANIFEST_SYNC_AUTH_SECRET', 'client/server shared auth secret env'],
  ['x-manifest-auth-version', 'auth version header'],
  ['x-manifest-identity', 'identity header'],
  ['x-manifest-timestamp', 'timestamp header'],
  ['x-manifest-nonce', 'nonce header'],
  ['x-manifest-body-sha256', 'body hash header'],
  ['x-manifest-signature', 'signature header'],
  ['crypto.createHmac("sha256", secret)', 'HMAC-SHA256 signature verification'],
  ['crypto.timingSafeEqual', 'timing safe signature compare'],
  ['usedNonces.has(nonceKey)', 'nonce replay protection'],
  ['Math.abs(now - ts) > AUTH_MAX_AGE_MS', 'timestamp expiry protection'],
  ['actualBodySha256 !== bodySha256', 'body hash verification'],
  ['identity !== normalizeIdentity(expectedIdentity)', 'identity/path ownership check'],
  ['ownerWallet !== address', 'manifest ownerWallet ownership check'],
]) {
  assertIncludes(server, needle, label, failures);
}

// Mutating routes must be protected by requireManifestAuth.
assertMatches(
  server,
  /app\.post\(\s*["']\/wallet\/:address\/manifests["']\s*,\s*requireManifestAuth\s*,/,
  'POST /wallet/:address/manifests auth middleware',
  failures,
);
assertMatches(
  server,
  /app\.delete\(\s*["']\/wallet\/:address\/manifests\/:hash["']\s*,\s*requireManifestAuth\s*,/,
  'DELETE /wallet/:address/manifests/:hash auth middleware',
  failures,
);

assertMatches(
  server,
  /function\s+requireManifestAuth\s*\(/,
  'requireManifestAuth function',
  failures,
);

function routeHasAuth(method, routeLiteral) {
  const escapedRoute = routeLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const protectedPattern = new RegExp(
    `app\\.${method}\\(\\s*["']${escapedRoute}["']\\s*,\\s*requireManifestAuth\\s*,`,
  );
  return protectedPattern.test(server);
}

if (!routeHasAuth('post', '/wallet/:address/manifests')) {
  failures.push('POST manifest route appears to be missing requireManifestAuth');
}

if (!routeHasAuth('delete', '/wallet/:address/manifests/:hash')) {
  failures.push('DELETE manifest route appears to be missing requireManifestAuth');
}

// Explicitly forbid the simple open route shapes without relying on a backtracking-prone negative lookahead.
const openPostPattern = /app\.post\(\s*["']\/wallet\/:address\/manifests["']\s*,\s*(?!requireManifestAuth\s*,)(?:async\s*)?\(?\s*(?:req|_req|request)/;
if (openPostPattern.test(server)) failures.push('POST manifest route appears to be open');

const openDeletePattern = /app\.delete\(\s*["']\/wallet\/:address\/manifests\/:hash["']\s*,\s*(?!requireManifestAuth\s*,)(?:async\s*)?\(?\s*(?:req|_req|request)/;
if (openDeletePattern.test(server)) failures.push('DELETE manifest route appears to be open');

// .env.example must document auth-on defaults.
for (const [needle, label] of [
  ['MANIFEST_SYNC_REQUIRE_AUTH=true', 'env auth required default'],
  ['MANIFEST_SYNC_AUTH_SECRET=replace-with-long-random-secret', 'server auth secret placeholder'],
  ['P2P_MANIFEST_SYNC_AUTH_SECRET=replace-with-long-random-secret', 'client auth secret placeholder'],
]) {
  assertIncludes(envExample, needle, label, failures);
}

if (failures.length > 0) {
  console.error('[verify-manifest-auth-safety] failed: manifest mutation auth is not safely enforced');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-manifest-auth-safety] ok: manifest writes/deletes require authenticated, owner-bound requests');
