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
  "const MAX_WAIT_MS = Number(process.env.P2P_SEED_MAX_WAIT_MS || 24 * 60 * 60 * 1000);",
  "const MAX_WAIT_MS = Number(process.env.P2P_SEED_MAX_WAIT_MS || 24 * 60 * 60 * 1000);\nconst CLOCK_MAX_AGE_MS = Number(process.env.P2P_NETWORK_TIME_MAX_AGE_MS || 10 * 60 * 1000);\nlet observedClockOffsetMs = 0;\nlet observedClockAtMs = 0;",
  'clock constants'
);

replaceOnce(
  "function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }",
  "function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }\nfunction networkTimeUrls() { const urls = [process.env.P2P_NETWORK_TIME_URL, process.env.P2P_BOOTSTRAP_HTTP_URL, process.env.P2P_MANIFEST_SYNC_URL, process.env.P2P_BOOTSTRAP_URL].filter(Boolean); return urls.map((url) => String(url).replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')).filter((url) => /^https?:\\/\\//.test(url)); }\nasync function syncObservedClock() { for (const url of networkTimeUrls()) { try { const started = Date.now(); const res = await fetch(url, { method: 'HEAD' }); const ended = Date.now(); const dateHeader = res.headers.get('date'); if (!dateHeader) continue; const serverMs = Date.parse(dateHeader); if (!Number.isFinite(serverMs)) continue; const midpoint = started + ((ended - started) / 2); observedClockOffsetMs = serverMs - midpoint; observedClockAtMs = Date.now(); return true; } catch {} } return false; }\nfunction startObservedClockLoop() { void syncObservedClock(); setInterval(() => { void syncObservedClock(); }, Number(process.env.P2P_NETWORK_TIME_SYNC_INTERVAL_MS || 60 * 1000)).unref?.(); }",
  'clock helpers'
);

replaceOnce(
  "function nowMs() { return Date.now(); }",
  "function nowMs() { const local = Date.now(); return observedClockAtMs && (local - observedClockAtMs) <= CLOCK_MAX_AGE_MS ? local + observedClockOffsetMs : local; }",
  'network observed now'
);

replaceOnce(
  "function install() { for (const ch of ['seed:create', 'seed:login', 'seed:recover']) { try { ipcMain.removeHandler(ch); } catch {} }",
  "function install() { startObservedClockLoop(); for (const ch of ['seed:create', 'seed:login', 'seed:recover']) { try { ipcMain.removeHandler(ch); } catch {} }",
  'start clock loop'
);

fs.writeFileSync(file, s, 'utf8');
console.log('[seed-network-time] observed network time enabled for seed cooldown');
