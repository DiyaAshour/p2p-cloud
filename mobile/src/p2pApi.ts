import { Buffer } from 'buffer';
import Constants from 'expo-constants';
import { MobileChunk, MobileManifest, decryptPrivateBytes, sha256Hex } from './cryptoDrive';

const extra = (Constants.expoConfig?.extra || {}) as Record<string, unknown>;

export const CONFIG = {
  manifestSyncUrl: String(extra.manifestSyncUrl || process.env.EXPO_PUBLIC_MANIFEST_SYNC_URL || 'http://localhost:8790').replace(/\/$/, ''),
  storagePeerUrl: String(extra.storagePeerUrl || process.env.EXPO_PUBLIC_STORAGE_PEER_URL || 'ws://localhost:8787'),
  minDrivePasswordLength: Number(extra.minDrivePasswordLength || 12),
  chunkSizeBytes: Number(extra.chunkSizeBytes || 1024 * 1024),
};

export type StoredManifest = MobileManifest & { syncedAt?: string };

function apiUrl(path: string) {
  return `${CONFIG.manifestSyncUrl}${path}`;
}

async function parseJson(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

export async function listWalletManifests(wallet: string): Promise<StoredManifest[]> {
  const response = await fetch(apiUrl(`/wallet/${wallet}/manifests`));
  const data = await parseJson(response);
  return Array.isArray(data.manifests) ? data.manifests : [];
}

export async function pushWalletManifest(manifest: MobileManifest) {
  const response = await fetch(apiUrl(`/wallet/${manifest.ownerWallet}/manifests`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
  return parseJson(response);
}

export async function deleteWalletManifest(wallet: string, hash: string) {
  const response = await fetch(apiUrl(`/wallet/${wallet}/manifests/${encodeURIComponent(hash)}`), { method: 'DELETE' });
  return parseJson(response);
}

function waitForSocketOpen(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Storage peer connection timed out.')), 15000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Storage peer connection failed.'));
    };
  });
}

function waitForMessage(socket: WebSocket, predicate: (message: any) => boolean, timeoutMs = 15000) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Storage peer response timed out.')), timeoutMs);
    const previous = socket.onmessage;
    socket.onmessage = (event) => {
      previous?.call(socket, event);
      try {
        const message = JSON.parse(String(event.data || '{}'));
        if (predicate(message)) {
          clearTimeout(timer);
          resolve(message);
        }
      } catch {
        // ignore unrelated malformed messages
      }
    };
  });
}

export async function uploadChunksToStoragePeer(chunks: MobileChunk[], onProgress?: (done: number, total: number) => void) {
  const socket = new WebSocket(CONFIG.storagePeerUrl);
  await waitForSocketOpen(socket);
  socket.send(JSON.stringify({ type: 'peer:hello', fromPeerId: `mobile-${Date.now()}` }));

  let done = 0;
  for (const chunk of chunks) {
    socket.send(JSON.stringify({
      id: `${chunk.hash}-${Date.now()}`,
      type: 'chunk:put',
      fromPeerId: `mobile-${chunk.ownerWallet.slice(2, 10)}`,
      createdAt: Date.now(),
      payload: { chunk },
    }));
    await waitForMessage(socket, (message) => {
      if (message.type === 'chunk:error') throw new Error(message.error || 'Storage peer rejected chunk.');
      return message.type === 'chunk:stored-ack' && message.payload?.chunkHash === chunk.hash;
    });
    done += 1;
    onProgress?.(done, chunks.length);
  }
  socket.close();
}

export async function fetchChunkFromStoragePeer(hash: string) {
  const socket = new WebSocket(CONFIG.storagePeerUrl);
  await waitForSocketOpen(socket);
  socket.send(JSON.stringify({ type: 'peer:hello', fromPeerId: `mobile-${Date.now()}` }));
  socket.send(JSON.stringify({
    id: `get-${hash}-${Date.now()}`,
    type: 'chunk:get',
    fromPeerId: `mobile-${Date.now()}`,
    createdAt: Date.now(),
    payload: { chunkHash: hash },
  }));
  const message = await waitForMessage(socket, (msg) => msg.type === 'chunk:found' || msg.type === 'chunk:not-found' || msg.type === 'chunk:error');
  socket.close();
  if (message.type === 'chunk:error') throw new Error(message.error || 'Storage peer failed to read chunk.');
  if (message.type === 'chunk:not-found') throw new Error(`Chunk not found: ${hash}`);
  const chunk = message.payload?.chunk;
  if (!chunk?.data) throw new Error('Storage peer returned an invalid chunk.');
  const buffer = Buffer.from(chunk.data, 'base64');
  if (sha256Hex(buffer) !== hash) throw new Error(`Chunk integrity failed: ${hash}`);
  return buffer;
}

export async function downloadAndDecryptManifest(manifest: StoredManifest, drivePassword: string, onProgress?: (done: number, total: number) => void) {
  const sorted = [...(manifest.chunks || [])].sort((a, b) => a.index - b.index);
  const buffers: Buffer[] = [];
  let done = 0;
  for (const chunk of sorted) {
    buffers.push(await fetchChunkFromStoragePeer(chunk.hash));
    done += 1;
    onProgress?.(done, sorted.length);
  }
  const ciphertext = Buffer.concat(buffers);
  if (sha256Hex(ciphertext) !== manifest.hash) throw new Error('File integrity failed.');
  return decryptPrivateBytes(ciphertext, manifest.encryption, manifest.ownerWallet, drivePassword);
}
