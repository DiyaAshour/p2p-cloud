import CryptoJS from 'crypto-js';
import { p2pFetch, p2pJson } from '@/lib/p2pApi';

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

class StorageService {
  private storageQuota: StorageQuota = {
    totalGB: 10,
    usedGB: 0,
    availableGB: 10,
    costPerMonth: 10,
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

    const formData = new FormData();
    formData.append('file', fileData, file.name);
    formData.append('isEncrypted', String(isEncrypted));
    formData.append('hash', Math.random().toString(36).substring(7));

    const response = await p2pFetch('/api/upload', {
      method: 'POST',
      body: formData,
    });

    const result = await response.json();
    return {
      id: result.hash,
      name: result.name,
      size: result.size,
      hash: result.hash,
      uploadedAt: new Date(result.uploadedAt).getTime(),
      isEncrypted: result.isEncrypted,
      path: result.path,
      mimeType: result.mimeType || file.type,
    };
  }

  async getFile(metadata: FileMetadata, decryptionKey?: string): Promise<File | null> {
    const response = await p2pFetch(`/api/download/${encodeURIComponent(metadata.hash)}`);
    let blob: Blob = await response.blob();

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
      const data = await p2pJson<any[]>('/api/files');
      return data.map((f: any) => ({
        id: f.hash,
        name: f.name,
        size: f.size,
        hash: f.hash,
        uploadedAt: new Date(f.uploadedAt).getTime(),
        isEncrypted: f.isEncrypted,
        path: f.path,
        mimeType: f.mimeType,
      }));
    } catch {
      return [];
    }
  }

  async deleteFile(fileHash: string): Promise<void> {
    await p2pJson(`/api/files/${encodeURIComponent(fileHash)}`, {
      method: 'DELETE',
    });
  }

  async searchFiles(query: string): Promise<FileMetadata[]> {
    try {
      const data = await p2pJson<any[]>(`/api/files?q=${encodeURIComponent(query)}`);
      return data.map((f: any) => ({
        id: f.hash,
        name: f.name,
        size: f.size,
        hash: f.hash,
        uploadedAt: new Date(f.uploadedAt).getTime(),
        isEncrypted: f.isEncrypted,
        path: f.path,
        mimeType: f.mimeType,
      }));
    } catch {
      return [];
    }
  }

  async getStats(): Promise<VaultStats> {
    try {
      return await p2pJson<VaultStats>('/api/stats');
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
