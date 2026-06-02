export function normalizeCapacityBytes(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function peerCapacitySummary(peer = {}, incomingBytes = 0) {
  const storage = peer.remoteStorage || peer.storage || {};
  const pressure = peer.pressure || {};
  const health = peer.health || {};
  const remainingSharedBytes = normalizeCapacityBytes(storage.remainingSharedBytes, 0);
  const freeBytes = normalizeCapacityBytes(storage.freeBytes, 0);
  const acceptingChunks = storage.acceptingChunks !== false;
  const pressureActive = Boolean(storage.pressure || pressure.overloaded);
  const badHealthBucket = ['dead', 'offline', 'quarantine', 'congested'].includes(String(health.bucket || '').toLowerCase());
  const hasCapacity = !incomingBytes || remainingSharedBytes >= Number(incomingBytes || 0);
  const accepted = Boolean(acceptingChunks && !pressureActive && !badHealthBucket && hasCapacity);

  let reason = null;
  if (!acceptingChunks) reason = 'remote-not-accepting-chunks';
  else if (pressureActive) reason = 'remote-under-pressure';
  else if (badHealthBucket) reason = `remote-health-${health.bucket}`;
  else if (!hasCapacity) reason = 'remote-insufficient-capacity';

  return {
    accepted,
    reason,
    incomingBytes: Number(incomingBytes || 0),
    acceptingChunks,
    pressure: pressureActive,
    remainingSharedBytes,
    freeBytes,
    nodeMode: storage.nodeMode || 'unknown',
    healthBucket: health.bucket || 'unknown',
    healthScore: Number(health.score || 0),
  };
}

export function filterCapacityPeers(peers = [], incomingBytes = 0) {
  const accepted = [];
  const rejected = [];
  for (const peer of peers || []) {
    const admission = peerCapacitySummary(peer, incomingBytes);
    const next = { ...peer, admission };
    if (admission.accepted) accepted.push(next);
    else rejected.push(next);
  }
  return { accepted, rejected };
}
