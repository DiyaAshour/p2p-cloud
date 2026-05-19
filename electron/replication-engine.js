import {
  deleteChunkFromSafetyPeer,
  getChunkFromSafetyPeer,
  putChunkToSafetyPeer,
  SAFETY_PEER_REPLICA_ID,
} from './safety-peer.js';

const DEFAULT_TARGET_REPLICAS = 4;
const DEFAULT_MAX_REPLICA_ATTEMPTS = 8;

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function configuredReplicaCount(configuredTargetReplicas = DEFAULT_TARGET_REPLICAS) {
  const configured = Number(configuredTargetReplicas || DEFAULT_TARGET_REPLICAS);

  if (!Number.isFinite(configured)) return DEFAULT_TARGET_REPLICAS;

  return Math.max(DEFAULT_TARGET_REPLICAS, configured);
}

function withoutSafetyReplica(replicas = []) {
  return unique(replicas).filter((peerId) => peerId !== SAFETY_PEER_REPLICA_ID);
}

function withSafetyFlags(chunk = {}) {
  return {
    ...chunk,
    forceSafetyPeer: true,
    emergencySafety: true,
    safetyRequired: true,
  };
}

export function getTargetReplicaCount(node, configuredTargetReplicas = DEFAULT_TARGET_REPLICAS) {
  const connectedPeers = node?.connectedPeerIds?.() || [];
  const fullTarget = configuredReplicaCount(configuredTargetReplicas);

  // Active target depends on currently connected peers.
  // Example: local + 1 connected peer = active target 2.
  // But AWS delete still requires fullTarget = 4 below.
  return Math.max(1, Math.min(fullTarget, 1 + connectedPeers.length));
}

export function getHealthyReplicas(node, chunkHash, knownReplicas = []) {
  const replicas = new Set();

  if (node?.getLocalChunk?.(chunkHash)) {
    replicas.add(node.peerId);
  }

  for (const peerId of node?.healthyReplicaIds?.(chunkHash) || []) {
    if (peerId && peerId !== SAFETY_PEER_REPLICA_ID) {
      replicas.add(peerId);
    }
  }

  const onlinePeers = new Set(node?.connectedPeerIds?.() || []);

  for (const peerId of withoutSafetyReplica(knownReplicas || [])) {
    if (peerId === node?.peerId && node?.getLocalChunk?.(chunkHash)) {
      replicas.add(peerId);
    }

    if (onlinePeers.has(peerId)) {
      replicas.add(peerId);
    }
  }

  return unique(Array.from(replicas));
}

export function replicateChunk(
  node,
  chunkPayload,
  existingReplicas = [],
  configuredTargetReplicas = DEFAULT_TARGET_REPLICAS
) {
  if (!node) throw new Error('P2P node is required for replication');
  if (!chunkPayload?.hash) throw new Error('chunk.hash is required for replication');

  const targetReplicaCount = getTargetReplicaCount(node, configuredTargetReplicas);
  const replicas = new Set(unique([node.peerId, ...withoutSafetyReplica(existingReplicas)]));

  node.storeLocalChunk?.(chunkPayload);

  const needed = Math.max(0, targetReplicaCount - replicas.size);

  if (needed <= 0) {
    return unique(Array.from(replicas));
  }

  const targets =
    node.selectReplicaTargets?.({
      exclude: Array.from(replicas),
      limit: needed,
    }) || [];

  if (!targets.length) {
    return unique(Array.from(replicas));
  }

  // This function stays sync for upload compatibility.
  // Actual confirmed replication is handled by replicateChunkUntilConfirmed below.
  for (const peerId of targets) {
    replicas.add(peerId);
  }

  try {
    const result = node.putChunkOnNetwork?.(chunkPayload, targets);

    if (result && typeof result.then === 'function') {
      result
        .then((ackResult) => {
          if (ackResult?.replicas?.length) {
            console.log(
              '[replication] acknowledged replicas:',
              chunkPayload.hash,
              ackResult.replicas.join(', ')
            );
          }

          if (ackResult?.failedReplicas?.length) {
            console.warn(
              '[replication] unacknowledged replicas:',
              chunkPayload.hash,
              ackResult.failedReplicas.map((entry) => entry.peerId).join(', ')
            );
          }
        })
        .catch((error) => console.warn('[replication] ack failed:', error?.message || error));
    } else {
      for (const peerId of result?.replicas || targets) {
        replicas.add(peerId);
      }
    }
  } catch (error) {
    console.warn('[replication] failed:', error?.message || error);
  }

  return unique(Array.from(replicas));
}

async function replicateChunkUntilConfirmed({
  node,
  chunkPayload,
  existingReplicas = [],
  configuredTargetReplicas = DEFAULT_TARGET_REPLICAS,
  maxAttempts = DEFAULT_MAX_REPLICA_ATTEMPTS,
} = {}) {
  if (!node) throw new Error('P2P node is required for confirmed replication');
  if (!chunkPayload?.hash) throw new Error('chunk.hash is required for confirmed replication');

  const targetReplicaCount = getTargetReplicaCount(node, configuredTargetReplicas);
  const replicas = new Set(unique([node.peerId, ...withoutSafetyReplica(existingReplicas)]));
  const attempted = new Set(unique([node.peerId, ...withoutSafetyReplica(existingReplicas)]));
  const failedReplicas = [];

  node.storeLocalChunk?.(chunkPayload);

  let attempts = 0;

  while (replicas.size < targetReplicaCount && attempts < Math.max(1, Number(maxAttempts || 1))) {
    const needed = Math.max(0, targetReplicaCount - replicas.size);
    const remainingAttempts = Math.max(0, Number(maxAttempts || DEFAULT_MAX_REPLICA_ATTEMPTS) - attempts);
    const limit = Math.max(1, Math.min(needed, remainingAttempts));

    const targets =
      node.selectReplicaTargets?.({
        exclude: unique([...replicas, ...attempted]),
        limit,
      }) || [];

    if (!targets.length) break;

    for (const peerId of targets) {
      attempted.add(peerId);
    }

    attempts += targets.length;

    try {
      const result = await node.putChunkOnNetwork?.(chunkPayload, targets);

      for (const peerId of result?.replicas || []) {
        replicas.add(peerId);
      }

      for (const failure of result?.failedReplicas || []) {
        failedReplicas.push(failure);
      }
    } catch (error) {
      for (const peerId of targets) {
        failedReplicas.push({
          peerId,
          chunkHash: chunkPayload.hash,
          error: error?.message || String(error),
        });
      }

      console.warn(
        '[replication] confirmed upload attempt failed:',
        chunkPayload.hash,
        targets.join(', '),
        error?.message || error
      );
    }
  }

  return {
    replicas: unique(Array.from(replicas)),
    failedReplicas,
    targetReplicas: targetReplicaCount,
    complete: replicas.size >= targetReplicaCount,
  };
}

async function replicateChunkConfirmed(
  node,
  chunkPayload,
  existingReplicas = [],
  configuredTargetReplicas = DEFAULT_TARGET_REPLICAS
) {
  const result = await replicateChunkUntilConfirmed({
    node,
    chunkPayload,
    existingReplicas,
    configuredTargetReplicas,
    maxAttempts: DEFAULT_MAX_REPLICA_ATTEMPTS,
  });

  if (result.failedReplicas?.length) {
    console.warn(
      '[repair] failed confirmed replicas:',
      chunkPayload.hash,
      result.failedReplicas.map((entry) => `${entry.peerId}:${entry.error || 'unknown'}`).join(', ')
    );
  }

  return result.replicas;
}

export function countUnderReplicatedChunks(
  node,
  manifests = [],
  configuredTargetReplicas = DEFAULT_TARGET_REPLICAS
) {
  // Count against full target = 4, not just currently connected peers.
  // This is important so repair can upload to safety peer when peers are fewer than 4.
  const fullTargetReplicas = configuredReplicaCount(configuredTargetReplicas);
  let count = 0;

  for (const manifest of manifests || []) {
    for (const chunk of manifest.chunks || []) {
      const healthyReplicas = getHealthyReplicas(node, chunk.hash, chunk.replicas);

      if (healthyReplicas.length < fullTargetReplicas) {
        count += 1;
      }
    }
  }

  return count;
}

async function tryLoadChunkForRepair(node, chunkMeta) {
  let chunk = node.getLocalChunk?.(chunkMeta.hash) || null;
  let source = chunk ? 'local' : null;

  if (chunk) {
    return { chunk, source };
  }

  try {
    chunk = await node.fetchChunkFromNetwork(chunkMeta.hash);
    node.storeLocalChunk?.(chunk);
    source = 'network';
    return { chunk, source };
  } catch (error) {
    console.warn(
      '[repair] network chunk unavailable, trying safety peer:',
      chunkMeta.hash,
      error?.message || error
    );
  }

  try {
    chunk = await getChunkFromSafetyPeer(chunkMeta.hash, node.peerId);
    node.storeLocalChunk?.(chunk);
    source = 'safety-peer';
    return { chunk, source };
  } catch (safetyError) {
    console.warn(
      '[repair] safety peer chunk unavailable:',
      chunkMeta.hash,
      safetyError?.message || safetyError
    );
  }

  return { chunk: null, source: null };
}

async function ensureSafetyPeerForChunk({ node, chunkMeta, chunk }) {
  try {
    const result = await putChunkToSafetyPeer(withSafetyFlags(chunk), node.peerId);

    if (result?.ok) {
      chunkMeta.replicas = unique([...(chunkMeta.replicas || []), SAFETY_PEER_REPLICA_ID]);
      chunkMeta.safetyPeer = {
        enabled: true,
        status: 'emergency-protected',
        replicaId: SAFETY_PEER_REPLICA_ID,
        updatedAt: new Date().toISOString(),
      };

      return { changed: true, safetyStatus: 'uploaded' };
    }

    return {
      changed: false,
      safetyStatus: result?.skipped ? `skipped:${result.reason || 'unknown'}` : 'not-uploaded',
    };
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

async function deleteSafetyPeerForChunk({ node, chunkMeta }) {
  try {
    const result = await deleteChunkFromSafetyPeer(chunkMeta.hash, node.peerId);

    chunkMeta.replicas = withoutSafetyReplica(chunkMeta.replicas || []);
    chunkMeta.safetyPeer = {
      enabled: false,
      status: result?.alreadyMissing ? 'already-missing-after-4-peer-replicas' : 'deleted-after-4-peer-replicas',
      replicaId: SAFETY_PEER_REPLICA_ID,
      updatedAt: new Date().toISOString(),
    };

    return { changed: true, safetyStatus: result?.alreadyMissing ? 'already-missing' : 'deleted' };
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
}

export async function repairManifests({
  node,
  manifests = [],
  configuredTargetReplicas = DEFAULT_TARGET_REPLICAS,
  persistManifests,
  syncPush,
}) {
  if (!node) throw new Error('P2P node is required for repair');

  const activeTargetReplicas = getTargetReplicaCount(node, configuredTargetReplicas);
  const fullTargetReplicas = configuredReplicaCount(configuredTargetReplicas);

  const report = [];
  let changed = false;

  for (const manifest of manifests || []) {
    const fileReplicas = new Set(withoutSafetyReplica(manifest.replicas || [node.peerId]));

    for (const chunkMeta of manifest.chunks || []) {
      const before = getHealthyReplicas(node, chunkMeta.hash, chunkMeta.replicas);
      let after = before;
      let source = null;
      let safetyStatus = 'unchanged';

      const loaded = await tryLoadChunkForRepair(node, chunkMeta);
      const chunk = loaded.chunk;
      source = loaded.source;

      if (chunk) {
        after = await replicateChunkConfirmed(node, chunk, before, configuredTargetReplicas);

        const peerReplicas = withoutSafetyReplica(after);

        // أقل من 4 peers confirmed:
        // AWS يمسك نسخة emergency.
        if (peerReplicas.length < fullTargetReplicas) {
          const safety = await ensureSafetyPeerForChunk({
            node,
            chunkMeta,
            chunk,
          });

          changed = changed || safety.changed;
          safetyStatus = safety.safetyStatus;
        }

        // وصلنا 4 peers confirmed:
        // AWS يحذف نسخة safety.
        if (peerReplicas.length >= fullTargetReplicas) {
          const safety = await deleteSafetyPeerForChunk({
            node,
            chunkMeta,
          });

          changed = changed || safety.changed;
          safetyStatus = safety.safetyStatus;
        }

        const keepSafety = unique(chunkMeta.replicas || []).includes(SAFETY_PEER_REPLICA_ID);

        const nextReplicas = unique([
          ...peerReplicas,
          ...(keepSafety ? [SAFETY_PEER_REPLICA_ID] : []),
        ]);

        const oldKey = unique(chunkMeta.replicas || []).sort().join('|');
        const newKey = nextReplicas.sort().join('|');

        if (oldKey !== newKey) {
          chunkMeta.replicas = nextReplicas;
          changed = true;
        }

        chunkMeta.replicationStatus =
          peerReplicas.length >= fullTargetReplicas ? 'protected' : 'protecting';

        chunkMeta.confirmedReplicas = peerReplicas.length;
        chunkMeta.targetReplicas = fullTargetReplicas;
        chunkMeta.activeTargetReplicas = activeTargetReplicas;
        chunkMeta.safetyStatus = safetyStatus;
        chunkMeta.replicationUpdatedAt = new Date().toISOString();

        for (const peerId of peerReplicas) {
          fileReplicas.add(peerId);
        }
      } else {
        chunkMeta.replicationStatus = 'missing-source';
        chunkMeta.confirmedReplicas = before.length;
        chunkMeta.targetReplicas = fullTargetReplicas;
        chunkMeta.activeTargetReplicas = activeTargetReplicas;
        chunkMeta.safetyStatus = 'missing-source';
        chunkMeta.replicationUpdatedAt = new Date().toISOString();
        changed = true;
      }

      report.push({
        file: manifest.name,
        hash: manifest.hash,
        chunkHash: chunkMeta.hash,
        chunkIndex: chunkMeta.index,
        source,
        healthyReplicas: unique(after),
        targetReplicas: fullTargetReplicas,
        activeTargetReplicas,
        safetyStatus,
        underReplicated: unique(after).length < fullTargetReplicas,
        repaired: Boolean(chunk && unique(after).length > unique(before).length),
      });
    }

    const nextFileReplicas = unique(Array.from(fileReplicas));
    const oldFileKey = withoutSafetyReplica(manifest.replicas || []).sort().join('|');
    const newFileKey = nextFileReplicas.sort().join('|');

    if (oldFileKey !== newFileKey) {
      manifest.replicas = nextFileReplicas;
      changed = true;
    }

    const chunks = manifest.chunks || [];

    if (chunks.length) {
      const protectedChunks = chunks.filter((chunk) => {
        return Number(chunk.confirmedReplicas || 0) >= fullTargetReplicas;
      }).length;

      const nextStatus = protectedChunks === chunks.length ? 'protected' : 'protecting';

      if (
        manifest.replicationStatus !== nextStatus ||
        manifest.protectedChunks !== protectedChunks ||
        manifest.targetReplicas !== fullTargetReplicas
      ) {
        manifest.replicationStatus = nextStatus;
        manifest.protectedChunks = protectedChunks;
        manifest.targetReplicas = fullTargetReplicas;
        manifest.activeTargetReplicas = activeTargetReplicas;
        manifest.replicationUpdatedAt = new Date().toISOString();
        changed = true;
      }
    }
  }

  if (changed) {
    persistManifests?.();

    if (typeof syncPush === 'function') {
      for (const manifest of manifests || []) {
        await syncPush(manifest);
      }
    }
  }

  return {
    changed,
    report,
  };
}
