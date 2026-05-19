const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function log(title, value = '') {
  if (value === '') console.log(`\n=== ${title} ===`);
  else console.log(`${title}:`, value);
}

function env(name, fallback = '') {
  return String(process.env[name] || fallback || '').trim();
}

function normalizeWallet(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isWallet(value = '') {
  return /^0x[a-f0-9]{40}$/.test(normalizeWallet(value));
}

function defaultUserDataDir() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'p2p.cloud');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'p2p.cloud');
  return path.join(os.homedir(), '.config', 'p2p.cloud');
}

function safeJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function manifestBaseUrl() {
  return env('P2P_MANIFEST_SYNC_URL') || env('MANIFEST_SYNC_URL') || env('VITE_MANIFEST_SYNC_URL') || 'http://54.166.171.208:8790';
}

function safetyUrl() {
  return env('P2P_SAFETY_PEER_URL') || env('STORAGE_PEER_URL') || env('VITE_STORAGE_PEER_URL') || 'ws://54.166.171.208:8787';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: res.ok, status: res.status, text: text.slice(0, 500), json };
  } finally {
    clearTimeout(timer);
  }
}

async function testManifestSync(wallet) {
  log('Manifest Sync Remote');
  const base = manifestBaseUrl().replace(/\/$/, '');
  log('URL', base);

  if (!base) {
    console.log('SKIP: manifest sync URL is empty.');
    return;
  }

  if (!wallet || !isWallet(wallet)) {
    console.log('SKIP wallet pull test: no valid 0x wallet supplied. Use: node scripts/diagnose-manifest-safety.cjs --wallet 0x...');
    return;
  }

  try {
    const url = `${base}/wallet/${normalizeWallet(wallet)}/manifests`;
    const result = await fetchWithTimeout(url, {}, Number(env('P2P_DIAG_TIMEOUT_MS', '8000')));
    log('GET status', result.status);
    log('GET ok', result.ok);
    if (result.json) {
      log('Remote ok', result.json.ok);
      log('Remote manifest count', Array.isArray(result.json.manifests) ? result.json.manifests.length : 'not-array');
    } else {
      log('Remote text', result.text || '(empty)');
    }
  } catch (error) {
    console.log('FAIL:', error?.message || String(error));
  }
}

async function testSafetyPeer() {
  log('Safety Peer Remote');
  const url = safetyUrl();
  log('URL', url);

  if (!/^wss?:\/\//i.test(url)) {
    console.log('SKIP: invalid safety peer URL.');
    return;
  }

  let WebSocket;
  try {
    WebSocket = require('ws');
  } catch {
    console.log('SKIP: ws package not available. Run pnpm install first.');
    return;
  }

  const timeoutMs = Number(env('P2P_DIAG_TIMEOUT_MS', '8000'));
  await new Promise((resolve) => {
    const socket = new WebSocket(url);
    const started = Date.now();
    let done = false;

    function finish(label, details = '') {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      console.log(label, details);
      resolve();
    }

    const timer = setTimeout(() => finish('FAIL:', `connection timeout after ${timeoutMs}ms`), timeoutMs);

    socket.once('open', () => {
      console.log('OK: connected in', `${Date.now() - started}ms`);
      socket.send(JSON.stringify({ type: 'peer:hello', fromPeerId: 'diagnostic-client' }));
      setTimeout(() => finish('OK:', 'hello sent; socket accepted connection'), 300);
    });

    socket.once('error', (error) => finish('FAIL:', error?.message || String(error)));
  });
}

function inspectLocal() {
  log('Local Manifest / Chunk Store');
  const userData = env('P2P_USER_DATA_DIR') || defaultUserDataDir();
  const storageDir = path.join(userData, 'native-p2p-storage');
  const manifestsPath = path.join(storageDir, 'manifests.json');
  const walletPath = path.join(storageDir, 'wallet.json');
  const chunkDir = env('P2P_CHUNK_STORE_DIR') || path.join(storageDir, 'chunks');

  log('User data', userData);
  log('Manifest path', manifestsPath);
  log('Wallet path', walletPath);
  log('Chunk dir', chunkDir);

  const manifests = safeJson(manifestsPath, []);
  const wallet = safeJson(walletPath, {});
  const chunksOnDisk = fs.existsSync(chunkDir) ? fs.readdirSync(chunkDir).filter((name) => /^[a-f0-9]{64}$/i.test(name)) : [];

  log('Wallet connected', wallet.connected);
  log('Wallet verified', wallet.verified);
  log('Wallet authMode', wallet.authMode || '(none)');
  log('Wallet identity', wallet.accountId || wallet.address || '(none)');
  log('Manifest count', Array.isArray(manifests) ? manifests.length : 'not-array');
  log('Chunks on disk', chunksOnDisk.length);

  if (!Array.isArray(manifests)) return { wallet: wallet.accountId || wallet.address || '' };

  const files = manifests.filter((m) => !(m.kind === 'folder' || m.isFolder === true || String(m.hash || '').startsWith('folder:')));
  const folders = manifests.filter((m) => (m.kind === 'folder' || m.isFolder === true || String(m.hash || '').startsWith('folder:')));
  const encrypted = files.filter((m) => m.isEncrypted === true);
  const badEncrypted = encrypted.filter((m) => !(m.encryption && m.encryption.algorithm && m.encryption.salt && m.encryption.iv && m.encryption.authTag));
  const allChunkRefs = files.flatMap((m) => Array.isArray(m.chunks) ? m.chunks.map((c) => c.hash).filter(Boolean) : []);
  const missingChunks = allChunkRefs.filter((hash) => !chunksOnDisk.includes(String(hash).toLowerCase()));
  const duplicateHashes = allChunkRefs.filter((hash, i, arr) => arr.indexOf(hash) !== i);

  log('File manifests', files.length);
  log('Folder manifests', folders.length);
  log('Encrypted files', encrypted.length);
  log('Bad encrypted manifests', badEncrypted.length);
  log('Chunk refs in manifests', allChunkRefs.length);
  log('Missing local chunks', missingChunks.length);
  log('Duplicate chunk refs', duplicateHashes.length);

  if (files[0]) {
    log('Latest/first file sample');
    const f = files.slice().sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')))[0];
    console.log(JSON.stringify({
      name: f.name,
      hash: f.hash,
      rootHash: f.rootHash,
      uploadedAt: f.uploadedAt,
      totalChunks: f.totalChunks,
      replicas: f.replicas,
      firstChunk: f.chunks?.[0]?.hash,
      encrypted: f.isEncrypted,
      folder: f.folderName || f.folder || '',
    }, null, 2));
  }

  if (missingChunks.length) {
    console.log('\nMissing chunk sample:', missingChunks.slice(0, 10));
  }

  return { wallet: wallet.accountId || wallet.address || '' };
}

async function main() {
  const walletArgIndex = process.argv.indexOf('--wallet');
  const walletArg = walletArgIndex >= 0 ? process.argv[walletArgIndex + 1] : '';
  const local = inspectLocal();
  const wallet = walletArg || local.wallet || '';
  await testManifestSync(wallet);
  await testSafetyPeer();

  log('Meaning');
  console.log('- Missing local chunks > 0 يعني manifest يشير إلى chunks غير موجودة محليًا.');
  console.log('- Manifest remote FAIL يعني cross-device sync متعطل/بطيء، لكن الرفع لازم يظل ينجح بعد best-effort fix.');
  console.log('- Safety peer FAIL يعني النسخة الاحتياطية المركزية غير متاحة، لكن P2P/local upload لازم يظل ينجح.');
}

main().catch((error) => {
  console.error('DIAG FAILED:', error?.stack || error?.message || error);
  process.exitCode = 1;
});
