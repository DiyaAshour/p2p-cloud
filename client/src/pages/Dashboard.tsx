import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { loadNetworkDashboard, runNetworkRepair, type NetworkFile, type NetworkPeer, type NetworkStats } from "@/services/networkApi";
import { toast } from "sonner";

export default function Dashboard() {
  const [stats, setStats] = useState<NetworkStats | null>(null);
  const [peers, setPeers] = useState<NetworkPeer[]>([]);
  const [files, setFiles] = useState<NetworkFile[]>([]);

  async function load() {
    try {
      const data = await loadNetworkDashboard();
      setStats(data.stats);
      setPeers(data.peers);
      setFiles(data.files);
    } catch (error) {
      console.error(error);
      toast.error("Dashboard load failed");
    }
  }

  async function repair() {
    try {
      await runNetworkRepair();
      toast.success("Repair completed");
      await load();
    } catch (error) {
      console.error(error);
      toast.error("Repair failed");
    }
  }

  useEffect(() => {
    load();
    const id = window.setInterval(load, 10000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-white p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">P2P Cloud Dashboard</h1>
            <p className="text-slate-400">Network health and storage telemetry</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={load}>Refresh</Button>
            <Button onClick={repair}>Repair</Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="p-5 bg-slate-900 border-slate-800">
            <p className="text-slate-400 text-sm">Node</p>
            <p className="font-mono text-sm mt-2 break-all">{stats?.nodeId || "unknown"}</p>
          </Card>
          <Card className="p-5 bg-slate-900 border-slate-800">
            <p className="text-slate-400 text-sm">Peers</p>
            <p className="text-3xl font-bold mt-2">{peers.length}</p>
          </Card>
          <Card className="p-5 bg-slate-900 border-slate-800">
            <p className="text-slate-400 text-sm">Files</p>
            <p className="text-3xl font-bold mt-2">{files.length}</p>
          </Card>
          <Card className="p-5 bg-slate-900 border-slate-800">
            <p className="text-slate-400 text-sm">Chunks</p>
            <p className="text-3xl font-bold mt-2">{stats?.totalChunks || 0}</p>
          </Card>
        </div>

        <Card className="p-5 bg-slate-900 border-slate-800">
          <h2 className="text-xl font-bold mb-4">Peers</h2>
          <div className="space-y-2">
            {peers.map((peer) => (
              <div key={peer.peerId} className="p-3 bg-slate-800 rounded">
                <p className="font-mono text-sm">{peer.peerId}</p>
                <p className="text-xs text-slate-400 break-all">{peer.url}</p>
                <p className="text-xs text-slate-500">ok {peer.successCount || 0} / fail {peer.failureCount || 0} / {peer.latencyMs || 0}ms</p>
              </div>
            ))}
            {peers.length === 0 && <p className="text-slate-400">No peers yet.</p>}
          </div>
        </Card>

        <Card className="p-5 bg-slate-900 border-slate-800">
          <h2 className="text-xl font-bold mb-4">Files</h2>
          <div className="space-y-2">
            {files.map((file) => (
              <div key={file.hash} className="p-3 bg-slate-800 rounded">
                <p className="font-medium">{file.name}</p>
                <p className="text-xs text-slate-400">{file.storageMode || "file"} • {file.chunks?.length || 0} chunks</p>
              </div>
            ))}
            {files.length === 0 && <p className="text-slate-400">No files yet.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}
