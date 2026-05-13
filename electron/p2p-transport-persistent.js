import { P2PTransportNode } from './p2p-transport.js';
import { PeerReputationStore } from './p2p/peer-reputation.js';

export class PersistentP2PTransportNode extends P2PTransportNode {
  constructor(options = {}) {
    super(options);
    this.peerReputation = new PeerReputationStore({ dataDir: this.chunkStoreDir || process.cwd() });
  }

  markPeerOnline(peerId) {
    super.markPeerOnline(peerId);
    this.peerReputation?.markOnline(peerId);
  }

  markPeerOffline(peerId, error = null) {
    super.markPeerOffline(peerId, error);
    this.peerReputation?.markOffline(peerId, error);
  }

  notePeerSuccess(peerId, type = 'generic', latencyMs = null) {
    super.notePeerSuccess(peerId, type, latencyMs);
    this.peerReputation?.noteSuccess(peerId, type, latencyMs);
  }

  notePeerFailure(peerId, error = null) {
    super.notePeerFailure(peerId, error);
    this.peerReputation?.noteFailure(peerId, error);
  }

  getPeerHealth(peerId) {
    const runtimeHealth = super.getPeerHealth(peerId);
    if (!this.peerReputation || !peerId) return runtimeHealth;
    return this.peerReputation.mergedHealth(peerId, runtimeHealth || {});
  }

  isPeerHealthy(peerId, minScore) {
    const runtimeHealth = super.getPeerHealth(peerId);
    if (!this.peerReputation) return super.isPeerHealthy(peerId, minScore);
    return this.peerReputation.isHealthy(peerId, runtimeHealth || {}, minScore);
  }

  peerHealthSummary() {
    const runtimePeers = super.peerHealthSummary();
    if (!this.peerReputation) return runtimePeers;
    const byPeerId = new Map(runtimePeers.map((peer) => [peer.peerId, peer]));
    return this.peerReputation.summary(runtimePeers).map((health) => ({
      ...(byPeerId.get(health.peerId) || { peerId: health.peerId }),
      health,
    }));
  }

  notePeerAuditPass(peerId) {
    this.peerReputation?.noteAuditPass(peerId);
  }

  notePeerAuditFailure(peerId, error = 'audit failed') {
    this.peerReputation?.noteAuditFailure(peerId, error);
  }
}

export function startP2PTransport(options = {}) {
  const node = new PersistentP2PTransportNode(options);
  node.start();
  return node;
}
