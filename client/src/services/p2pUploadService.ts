import { chunkingService } from './chunkingService';
import { placementService } from './placementService';
import { chunkCryptoService } from './chunkCryptoService';
import { paymentService } from './paymentService';
import { FileManifest } from '@shared/p2p-types';

const ipc = (window as any).electron?.ipcRenderer;

async function sha256(buffer: ArrayBuffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export class P2PUploadService {
  async uploadFile(file: File, encryptionKey?: string) {
    if (!ipc) {
      throw new Error('Electron IPC not available');
    }

    const payment = await paymentService.payForUpload(file.size);
    if (!payment?.txHash) {
      throw new Error('PAYMENT_REQUIRED');
    }

    const nodeStatus = await ipc.invoke('p2p:status');
    const peers = nodeStatus.knownNodes || [];

    const chunks = await chunkingService.splitFile(file);
    const chunkIds = chunks.map((c) => c.id);
    const placements = placementService.planPlacement(chunkIds, peers, 2);

    const manifest: FileManifest = {
      fileId: crypto.randomUUID(),
      ownerWalletAddress: null,
      originalName: file.name,
      mimeType: file.type,
      size: file.size,
      encrypted: !!encryptionKey,
      createdAt: Date.now(),
      chunkSize: 1024 * 1024,
      replicationFactor: 2,
      chunks: [],
    };

    for (const chunk of chunks) {
      const placement = placements.find((p) => p.chunkId === chunk.id);
      const checksum = await sha256(chunk.buffer);

      let payloadData: string;
      if (encryptionKey) {
        payloadData = chunkCryptoService.encryptBuffer(chunk.buffer, encryptionKey);
      } else {
        payloadData = btoa(String.fromCharCode(...new Uint8Array(chunk.buffer)));
      }

      const record = {
        chunkId: chunk.id,
        fileId: manifest.fileId,
        index: chunk.index,
        size: chunk.buffer.byteLength,
        checksum,
        encrypted: !!encryptionKey,
        storagePeerIds: placement?.targetPeerIds || [],
      };

      await Promise.all(
        record.storagePeerIds.map((peerId) =>
          ipc.invoke('p2p:chunk-store', peerId, {
            ...record,
            base64: payloadData,
          })
        )
      );

      manifest.chunks.push(record);
    }

    await ipc.invoke('p2p:manifest-save', manifest);
    await ipc.invoke('p2p:announce', {
      hash: manifest.fileId,
      name: manifest.originalName,
      size: manifest.size,
      uploadedAt: manifest.createdAt,
      isEncrypted: manifest.encrypted,
    });

    const nodeShare = payment.intent.amountUsd * 0.7;
    const totalChunks = Math.max(manifest.chunks.length, 1);

    for (const chunk of manifest.chunks) {
      const rewardPerChunk = nodeShare / totalChunks;
      for (const peerId of chunk.storagePeerIds) {
        await ipc.invoke('earnings:add', {
          peerId,
          amount: rewardPerChunk,
        });
      }
    }

    return { manifest, payment };
  }

  async downloadFile(fileId: string, encryptionKey?: string): Promise<File> {
    if (!ipc) {
      throw new Error('Electron IPC not available');
    }

    const manifest: FileManifest = await ipc.invoke('p2p:manifest-read', fileId);
    const buffers: ArrayBuffer[] = [];

    for (const chunk of manifest.chunks.sort((a, b) => a.index - b.index)) {
      let found = false;

      for (const peerId of chunk.storagePeerIds) {
        const res = await ipc.invoke('p2p:chunk-request', peerId, chunk.chunkId);
        if (res?.base64) {
          if (res.checksum && res.checksum !== chunk.checksum) {
            continue;
          }

          let buffer: ArrayBuffer;
          if (chunk.encrypted) {
            if (!encryptionKey) {
              throw new Error('Missing encryption key for encrypted file');
            }
            buffer = chunkCryptoService.decryptToBuffer(res.base64, encryptionKey);
          } else {
            const binary = atob(res.base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            buffer = bytes.buffer;
          }

          const actualChecksum = await sha256(buffer);
          if (actualChecksum !== chunk.checksum) {
            continue;
          }

          buffers.push(buffer);
          found = true;
          break;
        }
      }

      if (!found) {
        throw new Error(`Missing or corrupted chunk ${chunk.chunkId}`);
      }
    }

    const merged = this.mergeBuffers(buffers);
    return new File([merged], manifest.originalName, {
      type: manifest.mimeType,
    });
  }

  private mergeBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
    const total = buffers.reduce((sum, b) => sum + b.byteLength, 0);
    const result = new Uint8Array(total);
    let offset = 0;

    for (const buf of buffers) {
      result.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }

    return result.buffer;
  }
}

export const p2pUploadService = new P2PUploadService();
