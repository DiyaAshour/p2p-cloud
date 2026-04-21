import CryptoJS from 'crypto-js';

export class ChunkCryptoService {
  encryptBuffer(buffer: ArrayBuffer, key: string): string {
    const uint8Array = new Uint8Array(buffer);
    const wordArray = CryptoJS.lib.WordArray.create(uint8Array as any);
    return CryptoJS.AES.encrypt(wordArray, key).toString();
  }

  decryptToBuffer(cipherText: string, key: string): ArrayBuffer {
    const decrypted = CryptoJS.AES.decrypt(cipherText, key);
    if (!decrypted.sigBytes) {
      throw new Error('Failed to decrypt chunk');
    }

    const result = new Uint8Array(decrypted.sigBytes);
    for (let i = 0; i < decrypted.sigBytes; i++) {
      result[i] = (decrypted.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
    }

    return result.buffer;
  }
}

export const chunkCryptoService = new ChunkCryptoService();
