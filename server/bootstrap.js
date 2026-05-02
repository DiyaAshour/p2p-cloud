import express from 'express';

const app = express();

const PORT = Number(process.env.PORT || process.env.BOOTSTRAP_PORT || 4000);
const PEER_TTL_MS = Number(process.env.PEER_TTL_MS || 60_000);
const MAX_PEERS = Number(process.env.MAX_PEERS || 5_000);
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS || 15_000);

app.use(express.json({ limit: '16kb' }));

const peers = new Map();

function isValidPeerId(peerId) {
  return typeof peerId === 'string' && peerId.length >= 6 && peerId.length <= 128;
}

function normalizePeerUrl(url) {
  if (typeof url !== 'string') return null;

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function pruneExpiredPeers() {
  const cutoff = Date.now() - PEER_TTL_MS;
  let removed = 0;

  for (const [peerId, peer] of peers.entries()) {
    if (peer.lastSeen < cutoff) {
      peers.delete(peerId);
      removed += 1;
    }
  }

  return removed;
}

function getActivePeers(excludePeerId) {
  const cutoff = Date.now() - PEER_TTL_MS;

  return Array.from(peers.values())
    .filter((peer) => peer.lastSeen >= cutoff && peer.peerId !== excludePeerId)
    .map((peer) => ({
      peerId: peer.peerId,
      url: peer.url,
      lastSeen: peer.lastSeen,
      metadata: peer.metadata,
    }));
}

app.get('/health', (_req, res) => {
  pruneExpiredPeers();

  res.json({
    ok: true,
    peerCount: peers.size,
    ttlMs: PEER_TTL_MS,
    maxPeers: MAX_PEERS,
  });
});

app.post('/register', (req, res) => {
  pruneExpiredPeers();

  const { peerId, url, metadata = {} } = req.body || {};
  const normalizedUrl = normalizePeerUrl(url);

  if (peers.size >= MAX_PEERS && !peers.has(peerId)) {
    return res.status(503).json({ error: 'bootstrap peer registry is full' });
  }

  if (!isValidPeerId(peerId) || !normalizedUrl) {
    return res.status(400).json({
      error: 'valid peerId and url are required',
      example: {
        peerId: 'peer-abc123',
        url: 'http://203.0.113.10:5000',
      },
    });
  }

  peers.set(peerId, {
    peerId,
    url: normalizedUrl,
    lastSeen: Date.now(),
    metadata: typeof metadata === 'object' && metadata !== null ? metadata : {},
  });

  res.json({
    ok: true,
    peer: peers.get(peerId),
    peers: getActivePeers(peerId),
  });
});

app.get('/peers', (req, res) => {
  pruneExpiredPeers();

  const excludePeerId = typeof req.query.exclude === 'string' ? req.query.exclude : undefined;
  res.json({ peers: getActivePeers(excludePeerId) });
});

app.delete('/peers/:peerId', (req, res) => {
  const deleted = peers.delete(req.params.peerId);
  res.json({ ok: true, deleted });
});

setInterval(() => {
  const removed = pruneExpiredPeers();
  if (removed > 0) {
    console.log(`Cleaned ${removed} expired peer(s)`);
  }
}, CLEANUP_INTERVAL_MS).unref();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bootstrap server running on http://0.0.0.0:${PORT}`);
  console.log(`Peer TTL: ${PEER_TTL_MS}ms | Max peers: ${MAX_PEERS}`);
});
