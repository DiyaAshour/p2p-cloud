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

class StorageService {
  private baseUrl = 'http://127.0.0.1:3000/api';
  private storageQuota: StorageQuota = {
    totalGB: 10,
    usedGB: 0,
    availableGB: 10,
    costPerMonth: 10,
  };

  /**
   * Upload a file to the local P2P node with optional encryption
   */
  async addFile(
    file: File,
    _indexed: boolean = false,
    _peerId: string = '',
    encryptionKey?: string
  ): Promise<FileMetadata> {
    console.log(`📤 Starting upload for: ${file.name}`);

    let fileData: any = await this.readFileAsArrayBuffer(file);
    const isEncrypted = !!encryptionKey;

    if (isEncrypted && encryptionKey) {
      console.log('🔐 Encrypting file before upload...');
      const wordUint8Array = new Uint8Array(fileData);
      const wordBuffer = CryptoJS.lib.WordArray.create(wordUint8Array as any);
      const encrypted = CryptoJS.AES.encrypt(wordBuffer, encryptionKey).toString();
      fileData = new Blob([encrypted], { type: 'text/plain' });
    } else {
      fileData = new Blob([fileData], { type: file.type });
    }

    const formData = new FormData();
    formData.append('file', fileData, file.name);
    formData.append('isEncrypted', isEncrypted.toString());
    formData.append('hash', Math.random().toString(36).substring(7));

    const response = await fetch(`${this.baseUrl}/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.statusText}`);
    }

    const result = await response.json();
    const metadata: FileMetadata = {
      id: result.hash,
      name: result.name,
      size: result.size,
      hash: result.hash,
      uploadedAt: new Date(result.uploadedAt).getTime(),
      isEncrypted: result.isEncrypted,
      path: result.path,
      mimeType: file.type
    };

    console.log('✅ Upload successful:', metadata);
    return metadata;
  }

  /**
   * Download and decrypt a file from the local P2P node
   */
  async getFile(fileHash: string, decryptionKey?: string): Promise<File | null> {
    console.log(`📥 Downloading file with hash: ${fileHash}`);

    const files = await this.listFiles();
    const metadata = files.find(f => f.hash === fileHash);
    
    if (!metadata) {
      console.error('File metadata not found');
      return null;
    }

    const response = await fetch(`${this.baseUrl}/download/${metadata.path || metadata.name}`);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.statusText}`);
    }

    let data: any = await response.blob();

    if (metadata.isEncrypted && decryptionKey) {
      console.log('🔓 Decrypting file...');
      const encryptedText = await data.text();
      try {
        const decrypted = CryptoJS.AES.decrypt(encryptedText, decryptionKey);
        const typedArray = this.wordArrayToUint8Array(decrypted);
        data = new Blob([typedArray]);
      } catch (e) {
        console.error('❌ Decryption failed. Check your key.');
        throw new Error('Decryption failed. Invalid key?');
      }
    }

    return new File([data], metadata.name, { type: metadata.mimeType || 'application/octet-stream' });
  }

  /**
   * Get all files from the local P2P node
   */
  async listFiles(): Promise<FileMetadata[]> {
    try {
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
        path: f.path
      }));
    } catch (e) {
      console.error('Failed to list files:', e);
      return [];
    }
  }

  /**
   * Search for files (local implementation)
   */
  async searchFiles(query: string): Promise<FileMetadata[]> {
    const files = await this.listFiles();
    const lowerQuery = query.toLowerCase();
    return files.filter(f => 
      f.name.toLowerCase().includes(lowerQuery) || 
      f.hash.includes(query)
    );
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
    const l = wordArray.sigBytes;
    const words = wordArray.words;
    const result = new Uint8Array(l);
    for (let i = 0; i < l; i++) {
      result[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
    }
    return result;
  }
}

export const storageService = new StorageService();
