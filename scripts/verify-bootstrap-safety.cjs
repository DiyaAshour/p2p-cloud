const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const bootstrapPath = path.join(root, 'server', 'bootstrap-server', 'index.js');
const envExamplePath = path.join(root, '.env.example');

function readRequired(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing required file for bootstrap verification: ${label}`);
  return fs.readFileSync(filePath, 'utf8');
}

function assertIncludes(text, needle, label, failures) {
  if (!text.includes(needle)) failures.push(`Missing ${label}: ${needle}`);
}

function assertMatches(text, pattern, label, failures) {
  if (!pattern.test(text)) failures.push(`Missing or invalid ${label}`);
}

const source = readRequired(bootstrapPath, 'server/bootstrap-server/index.js');
const envExample = readRequired(envExamplePath, '.env.example');
const failures = [];

for (const [needle, label] of [
  ['MAX_BOOTSTRAP_PEERS', 'bootstrap peer cap'],
  ['MAX_PEERS_PER_RESPONSE', 'response peer limit'],
  ['MAX_MESSAGES_PER_MINUTE', 'message rate limit'],
  ['PEER_TTL_MS', 'peer TTL'],
  ['MAX_PAYLOAD_BYTES', 'payload size limit'],
  ['MAX_PEER_ID_LENGTH', 'peer id length limit'],
  ['MAX_URL_LENGTH', 'url length limit'],
  ['ALLOWED_ROLES', 'allowed role set'],
  ['const server = new WebSocketServer({ host: HOST, port: PORT, maxPayload: MAX_PAYLOAD_BYTES })', 'WebSocket maxPayload enforcement'],
  ['function isRateLimited(socket)', 'rate limit function'],
  ['function normalizePeerId', 'peer id validator'],
  ['function normalizePeerUrl', 'peer url validator'],
  ['function normalizeRole', 'peer role validator'],
  ['function sanitizePeerMessage', 'peer registration sanitizer'],
  ['function publicPeer', 'public peer shape sanitizer'],
  ['Peer url must use ws:// or wss://', 'ws/wss protocol enforcement'],
  ['Peer url must not include credentials', 'credential-free URL enforcement'],
  ['Peer url must not include query or hash', 'query/hash URL rejection'],
  ['Peer url path is not allowed', 'path URL rejection'],
  ['Invalid peer url port', 'port range validation'],
  ['sanitizePeerMessage(msg)', 'registration uses sanitizer'],
  ['normalizePeerId(socketPeerIds.get(socket) || msg.peerId)', 'heartbeat validates peerId'],
  ['socket.close(1009, "bootstrap message too large")', 'oversized message close'],
  ['socket.close(1013, "bootstrap peer cap reached")', 'peer cap close'],
]) {
  assertIncludes(source, needle, label, failures);
}

assertMatches(source, /if \(msg\.type === ["']peer:register["']\)/, 'peer:register handler', failures);
assertMatches(source, /if \(msg\.type === ["']peer:heartbeat["']\)/, 'peer:heartbeat handler', failures);
assertMatches(source, /if \(!\/\^\[a-zA-Z0-9\._:-\]\+\$\/\.test\(value\)\)/, 'strict peerId regex', failures);
assertMatches(source, /if \(\!\["ws:", "wss:"\]\.includes\(parsed\.protocol\)\)/, 'strict bootstrap URL protocol list', failures);

if (/const peer = \{ peerId: msg\.peerId, url: msg\.url/.test(source)) {
  failures.push('Unsafe raw peer registration found; must use sanitized peer values');
}

for (const [needle, label] of [
  ['P2P_BOOTSTRAP_MAX_PEERS=', 'bootstrap max peers env placeholder'],
  ['P2P_BOOTSTRAP_RESPONSE_LIMIT=', 'bootstrap response limit env placeholder'],
  ['P2P_BOOTSTRAP_MESSAGES_PER_MINUTE=', 'bootstrap message rate env placeholder'],
  ['P2P_BOOTSTRAP_PEER_TTL_MS=', 'bootstrap peer TTL env placeholder'],
  ['P2P_BOOTSTRAP_MAX_PAYLOAD_BYTES=', 'bootstrap payload limit env placeholder'],
  ['P2P_BOOTSTRAP_MAX_PEER_ID_LENGTH=', 'bootstrap peer id length env placeholder'],
  ['P2P_BOOTSTRAP_MAX_URL_LENGTH=', 'bootstrap URL length env placeholder'],
]) {
  assertIncludes(envExample, needle, label, failures);
}

if (failures.length > 0) {
  console.error('[verify-bootstrap-safety] failed: bootstrap discovery safety invariants are not enforced');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-bootstrap-safety] ok: bootstrap validates peers, limits responses, rate-limits messages, and prunes stale peers');
