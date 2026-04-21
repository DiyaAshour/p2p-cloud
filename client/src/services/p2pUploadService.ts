import { chunkingService } from './chunkingService';
import { placementService } from './placementService';
import { FileManifest } from '@shared/p2p-types';

const ipc = (window as any).electron?.ipcRenderer;

export class P2PUploadService {
  async uploadFile(file: File) {
    if (!ipc) {
      throw new Error('Electron IPC not available');
    }

    const nodeStatus = await ipc.invoke('p2p:status');
    const peers = nodeStatus.knownNodes || [];

    const chunks = await chunkingService.splitFile(file);
    const chunkIds = chunks.map((c) => c.id);

    const placements = placementService.planPlacement(
      chunkIds,
      peers,
      2
    );

    const manifest: FileManifest = {
      fileId: crypto.randomUUID(),
      ownerWalletAddress: null,
      originalName: file.name,
      mimeType: file.type,
      size: file.size,
      encrypted: false,
      createdAt: Date.now(),
      chunkSize: 1024 * 1024,
      replicationFactor: 2,
      chunks: [],
    };

    for (const chunk of chunks) {
      const placement = placements.find((p) => p.chunkId === chunk.id);

      const base64 = btoa(
        String.fromCharCode(...new Uint8Array(chunk.buffer))
      );

      const record = {
        chunkId: chunk.id,
        fileId: manifest.fileId,
        index: chunk.index,
        size: chunk.buffer.byteLength,
        checksum: '',
        encrypted: false,
        storagePeerIds: placement?.targetPeerIds || [],
      };

      for (const peerId of record.storagePeerIds) {
        await ipc.invoke('p2p:chunk-store', peerId, {
          ...record,
          base64,
        });
      }

      manifest.chunks.push(record);
    }

    await ipc.invoke('p2p:manifest-save', manifest);
    await ipc.invoke('p2p:announce', {
      hash: manifest.fileId,
      name: manifest.originalName,
      size: manifest.size,
      uploadedAt: manifest.createdAt,
      isEncrypted: false,
    });

    return manifest;
  }

  async downloadFile(fileId: string): Promise<File> {
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
          const binary = atob(res.base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          buffers.push(bytes.buffer);
          found = true;
          break;
        }
      }

      if (!found) {
        throw new Error(`Missing chunk ${chunk.chunkId}`);
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
