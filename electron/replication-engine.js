import { deleteChunkFromSafetyPeer, getChunkFromSafetyPeer, putChunkToSafetyPeer, SAFETY_PEER_REPLICA_ID } from './safety-peer.js';

const DEFAULT_TARGET_REPLICAS = 4;
const DEFAULT_MAX_REPLICA_ATTEMPTS = 8;

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function configuredReplicaCount(configuredTargetReplicas = DEFAULT_TARGET_REPLICAS) {
  const configured = Number(configuredTargetReplicas || DEFAULT_TARGET_REPLICAS);
  return Math.max(DEFAULT_TARGET_REPLICAS, Number.isFinite(configured) ? configured : DEFAULT_TARGET_REPLICAS);
}

function removeSafetyReplica(replicas = []) {
  return unique(replicas).filter((peerId) => peerId !== SAFETY_PEER_REPLICA_ID);
}

function hasSafetyReplica(replicas = []) {
  return unique(replicas).includes(SAFETY_PEER_REPLICA_ID);
}

function isChunkProtectedBySafety(chunk = {}) {
  return Boolean(
    hasSafetyReplica(chunk.replicas || []) ||
    chunk.safetyPeer?.enabled === true ||
    ['uploaded', 'protected-temporary', 'emergency-protected'].includes(chunk.safetyStatus) ||
    ['protected-temporary', 'emergency-protected'].includes(chunk.safetyPeer?.status)
  );
}

function makeSafetyChunk(chunk = {}) {
  return {
    ...chunk,
    forceSafetyPeer: true,
    emergencySafety: true,
    safetyRequired: true,
  };
}

export function getTargetReplicaCount(node, configuredTargetReplicas = DEFAULT_TARGET_REPLICAS) {
  const connectedPeers = node?.connectedPeerIds?.() || [];
  return Math.max(1, Math.min(configuredReplicaCount(configuredTargetReplicas), 1 + connectedPeers.length));
}

export function getHealthyReplicas(node, chunkHash, knownReplicas = []) {
  const replicas = new Set();

  if (node?.getLocalChunk?.(chunkHash)) replicas.add(node.peerId);

  for (const peerId of node?.healthyReplicaIds?.(chunkHash) || []) {
    replicas.add(peerId);
  }

  const onlinePeers = new Set(node?.connectedPeerIds?.() || []);
  for (const peerId of removeSafetyReplica(knownReplicas || [])) {
    if (peerId === node?.peerId && node?.getLocalChunk?.(chunkHash)) replicas.add(peerId);
    if (onlinePeers.has(peerId)) replicas.add(peerId);
  }

  return unique(Array.from(replicas));
}

export function replicateChunk(node, chunkPayload, existingReplicas = [], configuredTargetReplicas = DEFAULT_TARGET_REPLICAS) {
  if (!node) throw new Error('P2P node is required for replication');
  if (!chunkPayload?.hash) throw new Error('chunk.hash is required for replication');

  const targetReplicaCount = getTargetReplicaCount(node, configuredTargetReplicas);
  const replicas = new Set(unique([node.peerId, ...removeSafetyReplica(existingReplicas)]));

  node.storeLocalChunk?.(chunkPayload);

  const needed = Math.max(0, targetReplicaCount - replicas.size);
  if (needed <= 0) return unique(Array.from(replicas));

  const targets = node.selectReplicaTargets?.({
    exclude: Array.from(replicas),
    limit: needed,
  }) || [];

  if (!targets.length) return unique(Array.from(replicas));

  for (const peerId of targets) replicas.add(peerId);

  try {
    const result = node.putChunkOnNetwork?.(chunkPayload, targets);

    if (result && typeof result.then === 'function') {
      result
        .then((ackResult) => {
          if (ackResult?.replicas?.length) {
            console.log('[replication] acknowledged replicas:', chunkPayload.hash, ackResult.replicas.join(', '));
          }
          if (ackResult?.failedReplicas?.length) {
            console.warn('[replication] unacknowledged replicas:', chunkPayload.hash, ackResult.failedReplicas.map((entry) => entry.peerId).join(', '));
          }
        })
        .catch((error) => console.warn('[replication] ack failed:', error?.message || error));
    } else {
      for (const peerId of result?.replicas || targets) replicas.add(peerId);
    }
  } catch (error) {
    console.warn('[replication] failed:', error?.message || error);
  }

  return unique(Array.from(replicas));
}

export async function replicateChunkUntilConfirmed({
  node,
  chunkPayload,
  existingReplicas = [],
  configuredTargetReplicas = DEFAULT_TARGET_REPLICAS,
  minimumConfirmedReplicas = null,
  maxAttempts = DEFAULT_MAX_REPLICA_ATTEMPTS,
} = {}) {
  if (!node) throw new Error('P2P node is required for confirmed replication');
  if (!chunkPayload?.hash) throw new Error('chunk.hash is required for confirmed replication');

  const targetReplicaCount = getTargetReplicaCount(node, configuredTargetReplicas);
  const minimumConfirmed = Math.max(1, Math.min(targetReplicaCount, Number(minimumConfirmedReplicas || targetReplicaCount)));
  const replicas = new Set(unique([node.peerId, ...removeSafetyReplica(existingReplicas)]));
  const attempted = new Set([node.peerId, ...removeSafetyReplica(existingReplicas)]);
  const failedReplicas = [];
  const startedAt = Date.now();
  let attempts = 0;

  node.storeLocalChunk?.(chunkPayload);

  while (replicas.size < targetReplicaCount && attempts < Math.max(1, Number(maxAttempts || DEFAULT_MAX_REPLICA_ATTEMPTS))) {
    const remainingAttempts = Math.max(0, Number(maxAttempts || DEFAULT_MAX_REPLICA_ATTEMPTS) - attempts);
    const needed = Math.max(0, targetReplicaCount - replicas.size);
    const limit = Math.max(1, Math.min(needed, remainingAttempts));
    const targets = node.selectReplicaTargets?.({
      exclude: unique([...replicas, ...attempted]),
      limit,
    }) || [];

    if (!targets.length) break;
    for (const peerId of targets) attempted.add(peerId);
    attempts += targets.length;

    try {
      const result = await node.putChunkOnNetwork?.(chunkPayload, targets);
      for (const peerId of result?.replicas || []) replicas.add(peerId);
      for (const failure of result?.failedReplicas || []) failedReplicas.push(failure);
    } catch (error) {
      for (const peerId of targets) failedReplicas.push({ peerId, chunkHash: chunkPayload.hash, error: error?.message || String(error) });
      console.warn('[replication] confirmed upload attempt failed:', chunkPayload.hash, targets.join(', '), error?.message || error);
    }
  }

  const confirmedReplicas = unique(Array.from(replicas));
  const complete = confirmedReplicas.length >= targetReplicaCount;
  const minimumSafe = confirmedReplicas.length >= minimumConfirmed;

  return {
    ok: minimumSafe,
    complete,
    underReplicated: !complete,
    replicas: confirmedReplicas,
    failedReplicas,
    confirmedReplicas: confirmedReplicas.length,
    targetReplicas: targetReplicaCount,
    minimumConfirmedReplicas: minimumConfirmed,
    attemptedReplicas: unique(Array.from(attempted)),
    attempts,
    durationMs: Date.now() - startedAt,
    status: complete ? 'protected' : minimumSafe ? 'protecting' : 'failed',
  };
}

async function replicateChunkConfirmed(node, chunkPayload, existingReplicas = [], configuredTargetReplicas = DEFAULT_TARGET_REPLICAS) {
  const result = await replicateChunkUntilConfirmed({
    node,
    chunkPayload,
    existingReplicas,
    configuredTargetReplicas,
    minimumConfirmedReplicas: configuredTargetReplicas,
    maxAttempts: DEFAULT_MAX_REPLICA_ATTEMPTS,
  });

  if (result.failedReplicas?.length) {
    console.warn('[repair] failed confirmed replicas:', chunkPayload.hash, result.failedReplicas.map((entry) => `${entry.peerId}:${entry.error || 'unknown'}`).join(', '));
  }

  return result.replicas;
}

export function countUnderReplicatedChunks(node, manifests = [], configuredTargetReplicas = DEFAULT_TARGET_REPLICAS) {
  // Protection decisions must compare against the full target, not only currently connected peers.
  // With 0 peers, local replica count is 1/4, so repair must upload to AWS safety and mark protected.
  const targetReplicaCount = configuredReplicaCount(configuredTargetReplicas);
  let count = 0;

  for (const manifest of manifests || []) {
    for (const chunk of manifest.chunks || []) {
      const healthyReplicas = getHealthyReplicas(node, chunk.hash, chunk.replicas);
      if (healthyReplicas.length < targetReplicaCount && !isChunkProtectedBySafety(chunk)) count += 1;
    }
  }

  return count;
}

async function ensureSafetyForUnderReplicatedChunk({ node, chunkMeta, chunk, fullTargetReplicaCount, healthyReplicas }) {
  if (!chunk || healthyReplicas.length >= fullTargetReplicaCount) return { changed: false, safetyStatus: 'not-needed' };

  try {
    const result = await putChunkToSafetyPeer(makeSafetyChunk(chunk), node.peerId);
    if (result?.ok) {
      const before = unique(chunkMeta.replicas || []);
      const after = unique([...before, SAFETY_PEER_REPLICA_ID]);
      chunkMeta.replicas = after;
      chunkMeta.safetyStatus = 'uploaded';
      chunkMeta.safetyPeer = {
        enabled: true,
        status: 'emergency-protected',
        replicaId: SAFETY_PEER_REPLICA_ID,
        updatedAt: new Date().toISOString(),
      };
      return { changed: true, safetyStatus: 'uploaded' };
    }
    return { changed: false, safetyStatus: result?.skipped ? `skipped:${result.reason || 'unknown'}` : 'not-uploaded' };
  } catch (error) {
    chunkMeta.safetyPeer = {
      enabled: true,
      status: 'upload-failed',
      replicaId: SAFETY_PEER_REPLICA_ID,
      error: error?.message || String(error),
      updatedAt: new Date().toISOString(),
    };
    console.warn('[repair] safety peer upload failed:', chunkMeta.hash, error?.message || error);
    return { changed: true, safetyStatus: 'upload-failed' };
  }
}

async function deleteSafetyForProtectedChunk({ node, chunkMeta }) {
  try {
    await deleteChunkFromSafetyPeer(chunkMeta.hash, node.peerId);
  } catch (error) {
    chunkMeta.safetyPeer = {
      enabled: true,
      status: 'delete-failed',
      replicaId: SAFETY_PEER_REPLICA_ID,
      error: error?.message || String(error),
      updatedAt: new Date().toISOString(),
    };
    console.warn('[repair] safety peer delete failed:', chunkMeta.hash, error?.message || error);
    return { changed: true, safetyStatus: 'delete-failed' };
  }

  const before = unique(chunkMeta.replicas || []);
  const after = removeSafetyReplica(before);
  chunkMeta.replicas = after;
  chunkMeta.safetyStatus = 'deleted';
  chunkMeta.safetyPeer = {
    enabled: false,
    status: 'deleted-after-peer-protection',
    replicaId: SAFETY_PEER_REPLICA_ID,
    updatedAt: new Date().toISOString(),
  };
  return { changed: before.length !== after.length || before.includes(SAFETY_PEER_REPLICA_ID), safetyStatus: 'deleted' };
}

export async function repairManifests({ node, manifests = [], configuredTargetReplicas = DEFAULT_TARGET_REPLICAS, persistManifests, syncPush }) {
  if (!node) throw new Error('P2P node is required for repair');

  const targetReplicaCount = getTargetReplicaCount(node, configuredTargetReplicas);
  const fullTargetReplicaCount = configuredReplicaCount(configuredTargetReplicas);
  const report = [];
  let changed = false;

  for (const manifest of manifests || []) {
    const fileReplicas = new Set(removeSafetyReplica(manifest.replicas || [node.peerId]));

    for (const chunkMeta of manifest.chunks || []) {
      let chunk = node.getLocalChunk?.(chunkMeta.hash) || null;
      let source = chunk ? 'local' : null;

      if (!chunk) {
        try {
          chunk = await node.fetchChunkFromNetwork(chunkMeta.hash);
          node.storeLocalChunk?.(chunk);
          source = 'network';
        } catch (error) {
          console.warn('[repair] network chunk unavailable, trying safety peer:', chunkMeta.hash, error?.message || error);
          try {
            chunk = await getChunkFromSafetyPeer(chunkMeta.hash, node.peerId);
            node.storeLocalChunk?.(chunk);
            source = 'safety-peer';
          } catch (safetyError) {
            console.warn('[repair] safety peer chunk unavailable:', chunkMeta.hash, safetyError?.message || safetyError);
          }
        }
      }

      const before = getHealthyReplicas(node, chunkMeta.hash, chunkMeta.replicas);
      let after = before;
      let safetyStatus = 'unchanged';

      if (chunk) {
        after = await replicateChunkConfirmed(node, chunk, before, configuredTargetReplicas);
        const healthyAfter = unique(after);

        if (healthyAfter.length >= fullTargetReplicaCount) {
          const safety = await deleteSafetyForProtectedChunk({ node, chunkMeta });
          safetyStatus = safety.safetyStatus;
          changed = changed || safety.changed;
        } else {
          const safety = await ensureSafetyForUnderReplicatedChunk({
            node,
            chunkMeta,
            chunk,
            fullTargetReplicaCount,
            healthyReplicas: healthyAfter,
          });
          safetyStatus = safety.safetyStatus;
          changed = changed || safety.changed;
        }

        const safetyProtected = safetyStatus === 'uploaded' || isChunkProtectedBySafety(chunkMeta);
        const peerProtected = healthyAfter.length >= fullTargetReplicaCount;
        const nextReplicas = unique([...healthyAfter, ...unique(chunkMeta.replicas || []).filter((peerId) => peerId === SAFETY_PEER_REPLICA_ID)]);
        const oldKey = unique(chunkMeta.replicas || []).sort().join('|');
        const newKey = nextReplicas.sort().join('|');
        if (oldKey !== newKey) {
          chunkMeta.replicas = nextReplicas;
          changed = true;
        }

        chunkMeta.replicationStatus = peerProtected || safetyProtected ? 'protected' : 'protecting';
        chunkMeta.protectionMode = peerProtected ? 'p2p' : safetyProtected ? 'aws-safety' : 'repairing';
        chunkMeta.confirmedReplicas = healthyAfter.length;
        chunkMeta.targetReplicas = fullTargetReplicaCount;
        chunkMeta.replicationUpdatedAt = new Date().toISOString();
        changed = true;

        for (const peerId of healthyAfter) fileReplicas.add(peerId);
      } else {
        const replicasWithoutSafety = removeSafetyReplica(chunkMeta.replicas || []);
        if (replicasWithoutSafety.length !== unique(chunkMeta.replicas || []).filter((peerId) => peerId !== SAFETY_PEER_REPLICA_ID).length) changed = true;
        chunkMeta.replicas = unique([...replicasWithoutSafety, ...(unique(chunkMeta.replicas || []).includes(SAFETY_PEER_REPLICA_ID) ? [SAFETY_PEER_REPLICA_ID] : [])]);
        chunkMeta.replicationStatus = isChunkProtectedBySafety(chunkMeta) ? 'protected' : 'missing-source';
        chunkMeta.protectionMode = isChunkProtectedBySafety(chunkMeta) ? 'aws-safety' : 'missing';
        chunkMeta.confirmedReplicas = before.length;
        chunkMeta.targetReplicas = fullTargetReplicaCount;
      }

      report.push({
        file: manifest.name,
        hash: manifest.hash,
        chunkHash: chunkMeta.hash,
        chunkIndex: chunkMeta.index,
        source,
        healthyReplicas: unique(after),
        targetReplicas: fullTargetReplicaCount,
        activeTargetReplicas: targetReplicaCount,
        safetyStatus,
        protectionMode: chunkMeta.protectionMode,
        underReplicated: unique(after).length < fullTargetReplicaCount,
        protected: chunkMeta.replicationStatus === 'protected',
        repaired: Boolean(chunk && unique(after).length > unique(before).length),
      });
    }

    const nextFileReplicas = unique(Array.from(fileReplicas));
    const oldFileKey = removeSafetyReplica(manifest.replicas || []).sort().join('|');
    const newFileKey = nextFileReplicas.sort().join('|');
    if (oldFileKey !== newFileKey) {
      manifest.replicas = nextFileReplicas;
      changed = true;
    }

    const chunks = manifest.chunks || [];
    if (chunks.length) {
      const protectedChunks = chunks.filter((chunk) => (
        Number(chunk.confirmedReplicas || 0) >= fullTargetReplicaCount || isChunkProtectedBySafety(chunk)
      )).length;
      const p2pProtectedChunks = chunks.filter((chunk) => Number(chunk.confirmedReplicas || 0) >= fullTargetReplicaCount).length;
      const safetyProtectedChunks = chunks.filter((chunk) => Number(chunk.confirmedReplicas || 0) < fullTargetReplicaCount && isChunkProtectedBySafety(chunk)).length;
      const nextStatus = protectedChunks === chunks.length ? 'protected' : 'protecting';
      if (
        manifest.replicationStatus !== nextStatus ||
        manifest.protectedChunks !== protectedChunks ||
        manifest.p2pProtectedChunks !== p2pProtectedChunks ||
        manifest.safetyProtectedChunks !== safetyProtectedChunks
      ) {
        manifest.replicationStatus = nextStatus;
        manifest.protectedChunks = protectedChunks;
        manifest.p2pProtectedChunks = p2pProtectedChunks;
        manifest.safetyProtectedChunks = safetyProtectedChunks;
        manifest.protectionMode = p2pProtectedChunks === chunks.length ? 'p2p' : safetyProtectedChunks > 0 ? 'aws-safety' : 'repairing';
        manifest.targetReplicas = fullTargetReplicaCount;
        manifest.replicationUpdatedAt = new Date().toISOString();
        changed = true;
      }
    }
  }

  if (changed) {
    persistManifests?.();
    if (typeof syncPush === 'function') {
      for (const manifest of manifests || []) await syncPush(manifest);
    }
  }

  return { changed, report };
}
