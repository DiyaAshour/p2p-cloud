import { WebSocket } from 'ws';
import crypto from 'node:crypto';

const BOOTSTRAP_URL = process.env.P2P_STRESS_BOOTSTRAP_URL || 'ws://127.0.0.1:8788';
const PEERS = Number(process.env.P2P_STRESS_PEERS || 250);
const CONCURRENCY = Number(process.env.P2P_STRESS_CONCURRENCY || 50);
const HOLD_MS = Number(process.env.P2P_STRESS_HOLD_MS || 5000);
const BASE_PORT = Number(process.env.P2P_STRESS_BASE_PORT || 20000);

const stats = {
  startedAt: Date.now(),
  attempted: 0,
  connected: 0,
  registered: 0,
  failed: 0,
  closed: 0,
  totalKnownPeers: 0,
  errors: new Map(),
};

function addError(error) {
  const key = String(error?.message || error || 'unknown');
  stats.errors.set(key, (stats.errors.get(key) || 0) + 1);
}

function registerPeer(index) {
  return new Promise((resolve) => {
    const peerId = `stress-peer-${index}-${crypto.randomUUID()}`;
    const url = `ws://127.0.0.1:${BASE_PORT + index}`;
    const socket = new WebSocket(BOOTSTRAP_URL, { maxPayload: 1024 * 1024 });
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    const timeout = setTimeout(() => {
      stats.failed += 1;
      addError('register timeout');
      socket.close();
      finish({ ok: false, peerId, error: 'timeout' });
    }, 10000);

    stats.attempted += 1;

    socket.on('open', () => {
      stats.connected += 1;
      socket.send(JSON.stringify({ type: 'peer:register', peerId, url }));
    });

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'bootstrap:peers') {
          stats.registered += 1;
          stats.totalKnownPeers += Array.isArray(msg.peers) ? msg.peers.length : 0;
          clearTimeout(timeout);
          setTimeout(() => {
            socket.close();
            finish({ ok: true, peerId, peers: msg.peers?.length || 0 });
          }, HOLD_MS);
        }
        if (msg.type === 'bootstrap:error') {
          stats.failed += 1;
          addError(msg.error);
          clearTimeout(timeout);
          socket.close();
          finish({ ok: false, peerId, error: msg.error });
        }
      } catch (error) {
        stats.failed += 1;
        addError(error);
      }
    });

    socket.on('close', () => {
      stats.closed += 1;
    });

    socket.on('error', (error) => {
      stats.failed += 1;
      addError(error);
      clearTimeout(timeout);
      finish({ ok: false, peerId, error: error.message });
    });
  });
}

async function runPool() {
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, PEERS) }, async () => {
    while (next < PEERS) {
      const index = next;
      next += 1;
      await registerPeer(index);
    }
  });
  await Promise.all(workers);
}

function printSummary() {
  const elapsedSeconds = Math.max(0.001, (Date.now() - stats.startedAt) / 1000);
  const avgKnownPeers = stats.registered ? stats.totalKnownPeers / stats.registered : 0;
  console.log(JSON.stringify({
    bootstrapUrl: BOOTSTRAP_URL,
    peers: PEERS,
    concurrency: CONCURRENCY,
    holdMs: HOLD_MS,
    elapsedSeconds,
    attempted: stats.attempted,
    connected: stats.connected,
    registered: stats.registered,
    failed: stats.failed,
    closed: stats.closed,
    registrationsPerSecond: stats.registered / elapsedSeconds,
    avgKnownPeersPerRegistration: avgKnownPeers,
    errors: Object.fromEntries(stats.errors.entries()),
  }, null, 2));
}

await runPool();
printSummary();
