import fs from 'node:fs';
import crypto from 'node:crypto';
import { P2PTransportNode } from './p2p-transport.js';
import { handleIncomingTombstoneMessage } from './delete-tombstone-sync.js';

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function validChunkHash(value = '') {
  return /^[a-f0-9]{64}$/.test(normalize(value));
}

function safeChunkHash(value = '') {
  const hash = normalize(value);
  if (!validChunkHash(hash)) throw new Error('Invalid chunk hash');
  return hash;
}

function readMessage(raw) {
  try {
    return JSON.parse(raw?.toString?.() || String(raw || ''));
  } catch {
    return null;
  }
}

function deleteLocalChunk(node, chunkHash) {
  const hash = safeChunkHash(chunkHash);

  try { node.localChunks?.delete?.(hash); } catch {}
  try { node.chunkReplicas?.delete?.(hash); } catch {}

  const filePath = typeof node.chunkPath === 'function' ? node.chunkPath(hash) : null;
  if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);

  try { node.refreshStorageSummary?.(); } catch {}
  return hash;
}

function reject(socket, node, message, error) {
  try {
    node.send(socket, {
      id: crypto.randomUUID(),
      type: 'chunk:delete-ack',
      fromPeerId: node.peerId,
      toPeerId: message?.fromPeerId || null,
      createdAt: Date.now(),
      payload: {
        ok: false,
        chunkHash: message?.payload?.chunkHash || null,
        ackTo: message?.id || null,
        error: error?.message || String(error),
      },
    });
  } catch {}
}

async function handleChunkDelete(node, socket, message = {}) {
  const payload = message.payload || {};
  const chunkHash = safeChunkHash(payload.chunkHash || payload.hash || '');
  const requestedOwner = normalize(payload.ownerWallet || payload.owner || '');

  if (!requestedOwner) throw new Error('ownerWallet is required for chunk delete');

  const existing = node.getLocalChunk?.(chunkHash) || null;
  const existingOwner = normalize(existing?.ownerWallet || existing?.owner || '');

  if (existingOwner && existingOwner !== requestedOwner) {
    throw new Error('Refusing to delete chunk owned by a different identity');
  }

  deleteLocalChunk(node, chunkHash);

  node.send(socket, {
    id: crypto.randomUUID(),
    type: 'chunk:delete-ack',
    fromPeerId: node.peerId,
    toPeerId: message.fromPeerId || null,
    createdAt: Date.now(),
    payload: {
      ok: true,
      chunkHash,
      ackTo: message.id || null,
      reason: payload.reason || 'remote-delete',
      storage: node.storageSummary?.() || null,
    },
  });

  try {
    node.broadcastToUi?.({
      type: 'chunk:deleted',
      chunkHash,
      fromPeerId: message.fromPeerId || null,
      ownerWallet: requestedOwner,
    });
  } catch {}

  return true;
}

function handleTombstoneApply(node, socket, message = {}) {
  const result = handleIncomingTombstoneMessage(message);

  try {
    node.send(socket, {
      id: crypto.randomUUID(),
      type: 'tombstone:applied',
      fromPeerId: node.peerId,
      toPeerId: message.fromPeerId || null,
      createdAt: Date.now(),
      payload: {
        ok: result?.ok !== false,
        ackTo: message.id || null,
        result,
      },
    });
  } catch {}

  return true;
}

if (!P2PTransportNode.prototype.__chunknetDeleteMessagePatched) {
  const originalHandleSocketMessage = P2PTransportNode.prototype.handleSocketMessage;

  P2PTransportNode.prototype.handleSocketMessage = function patchedHandleSocketMessage(socket, raw) {
    const message = readMessage(raw);

    if (message?.type === 'chunk:delete') {
      void handleChunkDelete(this, socket, message).catch((error) => {
        console.warn('[p2p-delete-message] chunk delete rejected:', error?.message || error);
        reject(socket, this, message, error);
      });
      return;
    }

    if (message?.type === 'tombstone:apply') {
      try {
        handleTombstoneApply(this, socket, message);
      } catch (error) {
        console.warn('[p2p-delete-message] tombstone apply failed:', error?.message || error);
        reject(socket, this, message, error);
      }
      return;
    }

    return originalHandleSocketMessage.call(this, socket, raw);
  };

  Object.defineProperty(P2PTransportNode.prototype, '__chunknetDeleteMessagePatched', {
    value: true,
    enumerable: false,
    configurable: false,
  });

  console.log('[p2p-delete-message] installed chunk:delete and tombstone:apply transport handlers');
}
