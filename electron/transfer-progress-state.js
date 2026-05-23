const DEFAULT_PROGRESS = { upload: null, download: null };

globalThis.__chunknetTransferProgress ||= { ...DEFAULT_PROGRESS };

function nowIso() {
  return new Date().toISOString();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function computeProgress(next = {}) {
  const totalBytes = Math.max(0, safeNumber(next.totalBytes));
  const transferredBytes = Math.max(0, Math.min(totalBytes || Number.MAX_SAFE_INTEGER, safeNumber(next.transferredBytes)));
  const startedAtMs = safeNumber(next.startedAtMs, Date.now());
  const elapsedSeconds = Math.max(0.001, (Date.now() - startedAtMs) / 1000);
  const speedBytesPerSecond = Math.max(0, transferredBytes / elapsedSeconds);
  const remainingBytes = Math.max(0, totalBytes - transferredBytes);
  const etaSeconds = speedBytesPerSecond > 1 ? remainingBytes / speedBytesPerSecond : null;
  const percent = totalBytes > 0 ? Math.min(100, Math.max(0, (transferredBytes / totalBytes) * 100)) : 0;

  return {
    ...next,
    totalBytes,
    transferredBytes,
    percent,
    speedBytesPerSecond,
    etaSeconds,
    updatedAt: nowIso(),
  };
}

export function getTransferProgress() {
  globalThis.__chunknetTransferProgress ||= { ...DEFAULT_PROGRESS };
  return globalThis.__chunknetTransferProgress;
}

export function startTransfer(type, options = {}) {
  const progress = getTransferProgress();
  const now = Date.now();
  progress[type] = computeProgress({
    active: true,
    phase: 'running',
    fileName: String(options.fileName || 'file'),
    totalBytes: safeNumber(options.totalBytes),
    transferredBytes: 0,
    percent: 0,
    speedBytesPerSecond: 0,
    etaSeconds: null,
    chunksDone: 0,
    totalChunks: Math.max(1, safeNumber(options.totalChunks, 1)),
    concurrency: Math.max(1, safeNumber(options.concurrency, 1)),
    startedAt: nowIso(),
    startedAtMs: now,
    updatedAt: nowIso(),
    error: null,
    paused: false,
    cancellable: true,
  });
  return progress[type];
}

export function updateTransfer(type, patch = {}) {
  const progress = getTransferProgress();
  const current = progress[type];
  if (!current) return null;
  progress[type] = computeProgress({ ...current, ...patch, active: patch.active ?? current.active });
  return progress[type];
}

export function finishTransfer(type, patch = {}) {
  const progress = getTransferProgress();
  const current = progress[type];
  if (!current) return null;
  progress[type] = computeProgress({
    ...current,
    ...patch,
    active: false,
    phase: 'done',
    transferredBytes: patch.transferredBytes ?? current.totalBytes,
    chunksDone: patch.chunksDone ?? current.totalChunks,
    percent: 100,
    etaSeconds: 0,
    error: null,
    cancellable: false,
  });
  setTimeout(() => {
    const latest = getTransferProgress()[type];
    if (latest?.phase === 'done' && latest?.startedAt === progress[type]?.startedAt) {
      getTransferProgress()[type] = null;
    }
  }, 2500).unref?.();
  return progress[type];
}

export function failTransfer(type, error) {
  const progress = getTransferProgress();
  const current = progress[type];
  if (!current) return null;
  progress[type] = computeProgress({
    ...current,
    active: false,
    phase: 'error',
    error: error?.message || String(error || 'Transfer failed'),
    cancellable: false,
  });
  return progress[type];
}
