import 'react-native-get-random-values';
import { Buffer } from 'buffer';
import * as Random from 'expo-random';
import { AESGCM } from '@stablelib/aes-gcm';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';

export const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
export const ENCRYPTION_KEY_SOURCE = 'wallet-password-v1';
export const KDF_ALGORITHM = 'pbkdf2-sha256';
export const KDF_ITERATIONS = 310000;
export const MIN_DRIVE_PASSWORD_LENGTH = 12;
export const DEFAULT_CHUNK_SIZE_BYTES = 1024 * 1024;

export type EncryptionMetadata = {
  version: number;
  algorithm: string;
  keySource: string;
  kdf: string;
  kdfIterations: number;
  salt: string;
  iv: string;
  authTag: string;
  originalHash: string;
  originalSize: number;
};

export type MobileChunk = {
  index: number;
  size: number;
  hash: string;
  data: string;
  ownerWallet: string;
  encrypted: boolean;
};

export type MobileManifest = {
  id: string;
  name: string;
  size: number;
  storedSize: number;
  hash: string;
  rootHash: string;
  uploadedAt: string;
  isEncrypted: boolean;
  encryption: EncryptionMetadata;
  mimeType: string;
  chunkSize: number;
  totalChunks: number;
  ownerNodeId: string;
  ownerWallet: string;
  planId: string;
  replicas: string[];
  chunks: Array<{ index: number; hash: string; size: number; replicas: string[] }>;
};

export function normalizeWallet(address = '') {
  return String(address).trim().toLowerCase();
}

export function assertWallet(address = '') {
  const wallet = normalizeWallet(address);
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) throw new Error('Enter a valid 0x wallet address.');
  return wallet;
}

export function assertDrivePassword(password = '', min = MIN_DRIVE_PASSWORD_LENGTH) {
  const clean = String(password || '').trim();
  if (clean.length < min) throw new Error(`Drive Password must be at least ${min} characters.`);
  return clean;
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function sha256Hex(data: Uint8Array | Buffer) {
  return hex(sha256(data));
}

async function randomBytes(size: number) {
  return Random.getRandomBytesAsync(size);
}

function deriveDriveKey(ownerWallet: string, drivePassword: string, salt: Uint8Array) {
  const wallet = assertWallet(ownerWallet);
  const password = assertDrivePassword(drivePassword);
  return pbkdf2(sha256, `${wallet}:${password}`, salt, { c: KDF_ITERATIONS, dkLen: 32 });
}

export async function encryptPrivateBytes(plain: Uint8Array, ownerWallet: string, drivePassword: string) {
  const salt = await randomBytes(16);
  const iv = await randomBytes(12);
  const key = deriveDriveKey(ownerWallet, drivePassword, salt);
  const aes = new AESGCM(key);
  const sealed = aes.seal(iv, plain);
  const ciphertext = sealed.slice(0, sealed.length - 16);
  const tag = sealed.slice(sealed.length - 16);
  const encryption: EncryptionMetadata = {
    version: 4,
    algorithm: ENCRYPTION_ALGORITHM,
    keySource: ENCRYPTION_KEY_SOURCE,
    kdf: KDF_ALGORITHM,
    kdfIterations: KDF_ITERATIONS,
    salt: Buffer.from(salt).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    authTag: Buffer.from(tag).toString('base64'),
    originalHash: sha256Hex(plain),
    originalSize: plain.length,
  };
  return { ciphertext: Buffer.from(ciphertext), encryption };
}

export function decryptPrivateBytes(ciphertext: Uint8Array, metadata: EncryptionMetadata, ownerWallet: string, drivePassword: string) {
  if (!metadata || metadata.algorithm !== ENCRYPTION_ALGORITHM) throw new Error('Unsupported encryption metadata.');
  if (metadata.keySource !== ENCRYPTION_KEY_SOURCE) throw new Error('Unsupported key source.');
  const salt = Buffer.from(metadata.salt, 'base64');
  const iv = Buffer.from(metadata.iv, 'base64');
  const tag = Buffer.from(metadata.authTag, 'base64');
  const key = deriveDriveKey(ownerWallet, drivePassword, salt);
  const aes = new AESGCM(key);
  const opened = aes.open(iv, Buffer.concat([Buffer.from(ciphertext), tag]));
  if (!opened) throw new Error('Wrong Drive Password or corrupted encrypted data.');
  if (metadata.originalHash && sha256Hex(opened) !== metadata.originalHash) throw new Error('Private file integrity failed after decrypt.');
  return Buffer.from(opened);
}

function splitIntoChunks(buffer: Buffer, chunkSize: number) {
  const chunks: Array<{ index: number; data: Buffer; size: number; hash: string }> = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    const data = buffer.slice(offset, offset + chunkSize);
    chunks.push({ index: chunks.length, data, size: data.length, hash: sha256Hex(data) });
  }
  if (!chunks.length) {
    const data = Buffer.alloc(0);
    chunks.push({ index: 0, data, size: 0, hash: sha256Hex(data) });
  }
  return chunks;
}

export async function buildEncryptedMobileUpload(params: {
  ownerWallet: string;
  drivePassword: string;
  name: string;
  mimeType?: string;
  bytes: Uint8Array | Buffer;
  chunkSize?: number;
}) {
  const ownerWallet = assertWallet(params.ownerWallet);
  const plain = Buffer.from(params.bytes);
  const { ciphertext, encryption } = await encryptPrivateBytes(plain, ownerWallet, params.drivePassword);
  const chunkSize = params.chunkSize || DEFAULT_CHUNK_SIZE_BYTES;
  const chunkParts = splitIntoChunks(ciphertext, chunkSize);
  const hash = sha256Hex(ciphertext);
  const rootHash = hash;
  const ownerNodeId = `mobile-${ownerWallet.slice(2, 10)}`;
  const chunks: MobileChunk[] = chunkParts.map((chunk) => ({
    index: chunk.index,
    size: chunk.size,
    hash: chunk.hash,
    data: chunk.data.toString('base64'),
    ownerWallet,
    encrypted: true,
  }));
  const manifest: MobileManifest = {
    id: `${ownerWallet}:${hash}`,
    name: params.name || 'mobile-file',
    size: plain.length,
    storedSize: ciphertext.length,
    hash,
    rootHash,
    uploadedAt: new Date().toISOString(),
    isEncrypted: true,
    encryption,
    mimeType: params.mimeType || 'application/octet-stream',
    chunkSize,
    totalChunks: chunks.length,
    ownerNodeId,
    ownerWallet,
    planId: 'free',
    replicas: [ownerNodeId],
    chunks: chunks.map((chunk) => ({ index: chunk.index, hash: chunk.hash, size: chunk.size, replicas: [ownerNodeId] })),
  };
  return { manifest, chunks };
}
