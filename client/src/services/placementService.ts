import { PlannedChunkPlacement, StorageNodeAdvertisement } from '@shared/p2p-types';

export class PlacementService {
  planPlacement(
    chunkIds: string[],
    peers: StorageNodeAdvertisement[],
    replicationFactor: number
  ): PlannedChunkPlacement[] {
    const eligiblePeers = peers
      .filter((p) => p.acceptsNewChunks && p.availableSharedBytes > 0)
      .sort((a, b) => b.availableSharedBytes - a.availableSharedBytes);

    if (eligiblePeers.length === 0) {
      throw new Error('No peers available for storage');
    }

    return chunkIds.map((chunkId) => {
      const selected = eligiblePeers.slice(0, replicationFactor);
      return {
        chunkId,
        targetPeerIds: selected.map((p) => p.peerId),
      };
    });
  }
}

export const placementService = new PlacementService();
