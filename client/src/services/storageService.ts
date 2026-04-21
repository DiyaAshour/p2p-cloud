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

class StorageService {
  private baseUrl = 'http://127.0.0.1:3000/api';
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

    const response = await fetch(`${this.baseUrl}/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.statusText}`);
    }

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
    const response = await fetch(`${this.baseUrl}/download/${metadata.hash}`);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.statusText}`);
    }

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
    const response = await fetch(`${this.baseUrl}/files`);
    if (!response.ok) return [];
    const data = await response.json();
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
  }

  async deleteFile(fileHash: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/files/${fileHash}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error('Failed to delete file');
    }
  }

  async searchFiles(query: string): Promise<FileMetadata[]> {
    const response = await fetch(`${this.baseUrl}/files?q=${encodeURIComponent(query)}`);
    if (!response.ok) return [];
    const data = await response.json();
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
  }

  async getStats(): Promise<VaultStats> {
    const response = await fetch(`${this.baseUrl}/stats`);
    if (!response.ok) {
      return {
        totalFiles: 0,
        encryptedFiles: 0,
        publicFiles: 0,
        totalBytes: 0,
        totalMB: 0,
      };
    }

    return response.json();
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
