import fs from 'node:fs';
import path from 'node:path';

export const GIB = 1024 ** 3;

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

export function defaultNodeStoragePolicy() {
  const reservedFreeBytes = numberFromEnv(
    'P2P_NODE_RESERVED_FREE_BYTES',
    numberFromEnv('P2P_NODE_RESERVED_FREE_GB', 50) * GIB,
  );

  const minimumNodeBytes = numberFromEnv(
    'P2P_MIN_STORAGE_NODE_BYTES',
    numberFromEnv('P2P_MIN_STORAGE_NODE_GB', 10) * GIB,
  );

  const configuredMaxBytes = process.env.P2P_NODE_MAX_STORAGE_BYTES !== undefined
    ? numberFromEnv('P2P_NODE_MAX_STORAGE_BYTES', null)
    : process.env.P2P_NODE_MAX_STORAGE_GB !== undefined
      ? numberFromEnv('P2P_NODE_MAX_STORAGE_GB', 0) * GIB
      : null;

  return {
    diskRatio: clamp(numberFromEnv('P2P_NODE_STORAGE_RATIO', 0.18), 0.01, 0.5),
    reservedFreeBytes: Math.max(0, reservedFreeBytes),
    minimumNodeBytes: Math.max(0, minimumNodeBytes),
    configuredMaxBytes: configuredMaxBytes === null ? null : Math.max(0, Number(configuredMaxBytes || 0)),
    checkIntervalMs: Math.max(30_000, numberFromEnv('P2P_STORAGE_CHECK_INTERVAL_MS', 5 * 60 * 1000)),
  };
}

export function directorySizeSync(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];

  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push(entryPath);
        } else if (entry.isFile()) {
          total += fs.statSync(entryPath).size;
        }
      } catch {
        // Ignore files that disappear while we are measuring.
      }
    }
  }

  return total;
}

export function inspectDiskSpace(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stats = fs.statfsSync(dir);
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    if (!blockSize) return { ok: false, totalBytes: null, freeBytes: null, error: 'statfs block size unavailable' };

    return {
      ok: true,
      totalBytes: Number(stats.blocks || 0) * blockSize,
      freeBytes: Number(stats.bavail || stats.bfree || 0) * blockSize,
      error: null,
    };
  } catch (error) {
    return { ok: false, totalBytes: null, freeBytes: null, error: error?.message || String(error) };
  }
}

export function classifyNodeStorage(maxSharedStorageBytes = 0) {
  if (maxSharedStorageBytes < 10 * GIB) return 'no-storage';
  if (maxSharedStorageBytes < 50 * GIB) return 'light';
  if (maxSharedStorageBytes < 500 * GIB) return 'standard';
  return 'power';
}

export function estimateChunkStorageBytes(chunk = {}) {
  try {
    return Buffer.byteLength(JSON.stringify({ ...chunk, storedAt: new Date().toISOString() }), 'utf8');
  } catch {
    const base64Bytes = Buffer.byteLength(String(chunk?.data || ''), 'utf8');
    return base64Bytes + 1024;
  }
}

export function calculateNodeStorage({ totalBytes, freeBytes, usedBytes = 0, policy = defaultNodeStoragePolicy() }) {
  const knownTotal = Number.isFinite(Number(totalBytes)) && Number(totalBytes) > 0;
  const knownFree = Number.isFinite(Number(freeBytes)) && Number(freeBytes) >= 0;
  const used = Math.max(0, Number(usedBytes || 0));
  const reservedFreeBytes = Math.max(0, Number(policy.reservedFreeBytes || 0));
  const recommendedByDiskSize = policy.configuredMaxBytes !== null && policy.configuredMaxBytes !== undefined
    ? Math.max(0, Number(policy.configuredMaxBytes || 0))
    : knownTotal
      ? Math.floor(Number(totalBytes) * Number(policy.diskRatio || 0.18))
      : used;

  const writableFreeBytes = knownFree ? Math.max(0, Number(freeBytes) - reservedFreeBytes) : 0;
  const maxSharedStorageBytes = Math.max(0, Math.min(recommendedByDiskSize, used + writableFreeBytes));
  const remainingSharedBytes = Math.max(0, Math.min(maxSharedStorageBytes - used, writableFreeBytes));
  const acceptingChunks = remainingSharedBytes > 0 && maxSharedStorageBytes >= Number(policy.minimumNodeBytes || 0);
  const pressure = !acceptingChunks || (knownFree && Number(freeBytes) <= reservedFreeBytes);

  return {
    ok: knownTotal && knownFree,
    nodeMode: classifyNodeStorage(maxSharedStorageBytes),
    acceptingChunks,
    pressure,
    totalBytes: knownTotal ? Number(totalBytes) : null,
    freeBytes: knownFree ? Number(freeBytes) : null,
    usedBytes: used,
    recommendedByDiskSizeBytes: recommendedByDiskSize,
    reservedFreeBytes,
    maxSharedStorageBytes,
    remainingSharedBytes,
    minimumNodeBytes: Number(policy.minimumNodeBytes || 0),
    diskRatio: Number(policy.diskRatio || 0.18),
    configuredMaxBytes: policy.configuredMaxBytes ?? null,
    checkedAt: new Date().toISOString(),
  };
}
