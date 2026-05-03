export type NetworkStats = {
  nodeId?: string;
  peerId?: string;
  publicUrl?: string;
  peers?: number;
  connectedPeers?: number;
  totalFiles?: number;
  totalChunks?: number;
  underReplicatedFiles?: number;
  underReplicatedChunks?: number;
  totalBytes?: number;
  queuedProofs?: number;
};

export type NetworkPeer = {
  peerId: string;
  url?: string;
  status?: string;
  lastSeen?: string | number;
  successCount?: number;
  failureCount?: number;
  latencyMs?: number;
};

export type NetworkFile = {
  hash: string;
  rootHash?: string;
  name: string;
  size: number;
  storageMode?: string;
  chunks?: Array<{ index: number; hash: string; size?: number; replicas?: string[] }>;
};

function electronInvoke(channel: string, ...args: any[]) {
  const bridge = window.electron?.ipcRenderer || window.electron;
  if (!bridge?.invoke) {
    throw new Error('Electron P2P engine is not available. Run pnpm electron:dev.');
  }
  return bridge.invoke(channel, ...args);
}

export async function loadNetworkDashboard() {
  const [stats, status, files] = await Promise.all([
    electronInvoke('p2p:stats'),
    electronInvoke('p2p:status'),
    electronInvoke('p2p:listFiles'),
  ]);

  return {
    stats: {
      ...stats,
      peerId: status.peerId,
      nodeId: status.peerId,
      peers: status.peers?.length || 0,
      connectedPeers: stats.connectedPeers ?? status.peers?.length ?? 0,
    },
    peers: status.peers || [],
    files: files || [],
  };
}

export async function runNetworkRepair() {
  try {
    return await electronInvoke('p2p:repair');
  } catch {
    return electronInvoke('p2p:stats');
  }
}
