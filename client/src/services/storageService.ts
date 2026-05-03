import CryptoJS from 'crypto-js';

export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  hash: string;
  uploadedAt: number;
  isEncrypted: boolean;
  path?: string;
  mimeType?: string;
}

export interface StorageQuota {
  totalGB: number;
  usedGB: number;
  availableGB: number;
  costPerMonth: number;
}

export interface VaultStats {
  totalFiles: number;
  encryptedFiles: number;
  publicFiles: number;
  totalBytes: number;
  totalMB: number;
}

type ElectronFileRecord = {
  id?: string;
  name: string;
  size: number;
  hash: string;
  uploadedAt: string | number;
  isEncrypted: boolean;
  path?: string;
  mimeType?: string;
};

function getElectronBridge() {
  const bridge = window.electron?.ipcRenderer || window.electron;
  if (!bridge?.invoke) {
    throw new Error('Electron P2P node is not available. Run the app with pnpm electron:dev, not in a normal browser tab.');
  }
  return bridge;
}

class StorageService {
  private storageQuota: StorageQuota = {
    totalGB: 5,
    usedGB: 0,
    availableGB: 5,
    costPerMonth: 0,
  };

  async addFile(
    file: File,
    _indexed: boolean = false,
    _peerId: string = '',
    encryptionKey?: string
  ): Promise<FileMetadata> {
    let fileData: Blob;
    const buffer = await this.readFileAsArrayBuffer(file);
    const isEncrypted = !!encryptionKey;

    if (isEncrypted && encryptionKey) {
      const uint8Array = new Uint8Array(buffer);
      const wordArray = CryptoJS.lib.WordArray.create(uint8Array as any);
      const encrypted = CryptoJS.AES.encrypt(wordArray, encryptionKey).toString();
      fileData = new Blob([encrypted], { type: 'text/plain' });
    } else {
      fileData = new Blob([buffer], { type: file.type || 'application/octet-stream' });
    }

    const uploadBuffer = await fileData.arrayBuffer();
    const result = await getElectronBridge().invoke('p2p:upload', {
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      isEncrypted,
      bytes: Array.from(new Uint8Array(uploadBuffer)),
    });

    return this.normalizeFile(result.file || result);
  }

  async getFile(metadata: FileMetadata, decryptionKey?: string): Promise<File | null> {
    const result = await getElectronBridge().invoke('p2p:download', { hash: metadata.hash });
    if (!result?.bytes) return null;

    let blob: Blob = new Blob([new Uint8Array(result.bytes)], {
      type: metadata.isEncrypted ? 'text/plain' : metadata.mimeType || 'application/octet-stream',
    });

    if (metadata.isEncrypted) {
      if (!decryptionKey) {
        throw new Error('Missing decryption key');
      }

      const encryptedText = await blob.text();
      const decrypted = CryptoJS.AES.decrypt(encryptedText, decryptionKey);

      if (!decrypted.sigBytes) {
        throw new Error('Decryption failed. Invalid key?');
      }

      blob = new Blob([this.wordArrayToUint8Array(decrypted)], {
        type: metadata.mimeType || 'application/octet-stream',
      });
    }

    return new File([blob], metadata.name, {
      type: metadata.mimeType || 'application/octet-stream',
    });
  }

  async listFiles(): Promise<FileMetadata[]> {
    try {
      const result = await getElectronBridge().invoke('p2p:listFiles');
      const files = Array.isArray(result) ? result : result?.files || [];
      return files.map((file: ElectronFileRecord) => this.normalizeFile(file));
    } catch {
      return [];
    }
  }

  async deleteFile(fileHash: string): Promise<void> {
    await getElectronBridge().invoke('p2p:delete', { hash: fileHash });
  }

  async searchFiles(query: string): Promise<FileMetadata[]> {
    const files = await this.listFiles();
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return files;
    return files.filter((file) =>
      file.name.toLowerCase().includes(normalizedQuery) || file.hash.toLowerCase().includes(normalizedQuery)
    );
  }

  async getStats(): Promise<VaultStats> {
    try {
      const stats = await getElectronBridge().invoke('p2p:stats');
      return {
        totalFiles: stats.totalFiles || 0,
        encryptedFiles: stats.encryptedFiles || 0,
        publicFiles: stats.publicFiles || 0,
        totalBytes: stats.totalBytes || 0,
        totalMB: stats.totalMB || 0,
      };
    } catch {
      return {
        totalFiles: 0,
        encryptedFiles: 0,
        publicFiles: 0,
        totalBytes: 0,
        totalMB: 0,
      };
    }
  }

  getStorageQuota(): StorageQuota {
    return this.storageQuota;
  }

  private normalizeFile(file: ElectronFileRecord): FileMetadata {
    return {
      id: file.id || file.hash,
      name: file.name,
      size: file.size,
      hash: file.hash,
      uploadedAt: typeof file.uploadedAt === 'number' ? file.uploadedAt : new Date(file.uploadedAt).getTime(),
      isEncrypted: file.isEncrypted,
      path: file.path,
      mimeType: file.mimeType,
    };
  }

  private readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  private wordArrayToUint8Array(wordArray: any): Uint8Array {
    const length = wordArray.sigBytes;
    const words = wordArray.words;
    const result = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      result[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
    }
    return result;
  }
}

export const storageService = new StorageService();
