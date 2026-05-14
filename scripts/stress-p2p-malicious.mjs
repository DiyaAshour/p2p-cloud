import { WebSocket } from 'ws';
import crypto from 'node:crypto';

const BOOTSTRAP_URL = process.env.P2P_STRESS_BOOTSTRAP_URL || 'ws://127.0.0.1:8788';
const TRANSPORT_URL = process.env.P2P_STRESS_TRANSPORT_URL || 'ws://127.0.0.1:8787';
const ROUNDS = Number(process.env.P2P_MALICIOUS_ROUNDS || 100);
const CONCURRENCY = Number(process.env.P2P_MALICIOUS_CONCURRENCY || 25);
const OVERSIZED_BYTES = Number(process.env.P2P_MALICIOUS_OVERSIZED_BYTES || 10 * 1024 * 1024);

const stats = {
  startedAt: Date.now(),
  attempted: 0,
  opened: 0,
  closed: 0,
  errors: new Map(),
  cases: new Map(),
};

function inc(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function recordError(error) {
  inc(stats.errors, String(error?.message || error || 'unknown'));
}

function sendCase({ url, name, messages, holdMs = 100 }) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { maxPayload: OVERSIZED_BYTES + 1024 });
    let finished = false;
    stats.attempted += 1;
    inc(stats.cases, name);

    const finish = (result) => {
      if (finished) return;
      finished = true;
      resolve(result);
    };

    const timeout = setTimeout(() => {
      socket.close();
      finish({ ok: false, name, error: 'timeout' });
    }, 5000);

    socket.on('open', () => {
      stats.opened += 1;
      for (const message of messages) {
        if (typeof message === 'string' || Buffer.isBuffer(message)) socket.send(message);
        else socket.send(JSON.stringify(message));
      }
      setTimeout(() => {
        clearTimeout(timeout);
        socket.close();
        finish({ ok: true, name });
      }, holdMs);
    });

    socket.on('close', () => {
      stats.closed += 1;
    });

    socket.on('error', (error) => {
      recordError(error);
      clearTimeout(timeout);
      finish({ ok: false, name, error: error.message });
    });
  });
}

function maliciousCases(index) {
  const peerId = `evil-peer-${index}-${crypto.randomUUID()}`;
  const oversized = 'x'.repeat(OVERSIZED_BYTES);
  return [
    {
      url: BOOTSTRAP_URL,
      name: 'bootstrap-invalid-json',
      messages: ['{not-json'],
    },
    {
      url: BOOTSTRAP_URL,
      name: 'bootstrap-missing-fields',
      messages: [{ type: 'peer:register', peerId: '', url: '' }],
    },
    {
      url: BOOTSTRAP_URL,
      name: 'bootstrap-register-spam',
      messages: Array.from({ length: 10 }, (_, n) => ({ type: 'peer:register', peerId: `${peerId}-spam-${n}`, url: `ws://127.0.0.1:${30000 + index + n}` })),
    },
    {
      url: BOOTSTRAP_URL,
      name: 'bootstrap-oversized-payload',
      messages: [oversized],
    },
    {
      url: TRANSPORT_URL,
      name: 'transport-invalid-json',
      messages: ['{not-json'],
    },
    {
      url: TRANSPORT_URL,
      name: 'transport-bad-hello',
      messages: [{ type: 'peer:hello', fromPeerId: '', payload: { url: '' } }],
    },
    {
      url: TRANSPORT_URL,
      name: 'transport-chunk-get-spam',
      messages: Array.from({ length: 20 }, () => ({ id: crypto.randomUUID(), type: 'chunk:get', fromPeerId: peerId, createdAt: Date.now(), payload: { chunkHash: crypto.randomBytes(32).toString('hex') } })),
    },
    {
      url: TRANSPORT_URL,
      name: 'transport-oversized-payload',
      messages: [oversized],
    },
  ];
}

async function runPool() {
  const all = Array.from({ length: ROUNDS }, (_, index) => maliciousCases(index)).flat();
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, all.length) }, async () => {
    while (next < all.length) {
      const current = next;
      next += 1;
      await sendCase(all[current]);
    }
  });
  await Promise.all(workers);
}

function printSummary() {
  const elapsedSeconds = Math.max(0.001, (Date.now() - stats.startedAt) / 1000);
  console.log(JSON.stringify({
    bootstrapUrl: BOOTSTRAP_URL,
    transportUrl: TRANSPORT_URL,
    rounds: ROUNDS,
    concurrency: CONCURRENCY,
    elapsedSeconds,
    attempted: stats.attempted,
    opened: stats.opened,
    closed: stats.closed,
    cases: Object.fromEntries(stats.cases.entries()),
    errors: Object.fromEntries(stats.errors.entries()),
  }, null, 2));
}

await runPool();
printSummary();
