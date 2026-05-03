import { p2pJson } from '@/lib/p2pApi';

export type NetworkStats = {
  nodeId?: string;
  publicUrl?: string;
  peers?: number;
  totalFiles?: number;
  totalChunks?: number;
  underReplicatedFiles?: number;
  totalBytes?: number;
};

export type NetworkPeer = {
  peerId: string;
  url: string;
  lastSeen?: string;
  successCount?: number;
  failureCount?: number;
  latencyMs?: number;
};

export type NetworkFile = {
  hash: string;
  name: string;
  size: number;
  storageMode?: string;
  chunks?: Array<{ index: number; hash: string; size: number; replicas: string[] }>;
};

export async function loadNetworkDashboard() {
  const [stats, peers, files] = await Promise.all([
    p2pJson<NetworkStats>('/api/stats'),
    p2pJson<NetworkPeer[]>('/api/peers'),
    p2pJson<NetworkFile[]>('/api/files'),
  ]);

  return { stats, peers, files };
}

export async function runNetworkRepair() {
  return p2pJson('/api/repair', { method: 'POST' });
}
