import './p2p-disk-first-cache-override.js';
import './p2p-low-memory-send-override.js';
import { P2PTransportNode } from './p2p-transport.js';

if (!P2PTransportNode.prototype.__chunknetGlobalRegistryPatched) {
  const originalStart = P2PTransportNode.prototype.start;

  P2PTransportNode.prototype.start = function patchedStart(...args) {
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
