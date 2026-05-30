import os from 'node:os';
import './p2p-disk-first-cache-override.js';
import './p2p-low-memory-send-override.js';
import { P2PTransportNode } from './p2p-transport.js';

function isVirtualInterfaceName(name = '') {
  const n = String(name).toLowerCase();
  return ['hyper-v', 'vethernet', 'virtual', 'vmware', 'virtualbox', 'docker', 'wsl', 'loopback', 'bluetooth', 'npcap', 'tap', 'tun'].some((bad) => n.includes(bad));
}

function chooseLanAddress() {
  const candidates = [];
  for (const [name, items] of Object.entries(os.networkInterfaces())) {
    if (isVirtualInterfaceName(name)) continue;
    for (const item of items || []) {
      if (!item || item.internal || item.family !== 'IPv4') continue;
      const ip = item.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      const score = ip.startsWith('192.168.') ? 100 : ip.startsWith('10.') ? 80 : /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ? 60 : 10;
      candidates.push({ ip, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.ip || '127.0.0.1';
}

function validWsUrl(value = '') {
  try {
    const parsed = new URL(String(value || '').trim());
    return ['ws:', 'wss:'].includes(parsed.protocol) && Boolean(parsed.hostname) && Boolean(parsed.port || parsed.protocol === 'wss:' || parsed.protocol === 'ws:');
  } catch {
    return false;
  }
}

function repairPublicPeerUrl() {
  const current = process.env.P2P_PUBLIC_URL || process.env.VITE_P2P_PUBLIC_URL || '';
  if (validWsUrl(current)) return;
  const port = process.env.P2P_TRANSPORT_PORT || '8787';
  const fixed = `ws://${chooseLanAddress()}:${port}`;
  process.env.P2P_PUBLIC_URL = fixed;
  delete process.env.VITE_P2P_PUBLIC_URL;
  console.warn('[p2p-transport] repaired invalid public peer URL', { previous: current || null, fixed });
}

repairPublicPeerUrl();

if (!P2PTransportNode.prototype.__chunknetGlobalRegistryPatched) {
  const originalStart = P2PTransportNode.prototype.start;

  P2PTransportNode.prototype.start = function patchedStart(...args) {
    repairPublicPeerUrl();
    if (!this.publicUrl || !validWsUrl(this.publicUrl)) {
      this.publicUrl = process.env.P2P_PUBLIC_URL || `ws://${chooseLanAddress()}:${this.port || 8787}`;
    }
    const result = originalStart.apply(this, args);
    globalThis.__p2pTransportNode = this;
    globalThis.__p2pNode = this;
    console.log('[p2p-transport] exposed global transport node for distributed company objects');
    return result;
  };

  Object.defineProperty(P2PTransportNode.prototype, '__chunknetGlobalRegistryPatched', {
    value: true,
    enumerable: false,
    configurable: false,
  });

  console.log('[p2p-transport] global registry patch installed');
}