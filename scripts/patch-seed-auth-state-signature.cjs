const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'electron', 'seed-auth-cooldown-ipc.js');
let s = fs.readFileSync(file, 'utf8');

function replaceOnce(from, to, label) {
  if (s.includes(to)) return;
  if (!s.includes(from)) throw new Error(`Missing anchor: ${label}`);
  s = s.replace(from, to);
}

replaceOnce(
  "function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }\nfunction writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }",
  "function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }\nfunction writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }\nfunction canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`; return JSON.stringify(value); }\nfunction deviceIdentity() { return readJson(devicePath(), null); }\nfunction signStatePayload(payload) { const identity = deviceIdentity(); if (!identity?.privateKeyPem || identity.deviceId !== payload.deviceId) return { ...payload, signature: null, signedByDeviceId: payload.deviceId, signedByPublicKeyPem: identity?.publicKeyPem || null, signatureAlgorithm: null }; const unsigned = { ...payload }; delete unsigned.signature; delete unsigned.signedByPublicKeyPem; delete unsigned.signedByDeviceId; delete unsigned.signatureAlgorithm; const signature = crypto.sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), crypto.createPrivateKey(identity.privateKeyPem)).toString('base64'); return { ...payload, signature, signedByDeviceId: identity.deviceId, signedByPublicKeyPem: identity.publicKeyPem, signatureAlgorithm: 'ed25519' }; }\nfunction verifyStatePayload(payload) { if (!payload?.signature || !payload?.signedByPublicKeyPem || payload.signedByDeviceId !== payload.deviceId) return false; try { const unsigned = { ...payload }; delete unsigned.signature; delete unsigned.signedByPublicKeyPem; delete unsigned.signedByDeviceId; delete unsigned.signatureAlgorithm; return crypto.verify(null, Buffer.from(canonicalJson(unsigned), 'utf8'), crypto.createPublicKey(payload.signedByPublicKeyPem), Buffer.from(String(payload.signature || ''), 'base64')); } catch { return false; } }",
  'signature helpers'
);

replaceOnce(
  "const data = Buffer.from(JSON.stringify(payload), 'utf8'); const h = hash(data);",
  "const signedPayload = signStatePayload(payload); const data = Buffer.from(JSON.stringify(signedPayload), 'utf8'); const h = hash(data);",
  'sign payload before hash'
);

replaceOnce(
  "writeJson(objectPath(h), { ...payload, hash: h });",
  "writeJson(objectPath(h), { ...signedPayload, hash: h });",
  'write signed payload'
);

replaceOnce(
  "if (!remote || remote.deviceId !== dev || remote.accountId !== account.accountId) return account;",
  "if (!remote || remote.deviceId !== dev || remote.accountId !== account.accountId || !verifyStatePayload(remote)) return account;",
  'verify remote payload'
);

fs.writeFileSync(file, s, 'utf8');
require('./patch-seed-network-time.cjs');
console.log('[seed-auth-state-signature] signed and verified device-scoped cooldown state; network time patch chained');
