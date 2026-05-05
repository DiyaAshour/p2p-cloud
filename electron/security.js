import crypto from 'node:crypto';
import { verifyMessage } from 'viem';

export function normalizeWallet(address = '') {
  return String(address || '').trim().toLowerCase();
}

export function isValidWallet(address = '') {
  return /^0x[a-fA-F0-9]{40}$/.test(String(address || '').trim());
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function buildSignedMessage({ type, wallet, timestamp, bodyHash = '', peerId = '', url = '' }) {
  return [
    `p2p.cloud ${type}`,
    `Wallet: ${normalizeWallet(wallet)}`,
    peerId ? `Peer: ${peerId}` : '',
    url ? `URL: ${url}` : '',
    bodyHash ? `Body-SHA256: ${bodyHash}` : '',
    `Time: ${timestamp}`,
  ].filter(Boolean).join('\n');
}

export async function verifyWalletSignedMessage({ wallet, message, signature, requiredPrefix = '', maxAgeMs = 10 * 60 * 1000, maxFutureMs = 2 * 60 * 1000 }) {
  const normalized = normalizeWallet(wallet);
  if (!isValidWallet(normalized)) throw new Error('Invalid wallet address');
  if (!message || !signature) throw new Error('Missing wallet signature');
  if (requiredPrefix && !String(message).startsWith(requiredPrefix)) throw new Error('Unsupported signed message');
  if (!String(message).toLowerCase().includes(`wallet: ${normalized}`)) throw new Error('Signed message wallet mismatch');
  const match = String(message).match(/^Time:\s*(.+)$/im);
  if (!match) throw new Error('Signed message missing timestamp');
  const signedAt = new Date(match[1]);
  if (Number.isNaN(signedAt.getTime())) throw new Error('Signed timestamp invalid');
  const age = Date.now() - signedAt.getTime();
  if (age > maxAgeMs) throw new Error('Signed message expired');
  if (age < -maxFutureMs) throw new Error('Signed timestamp too far in the future');
  const valid = await verifyMessage({ address: normalized, message: String(message), signature: String(signature) });
  if (!valid) throw new Error('Wallet signature verification failed');
  return { wallet: normalized, signedAt: signedAt.toISOString() };
}
