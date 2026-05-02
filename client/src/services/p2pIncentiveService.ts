import type { ChunkRecord, FileManifest } from './p2pChunkService';

export interface NodeReward {
  peerId: string;
  storedChunks: number;
  servedChunks: number;
  uptimeScore: number;
  rewardPoints: number;
}

class P2PIncentiveService {
  private rewards = new Map<string, NodeReward>();

  recordStorage(peerId: string, chunks: ChunkRecord[]): void {
    const entry = this.getOrCreate(peerId);
    entry.storedChunks += chunks.length;
    this.update(entry);
  }

  recordServe(peerId: string, count = 1): void {
    const entry = this.getOrCreate(peerId);
    entry.servedChunks += count;
    this.update(entry);
  }

  updateUptime(peerId: string, uptimeScore: number): void {
    const entry = this.getOrCreate(peerId);
    entry.uptimeScore = uptimeScore;
    this.update(entry);
  }

  calculateRewards(): NodeReward[] {
    for (const entry of this.rewards.values()) {
      entry.rewardPoints = entry.storedChunks * 1 + entry.servedChunks * 2 + entry.uptimeScore * 5;
    }
    return Array.from(this.rewards.values()).sort((a, b) => b.rewardPoints - a.rewardPoints);
  }

  private getOrCreate(peerId: string): NodeReward {
    if (!this.rewards.has(peerId)) {
      this.rewards.set(peerId, {
        peerId,
        storedChunks: 0,
        servedChunks: 0,
        uptimeScore: 1,
        rewardPoints: 0,
      });
    }
    return this.rewards.get(peerId)!;
  }

  private update(entry: NodeReward): void {
    this.rewards.set(entry.peerId, entry);
  }
}

export const p2pIncentiveService = new P2PIncentiveService();
