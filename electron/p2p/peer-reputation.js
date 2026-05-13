import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MIN_SCORE = Number(process.env.P2P_MIN_REPLICA_HEALTH_SCORE || 35);
const DEFAULT_STORE_NAME = 'peer-reputation.json';

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function safePeerId(peerId) {
  return String(peerId || '').trim();
}

function emptyRecord(peerId) {
  const now = nowIso();
  return {
    peerId,
    score: 50,
    state: 'new',
    successes: 0,
    failures: 0,
    storedChunks: 0,
    fetchedChunks: 0,
    auditsPassed: 0,
    auditsFailed: 0,
    lastSeen: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastLatencyMs: null,
    lastError: null,
    blockedUntil: null,
    createdAt: now,
    updatedAt: now,
  };
}

export class PeerReputationStore {
  constructor({ dataDir, fileName = DEFAULT_STORE_NAME } = {}) {
    this.dataDir = dataDir || process.cwd();
    this.filePath = path.join(this.dataDir, fileName);
    this.records = new Map();
    this.load();
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const rows = Array.isArray(parsed?.peers) ? parsed.peers : [];
      this.records = new Map(rows.filter((row) => row?.peerId).map((row) => [row.peerId, { ...emptyRecord(row.peerId), ...row }]));
    } catch (error) {
      console.warn('[peer-reputation] failed to load store:', error?.message || error);
      this.records = new Map();
    }
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    const payload = { version: 1, updatedAt: nowIso(), peers: Array.from(this.records.values()) };
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  ensure(peerId) {
    const id = safePeerId(peerId);
    if (!id) return null;
    const current = this.records.get(id) || emptyRecord(id);
    this.records.set(id, current);
    return current;
  }

  get(peerId) {
    const id = safePeerId(peerId);
    if (!id) return null;
    return this.records.get(id) || null;
  }

  update(peerId, updater) {
    const current = this.ensure(peerId);
    if (!current) return null;
    const next = { ...current, ...updater(current), updatedAt: nowIso() };
    next.score = clamp(next.score);
    this.records.set(next.peerId, next);
    this.save();
    return next;
  }

  markOnline(peerId) {
    return this.update(peerId, (current) => ({
      state: 'healthy',
      lastSeen: nowMs(),
      lastError: null,
      score: clamp(Number(current.score || 50) + 0.2),
    }));
  }

  markOffline(peerId, error = null) {
    return this.update(peerId, (current) => ({
      state: error ? 'suspect' : 'offline',
      lastSeen: current.lastSeen || nowMs(),
      lastFailureAt: error ? nowMs() : current.lastFailureAt,
      failures: error ? Number(current.failures || 0) + 1 : Number(current.failures || 0),
      lastError: error ? String(error) : current.lastError,
      score: error ? clamp(Number(current.score || 50) - 4) : clamp(Number(current.score || 50) - 1),
    }));
  }

  noteSuccess(peerId, type = 'generic', latencyMs = null) {
    return this.update(peerId, (current) => {
      const previousLatency = Number(current.lastLatencyMs || 0);
      const nextLatency = latencyMs == null ? previousLatency || null : previousLatency ? Math.round(previousLatency * 0.8 + Number(latencyMs) * 0.2) : Number(latencyMs);
      const bonus = type === 'store' || type === 'fetch' ? 1.2 : 0.5;
      return {
        state: 'healthy',
        successes: Number(current.successes || 0) + 1,
        storedChunks: type === 'store' ? Number(current.storedChunks || 0) + 1 : Number(current.storedChunks || 0),
        fetchedChunks: type === 'fetch' ? Number(current.fetchedChunks || 0) + 1 : Number(current.fetchedChunks || 0),
        lastSeen: nowMs(),
        lastSuccessAt: nowMs(),
        lastLatencyMs: nextLatency,
        lastError: null,
        score: clamp(Number(current.score || 50) + bonus),
      };
    });
  }

  noteFailure(peerId, error = null) {
    return this.update(peerId, (current) => {
      const failures = Number(current.failures || 0) + 1;
      return {
        state: failures >= 3 ? 'suspect' : current.state,
        failures,
        lastFailureAt: nowMs(),
        lastError: error ? String(error) : current.lastError,
        score: clamp(Number(current.score || 50) - 6),
      };
    });
  }

  noteAuditPass(peerId) {
    return this.update(peerId, (current) => ({
      auditsPassed: Number(current.auditsPassed || 0) + 1,
      lastSeen: nowMs(),
      score: clamp(Number(current.score || 50) + 2),
    }));
  }

  noteAuditFailure(peerId, error = 'audit failed') {
    return this.update(peerId, (current) => ({
      auditsFailed: Number(current.auditsFailed || 0) + 1,
      failures: Number(current.failures || 0) + 1,
      lastFailureAt: nowMs(),
      lastError: String(error),
      state: 'suspect',
      score: clamp(Number(current.score || 50) - 15),
    }));
  }

  mergedHealth(peerId, runtimeHealth = {}) {
    const persisted = this.get(peerId) || null;
    const base = persisted ? { ...persisted } : emptyRecord(peerId);
    const runtimeScore = runtimeHealth?.score;
    const score = runtimeScore == null ? base.score : Math.round((Number(base.score || 50) * 0.65) + (Number(runtimeScore || 50) * 0.35));
    return { ...base, ...runtimeHealth, score: clamp(score), persisted: base };
  }

  isHealthy(peerId, runtimeHealth = {}, minScore = DEFAULT_MIN_SCORE) {
    const merged = this.mergedHealth(peerId, runtimeHealth);
    if (!merged) return false;
    if (merged.blockedUntil && new Date(merged.blockedUntil).getTime() > Date.now()) return false;
    return merged.state !== 'dead' && merged.score >= minScore;
  }

  summary(runtimePeers = []) {
    const ids = new Set([...this.records.keys(), ...runtimePeers.map((peer) => peer.peerId).filter(Boolean)]);
    return Array.from(ids).map((peerId) => {
      const runtime = runtimePeers.find((peer) => peer.peerId === peerId)?.health || {};
      return this.mergedHealth(peerId, runtime);
    }).sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  }
}
