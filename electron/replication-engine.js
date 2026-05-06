function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function getTargetReplicaCount(node, configuredTargetReplicas = 3) {
  const connectedPeers = node?.connectedPeerIds?.() || [];
  return Math.max(1, Math.min(Number(configuredTargetReplicas || 3), 1 + connectedPeers.length));
}

export function getHealthyReplicas(node, chunkHash, knownReplicas = []) {
  const replicas = new Set();

  if (node?.getLocalChunk?.(chunkHash)) replicas.add(node.peerId);

  for (const peerId of node?.healthyReplicaIds?.(chunkHash) || []) {
    replicas.add(peerId);
  }

  const onlinePeers = new Set(node?.connectedPeerIds?.() || []);
  for (const peerId of knownReplicas || []) {
    if (peerId === node?.peerId && node?.getLocalChunk?.(chunkHash)) replicas.add(peerId);
    if (onlinePeers.has(peerId)) replicas.add(peerId);
  }

  return unique(Array.from(replicas));
}

export function replicateChunk(node, chunkPayload, existingReplicas = [], configuredTargetReplicas = 3) {
  if (!node) throw new Error('P2P node is required for replication');
  if (!chunkPayload?.hash) throw new Error('chunk.hash is required for replication');

  const targetReplicaCount = getTargetReplicaCount(node, configuredTargetReplicas);
  const replicas = new Set(unique([node.peerId, ...existingReplicas]));

  node.storeLocalChunk?.(chunkPayload);

  const needed = Math.max(0, targetReplicaCount - replicas.size);
  if (needed <= 0) return unique(Array.from(replicas));

  const targets = node.selectReplicaTargets?.({
    exclude: Array.from(replicas),
    limit: needed,
  }) || [];

  if (!targets.length) return unique(Array.from(replicas));

  try {
    const result = node.putChunkOnNetwork?.(chunkPayload, targets);

    if (result && typeof result.then === 'function') {
      result
        .then((ackResult) => {
          if (ackResult?.replicas?.length) {
            console.log('[replication] acknowledged replicas:', chunkPayload.hash, ackResult.replicas.join(', '));
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

export function countUnderReplicatedChunks(node, manifests = [], configuredTargetReplicas = 3) {
  const targetReplicaCount = getTargetReplicaCount(node, configuredTargetReplicas);
  let count = 0;

  for (const manifest of manifests || []) {
    for (const chunk of manifest.chunks || []) {
      const healthyReplicas = getHealthyReplicas(node, chunk.hash, chunk.replicas);
      if (healthyReplicas.length < targetReplicaCount) count += 1;
    }
  }

  return count;
}

export async function repairManifests({ node, manifests = [], configuredTargetReplicas = 3, persistManifests, syncPush }) {
  if (!node) throw new Error('P2P node is required for repair');

  const targetReplicaCount = getTargetReplicaCount(node, configuredTargetReplicas);
  const report = [];
  let changed = false;

  for (const manifest of manifests || []) {
    const fileReplicas = new Set(manifest.replicas || [node.peerId]);

    for (const chunkMeta of manifest.chunks || []) {
      let chunk = node.getLocalChunk?.(chunkMeta.hash) || null;

      if (!chunk) {
        try {
          chunk = await node.fetchChunkFromNetwork(chunkMeta.hash);
          node.storeLocalChunk?.(chunk);
        } catch (error) {
          console.warn('[repair] chunk unavailable:', chunkMeta.hash, error?.message || error);
        }
      }

      const before = getHealthyReplicas(node, chunkMeta.hash, chunkMeta.replicas);
      let after = before;

      if (chunk) {
        after = replicateChunk(node, chunk, before, configuredTargetReplicas);
        const oldKey = unique(chunkMeta.replicas || []).sort().join('|');
        const newKey = unique(after).sort().join('|');
        if (oldKey !== newKey) {
          chunkMeta.replicas = unique(after);
          changed = true;
        }
        for (const peerId of after) fileReplicas.add(peerId);
      }

      report.push({
        file: manifest.name,
        hash: manifest.hash,
        chunkHash: chunkMeta.hash,
        chunkIndex: chunkMeta.index,
        healthyReplicas: unique(after),
        targetReplicas: targetReplicaCount,
        underReplicated: unique(after).length < targetReplicaCount,
        repaired: Boolean(chunk && unique(after).length > unique(before).length),
      });
    }

    const nextFileReplicas = unique(Array.from(fileReplicas));
    const oldFileKey = unique(manifest.replicas || []).sort().join('|');
    const newFileKey = nextFileReplicas.sort().join('|');
    if (oldFileKey !== newFileKey) {
      manifest.replicas = nextFileReplicas;
      changed = true;
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
