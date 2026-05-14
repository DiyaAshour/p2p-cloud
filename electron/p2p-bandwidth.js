export function createTokenBucket({ bytesPerSecond, burstBytes = bytesPerSecond } = {}) {
  return {
    capacity: Math.max(1, Number(burstBytes || bytesPerSecond || 1)),
    refillPerSecond: Math.max(1, Number(bytesPerSecond || 1)),
    tokens: Math.max(1, Number(burstBytes || bytesPerSecond || 1)),
    updatedAt: Date.now(),
  };
}

export function refillBucket(bucket) {
  if (!bucket) return null;
  const now = Date.now();
  const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSeconds * bucket.refillPerSecond);
  bucket.updatedAt = now;
  return bucket;
}

export function canSpend(bucket, bytes) {
  refillBucket(bucket);
  return bucket && bucket.tokens >= bytes;
}

export function spend(bucket, bytes) {
  if (!canSpend(bucket, bytes)) return false;
  bucket.tokens -= bytes;
  return true;
}

export function spendAll(buckets = [], bytes) {
  for (const bucket of buckets) {
    if (!canSpend(bucket, bytes)) return false;
  }
  for (const bucket of buckets) {
    spend(bucket, bytes);
  }
  return true;
}
