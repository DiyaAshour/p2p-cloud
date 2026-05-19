import { createTokenBucket, spendAll } from './p2p-bandwidth.js';
import { P2P_NETWORK_LIMITS } from './p2p-network-limits.js';
import { P2PTransportNode } from './p2p-transport.js';

function isLargeChunkMessage(message = {}) {
  return message.type === 'chunk:put' || message.type === 'chunk:found';
}

if (!P2PTransportNode.prototype.__chunknetLowMemorySendPatched) {
  P2PTransportNode.prototype.send = function sendLowMemory(socket, message) {
    if (socket?.readyState !== 1) return false;

    if ((socket.bufferedAmount || 0) > P2P_NETWORK_LIMITS.maxBufferedBytesPerPeer) {
      if (socket.remotePeerId) this.notePeerFailure(socket.remotePeerId, 'socket backpressure');
      return false;
    }

    const payload = JSON.stringify(message);
    const bytes = Buffer.byteLength(payload);
    if (bytes > P2P_NETWORK_LIMITS.maxMessageBytes) return false;

    socket.uploadBucket ||= createTokenBucket({
      bytesPerSecond: P2P_NETWORK_LIMITS.peerUploadBytesPerSecond,
      burstBytes: P2P_NETWORK_LIMITS.peerUploadBurstBytes,
    });

    const canSendNow = !socket.sendQueue?.length && spendAll([socket.uploadBucket, this.globalUploadBucket], bytes);
    if (canSendNow) {
      socket.send(payload);
      return true;
    }

    // Critical memory rule:
    // Do not queue multi-MB chunk payload JSON strings in RAM. If the peer is
    // currently throttled/backpressured, fail this replica attempt and let repair
    // retry later. This prevents V8 heap from growing to 4GB during large uploads.
    if (isLargeChunkMessage(message)) {
      if (socket.remotePeerId) this.notePeerFailure(socket.remotePeerId, 'large chunk send skipped due to backpressure');
      return false;
    }

    const queued = this.enqueue(socket, payload, bytes);
    if (!queued && socket.remotePeerId) this.notePeerFailure(socket.remotePeerId, 'send queue overflow');
    return queued;
  };

  Object.defineProperty(P2PTransportNode.prototype, '__chunknetLowMemorySendPatched', {
    value: true,
    enumerable: false,
    configurable: false,
  });

  console.log('[p2p-transport] low-memory send override installed');
}
