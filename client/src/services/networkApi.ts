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

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} failed`);
  return response.json();
}

export async function loadNetworkDashboard() {
  const [stats, peers, files] = await Promise.all([
    getJson<NetworkStats>("/api/stats"),
    getJson<NetworkPeer[]>("/api/peers"),
    getJson<NetworkFile[]>("/api/files"),
  ]);

  return { stats, peers, files };
}

export async function runNetworkRepair() {
  const response = await fetch("/api/repair", { method: "POST" });
  if (!response.ok) throw new Error("repair failed");
  return response.json();
}
