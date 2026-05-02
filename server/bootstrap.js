import express from 'express';

const app = express();
app.use(express.json());

// تخزين peers مؤقت (in-memory)
const peers = new Map();

// تسجيل peer
app.post('/register', (req, res) => {
  const { peerId, url } = req.body;

  if (!peerId || !url) {
    return res.status(400).json({ error: 'peerId and url required' });
  }

  peers.set(peerId, {
    peerId,
    url,
    lastSeen: Date.now()
  });

  console.log(`Peer registered: ${peerId} → ${url}`);

  res.json({ ok: true });
});

// جلب peers
app.get('/peers', (_req, res) => {
  const now = Date.now();

  // فلترة peers النشطين (آخر دقيقة)
  const activePeers = Array.from(peers.values()).filter(
    (peer) => now - peer.lastSeen < 60_000
  );

  res.json(activePeers);
});

// تشغيل السيرفر
const PORT = 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Bootstrap server running on http://0.0.0.0:${PORT}`);
});
