import type { ChunkRecord, FileManifest } from './p2pChunkService';
import { p2pNetworkService, type NetworkPeer } from './p2pNetworkService';

export interface ReplicationPolicy {
  targetReplicas: number;
  minHealthyReplicas: number;
  preferNewestPeers: boolean;
}

export interface ReplicationPlanItem {
  chunkHash: string;
  currentPeers: string[];
  targetPeers: string[];
  missingReplicas: number;
}

export interface RepairReport {
  manifestHash: string;
  repairedChunks: number;
  stillUnderReplicated: string[];
}

const DEFAULT_POLICY: ReplicationPolicy = {
  targetReplicas: 3,
  minHealthyReplicas: 2,
  preferNewestPeers: true,
};

class P2PReplicationService {
  private policy: ReplicationPolicy = DEFAULT_POLICY;

  setPolicy(policy: Partial<ReplicationPolicy>): void {
    this.policy = { ...this.policy, ...policy };
  }

  getPolicy(): ReplicationPolicy {
    return this.policy;
  }

  createPlan(manifest: FileManifest, chunks: ChunkRecord[]): ReplicationPlanItem[] {
    const peers = this.rankPeers(p2pNetworkService.getConnectedPeers());

    return chunks.map((chunk) => {
      const currentPeers = Array.from(new Set(chunk.peers));
      const targetPeers = peers
        .filter((peer) => !currentPeers.includes(peer.peerId))
        .slice(0, Math.max(0, this.policy.targetReplicas - currentPeers.length))
        .map((peer) => peer.peerId);

      return {
        chunkHash: chunk.hash,
        currentPeers,
        targetPeers,
        missingReplicas: Math.max(0, this.policy.targetReplicas - currentPeers.length),
      };
    });
  }

  async replicateManifest(manifest: FileManifest, chunks: ChunkRecord[]): Promise<ReplicationPlanItem[]> {
    const plan = this.createPlan(manifest, chunks);

    for (const item of plan) {
      const chunk = chunks.find((candidate) => candidate.hash === item.chunkHash);
      if (!chunk) continue;

      for (const peerId of item.targetPeers) {
        await p2pNetworkService.sendChunk(peerId, manifest.fileHash, chunk);
        if (!chunk.peers.includes(peerId)) {
          chunk.peers.push(peerId);
        }
      }
    }

    await p2pNetworkService.broadcastManifest({
      ...manifest,
      chunks: chunks.map(({ index, hash, size, peers }) => ({ index, hash, size, peers })),
    });

    return plan;
  }

  async repairManifest(manifest: FileManifest, chunks: ChunkRecord[]): Promise<RepairReport> {
    const connectedPeerIds = new Set(p2pNetworkService.getConnectedPeers().map((peer) => peer.peerId));
    let repairedChunks = 0;
    const stillUnderReplicated: string[] = [];

    for (const chunk of chunks) {
      chunk.peers = chunk.peers.filter((peerId) => peerId === manifest.ownerPeerId || connectedPeerIds.has(peerId));

      const missing = this.policy.targetReplicas - chunk.peers.length;
      if (missing <= 0) continue;

      const candidates = this.rankPeers(p2pNetworkService.getConnectedPeers())
        .filter((peer) => !chunk.peers.includes(peer.peerId))
        .slice(0, missing);

      for (const peer of candidates) {
        await p2pNetworkService.sendChunk(peer.peerId, manifest.fileHash, chunk);
        chunk.peers.push(peer.peerId);
        repairedChunks += 1;
      }

      if (chunk.peers.length < this.policy.minHealthyReplicas) {
        stillUnderReplicated.push(chunk.hash);
      }
    }

    await p2pNetworkService.broadcastManifest({
      ...manifest,
      chunks: chunks.map(({ index, hash, size, peers }) => ({ index, hash, size, peers })),
    });

    return {
      manifestHash: manifest.fileHash,
      repairedChunks,
      stillUnderReplicated,
    };
  }

  getHealth(manifest: FileManifest): { healthy: boolean; totalChunks: number; underReplicated: number; averageReplicas: number } {
    const replicaCounts = manifest.chunks.map((chunk) => chunk.peers.length);
    const underReplicated = replicaCounts.filter((count) => count < this.policy.minHealthyReplicas).length;
    const averageReplicas = replicaCounts.length
      ? replicaCounts.reduce((sum, count) => sum + count, 0) / replicaCounts.length
      : 0;

    return {
      healthy: underReplicated === 0,
      totalChunks: manifest.chunks.length,
      underReplicated,
      averageReplicas,
    };
  }

  private rankPeers(peers: NetworkPeer[]): NetworkPeer[] {
    return [...peers]
      .filter((peer) => peer.status === 'connected' && peer.capabilities.includes('chunk-store'))
      .sort((a, b) => {
        if (this.policy.preferNewestPeers) {
          return b.lastSeen - a.lastSeen;
        }
        return (a.latencyMs || 0) - (b.latencyMs || 0);
      });
  }
}

export const p2pReplicationService = new P2PReplicationService();
