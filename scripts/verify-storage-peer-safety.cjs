const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const storagePeerPath = path.join(root, 'server', 'storage-peer.js');
const envExamplePath = path.join(root, '.env.example');

function readRequired(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing required file for storage peer verification: ${label}`);
  return fs.readFileSync(filePath, 'utf8');
}

function assertIncludes(text, needle, label, failures) {
  if (!text.includes(needle)) failures.push(`Missing ${label}: ${needle}`);
}

function assertMatches(text, pattern, label, failures) {
  if (!pattern.test(text)) failures.push(`Missing or invalid ${label}`);
}

const source = readRequired(storagePeerPath, 'server/storage-peer.js');
const envExample = readRequired(envExamplePath, '.env.example');
const failures = [];

for (const [needle, label] of [
  ['MAX_CHUNK_BYTES', 'max chunk size limit'],
  ['MAX_MESSAGE_BYTES', 'max message size limit'],
  ['maxPayload: MAX_MESSAGE_BYTES', 'WebSocket maxPayload enforcement'],
  ['MAX_PUTS_PER_MINUTE', 'put rate limit'],
  ['MAX_GETS_PER_MINUTE', 'get rate limit'],
  ['MAX_DELETES_PER_MINUTE', 'delete rate limit'],
  ['peerBucket(socket, \'put\')', 'put rate bucket use'],
  ['peerBucket(socket, \'get\')', 'get rate bucket use'],
  ['peerBucket(socket, \'delete\')', 'delete rate bucket use'],
  ['normalizeChunkHash(hash)', 'chunk hash normalization'],
  ['if (!/^[a-f0-9]{64}$/.test(clean))', 'strict chunk hash format'],
  ['Buffer.from(chunk.data, \'base64\')', 'base64 decode for validation'],
  ['if (data.length > MAX_CHUNK_BYTES)', 'chunk size maximum check'],
  ['if (sha256Hex(data) !== hash)', 'chunk hash validation'],
  ['if (!Number.isFinite(size)', 'chunk size validation'],
  ['const server = new WebSocketServer', 'storage WebSocket server'],
  ['socket.close(1009, \'Message too large\')', 'oversized message close'],
  ['DELETE_ADMIN_TOKEN', 'delete token configuration'],
  ['function verifyDeleteAdminToken', 'delete token verifier'],
  ['Storage peer delete token is not configured', 'delete disabled without token'],
  ['crypto.timingSafeEqual', 'timing-safe token compare'],
  ['verifyDeleteAdminToken(message.payload?.adminToken || \'\')', 'delete path requires token verifier'],
]) {
  assertIncludes(source, needle, label, failures);
}

assertMatches(source, /if \(message\.type === ['"]chunk:put['"]\)/, 'chunk:put handler', failures);
assertMatches(source, /if \(message\.type === ['"]chunk:get['"]\)/, 'chunk:get handler', failures);
assertMatches(source, /if \(message\.type === ['"]chunk:delete['"]\)/, 'chunk:delete handler', failures);

if (/if \(DELETE_ADMIN_TOKEN && message\.payload\?\.adminToken !== DELETE_ADMIN_TOKEN\)/.test(source)) {
  failures.push('Unsafe optional delete token guard found; deletes must be denied when token is not configured');
}

if (/delete support: enabled\$\{DELETE_ADMIN_TOKEN \?/.test(source)) {
  failures.push('Old delete support log suggests deletes can be enabled without strict token requirement');
}

for (const [needle, label] of [
  ['STORAGE_PEER_ADMIN_TOKEN=', 'storage peer admin delete token env placeholder'],
  ['STORAGE_PEER_MAX_CHUNK_BYTES=', 'storage peer max chunk env placeholder'],
  ['STORAGE_PEER_MAX_MESSAGE_BYTES=', 'storage peer max message env placeholder'],
  ['STORAGE_PEER_MAX_PUTS_PER_MINUTE=', 'storage peer put rate env placeholder'],
  ['STORAGE_PEER_MAX_GETS_PER_MINUTE=', 'storage peer get rate env placeholder'],
  ['STORAGE_PEER_MAX_DELETES_PER_MINUTE=', 'storage peer delete rate env placeholder'],
]) {
  assertIncludes(envExample, needle, label, failures);
}

if (failures.length > 0) {
  console.error('[verify-storage-peer-safety] failed: storage peer safety invariants are not enforced');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-storage-peer-safety] ok: storage peer validates chunks, rate-limits peers, and protects deletes');
