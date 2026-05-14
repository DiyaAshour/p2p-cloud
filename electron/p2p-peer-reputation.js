import fs from 'node:fs';
import path from 'node:path';

const MAX_REPUTATION_PEERS = Number(process.env.P2P_REPUTATION_MAX_PEERS || 5000);
const REPUTATION_TTL_MS = Number(process.env.P2P_REPUTATION_TTL_MS || 14 * 24 * 60 * 60 * 1000);

function now() {
  return Date.now();
}

function emptyRecord(peerId) {
  return {
    peerId,
    score: 50,
    successes: 0,
    failures: 0,
    lastSeen: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    updatedAt: now(),
  };
}

export class PeerReputationStore {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.records = new Map();
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const items = Array.isArray(parsed?.peers) ? parsed.peers : [];
      const cutoff = now() - REPUTATION_TTL_MS;
      for (const item of items) {
        if (!item?.peerId || Number(item.updatedAt || 0) < cutoff) continue;
        this.records.set(item.peerId, { ...emptyRecord(item.peerId), ...item });
      }
    } catch (error) {
      console.warn('[p2p-reputation] failed to load:', error?.message || error);
    }
  }

  save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const peers = Array.from(this.records.values())
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .slice(0, MAX_REPUTATION_PEERS);
      fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), peers }, null, 2), 'utf8');
    } catch (error) {
      console.warn('[p2p-reputation] failed to save:', error?.message || error);
    }
  }

  get(peerId) {
    if (!peerId) return null;
    this.load();
    return this.records.get(peerId) || null;
  }

  merge(peerId, health = {}) {
    if (!peerId) return health;
    this.load();
    const record = this.records.get(peerId);
    if (!record) return health;
    return {
      ...health,
      successes: Math.max(Number(health.successes || 0), Number(record.successes || 0)),
      failures: Math.max(Number(health.failures || 0), Number(record.failures || 0)),
      lastSeen: health.lastSeen || record.lastSeen || null,
      lastSuccessAt: health.lastSuccessAt || record.lastSuccessAt || null,
      lastFailureAt: health.lastFailureAt || record.lastFailureAt || null,
      lastError: health.lastError || record.lastError || null,
    };
  }

  noteSuccess(peerId, health = {}) {
    if (!peerId) return;
    this.load();
    const current = this.records.get(peerId) || emptyRecord(peerId);
    this.records.set(peerId, {
      ...current,
      score: Number(health.score ?? current.score ?? 50),
      successes: Math.max(Number(current.successes || 0), Number(health.successes || 0)),
      failures: Math.max(Number(current.failures || 0), Number(health.failures || 0)),
      lastSeen: health.lastSeen || Date.now(),
      lastSuccessAt: health.lastSuccessAt || Date.now(),
      lastError: null,
      updatedAt: now(),
    });
    this.save();
  }

  noteFailure(peerId, health = {}, error = null) {
    if (!peerId) return;
    this.load();
    const current = this.records.get(peerId) || emptyRecord(peerId);
    this.records.set(peerId, {
      ...current,
      score: Number(health.score ?? current.score ?? 50),
      successes: Math.max(Number(current.successes || 0), Number(health.successes || 0)),
      failures: Math.max(Number(current.failures || 0), Number(health.failures || 0)),
      lastSeen: health.lastSeen || current.lastSeen || null,
      lastFailureAt: health.lastFailureAt || Date.now(),
      lastError: error ? String(error) : health.lastError || current.lastError || null,
      updatedAt: now(),
    });
    this.save();
  }

  summary() {
    this.load();
    return {
      filePath: this.filePath,
      peers: this.records.size,
      maxPeers: MAX_REPUTATION_PEERS,
      ttlMs: REPUTATION_TTL_MS,
    };
  }
}
