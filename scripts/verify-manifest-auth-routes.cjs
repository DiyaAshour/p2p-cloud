const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const serverPath = path.join(root, 'server', 'manifest-sync', 'index.js');

if (!fs.existsSync(serverPath)) {
  throw new Error('Missing server/manifest-sync/index.js');
}

const server = fs.readFileSync(serverPath, 'utf8');
const failures = [];

function mustInclude(needle, label) {
  if (!server.includes(needle)) failures.push(`Missing ${label}`);
}

mustInclude('process.env.MANIFEST_SYNC_REQUIRE_AUTH ?? "true"', 'default-on manifest write guard');
mustInclude('function requireManifestAuth', 'manifest write guard middleware');
mustInclude('app.post("/wallet/:address/manifests", requireManifestAuth,', 'protected manifest write route');
mustInclude('app.delete("/wallet/:address/manifests/:hash", requireManifestAuth,', 'protected manifest delete route');
mustInclude('crypto.createHmac("sha256",', 'request signature verification');
mustInclude('crypto.timingSafeEqual', 'timing safe comparison');
mustInclude('usedNonces.has(nonceKey)', 'nonce replay protection');
mustInclude('Math.abs(now - ts) > AUTH_MAX_AGE_MS', 'timestamp age guard');
mustInclude('identity !== normalizeIdentity(expectedIdentity)', 'identity ownership guard');
mustInclude('ownerWallet !== address', 'manifest ownership guard');

if (failures.length) {
  console.error('[verify-manifest-auth-routes] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-manifest-auth-routes] ok: manifest mutation routes are protected');
