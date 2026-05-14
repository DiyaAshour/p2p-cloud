import fs from 'node:fs';
import path from 'node:path';

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function safeWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export class UploadSessionStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.sessions = [];
  }

  load() {
    const parsed = safeReadJson(this.filePath, []);
    this.sessions = Array.isArray(parsed) ? parsed : [];
    return this.sessions;
  }

  save() {
    safeWriteJson(this.filePath, this.sessions);
  }

  list({ ownerWallet = null } = {}) {
    const wallet = String(ownerWallet || '').toLowerCase();
    return this.sessions.filter((session) => !wallet || String(session.ownerWallet || '').toLowerCase() === wallet);
  }

  upsert(session) {
    if (!session?.uploadId) throw new Error('uploadId is required for upload session');
    const now = new Date().toISOString();
    const next = { ...session, updatedAt: now };
    const index = this.sessions.findIndex((item) => item.uploadId === session.uploadId);
    if (index >= 0) this.sessions[index] = { ...this.sessions[index], ...next };
    else this.sessions.push({ ...next, createdAt: session.createdAt || now });
    this.save();
    return this.sessions.find((item) => item.uploadId === session.uploadId);
  }

  patch(uploadId, patch = {}) {
    const current = this.sessions.find((item) => item.uploadId === uploadId);
    if (!current) return this.upsert({ ...patch, uploadId });
    return this.upsert({ ...current, ...patch, uploadId });
  }

  complete(uploadId, patch = {}) {
    return this.patch(uploadId, { ...patch, status: patch.status || 'protected', completedAt: new Date().toISOString() });
  }

  fail(uploadId, error) {
    return this.patch(uploadId, { status: 'failed', error: error?.message || String(error), failedAt: new Date().toISOString() });
  }

  remove(uploadId) {
    this.sessions = this.sessions.filter((session) => session.uploadId !== uploadId);
    this.save();
  }
}

export function summarizeUploadSession(session = {}) {
  const chunks = Array.isArray(session.chunks) ? session.chunks : [];
  const uploadedChunks = chunks.filter((chunk) => ['available', 'protecting', 'protected'].includes(chunk.status)).length;
  const protectedChunks = chunks.filter((chunk) => chunk.status === 'protected').length;
  const failedChunks = chunks.filter((chunk) => chunk.status === 'failed').length;
  const status = failedChunks > 0
    ? 'failed'
    : chunks.length > 0 && protectedChunks === chunks.length
      ? 'protected'
      : uploadedChunks > 0
        ? 'protecting'
        : 'uploading';

  return {
    uploadId: session.uploadId,
    name: session.name,
    hash: session.hash,
    rootHash: session.rootHash,
    ownerWallet: session.ownerWallet,
    status,
    totalChunks: chunks.length,
    uploadedChunks,
    protectedChunks,
    failedChunks,
    totalBytes: session.totalBytes || 0,
    storedBytes: session.storedBytes || 0,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt || null,
    error: session.error || null,
  };
}
