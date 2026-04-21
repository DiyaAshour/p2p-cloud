export type StorageNodeAdvertisement = {
  peerId: string;
  walletAddress: string | null;
  totalSharedBytes: number;
  availableSharedBytes: number;
  acceptsNewChunks: boolean;
  lastSeenAt: number;
};

export type ChunkRecord = {
  chunkId: string;
  fileId: string;
  index: number;
  size: number;
  checksum: string;
  encrypted: boolean;
  storagePeerIds: string[];
};

export type FileManifest = {
  fileId: string;
  ownerWalletAddress: string | null;
  originalName: string;
  mimeType: string;
  size: number;
  encrypted: boolean;
  createdAt: number;
  chunkSize: number;
  replicationFactor: number;
  chunks: ChunkRecord[];
};

export type UploadPaymentIntent = {
  fileId: string;
  walletAddress: string;
  requiredAmountUsd: number;
  recipientAddress: string;
  status: 'pending' | 'paid' | 'failed';
  transactionHash?: string;
};

export type LocalNodeConfig = {
  walletAddress: string | null;
  totalSharedBytes: number;
  acceptsNetworkStorage: boolean;
  archiveOwnFilesLocally: boolean;
  defaultReplicationFactor: number;
};

export type PlannedChunkPlacement = {
  chunkId: string;
  targetPeerIds: string[];
};
