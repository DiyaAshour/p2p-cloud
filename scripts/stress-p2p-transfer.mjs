import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startP2PTransport } from '../electron/p2p-transport.js';

const NODES = Number(process.env.P2P_TRANSFER_STRESS_NODES || 8);
const BASE_PORT = Number(process.env.P2P_TRANSFER_STRESS_BASE_PORT || 29000);
const CHUNKS = Number(process.env.P2P_TRANSFER_STRESS_CHUNKS || 25);
const CHUNK_BYTES = Number(process.env.P2P_TRANSFER_STRESS_CHUNK_BYTES || 256 * 1024);
const REPLICAS = Number(process.env.P2P_TRANSFER_STRESS_REPLICAS || 3);
const TMP_ROOT = process.env.P2P_TRANSFER_STRESS_DIR || path.join(os.tmpdir(), `p2p-transfer-stress-${Date.now()}`);

const stats = {
  startedAt: Date.now(),
  nodes: 0,
  connectionsAttempted: 0,
  chunksStored: 0,
  chunksFetched: 0,
  failures: [],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeChunk(index) {
  const data = crypto.randomBytes(CHUNK_BYTES);
  return {
    index,
    size: data.length,
    hash: crypto.createHash('sha256').update(data).digest('hex'),
    data: data.toString('base64'),
  };
}

async function main() {
  fs.mkdirSync(TMP_ROOT, { recursive: true });

  const nodes = Array.from({ length: NODES }, (_, index) => {
    const port = BASE_PORT + index;
    const dir = path.join(TMP_ROOT, `node-${index}`, 'chunks');
    const node = startP2PTransport({
      peerId: `stress-node-${index}`,
      port,
      host: '127.0.0.1',
      publicUrl: `ws://127.0.0.1:${port}`,
      chunkStoreDir: dir,
    });
    stats.nodes += 1;
    return node;
  });

  await sleep(1000);

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = 0; j < nodes.length; j += 1) {
      if (i === j) continue;
      if (j > i + 3) continue;
      stats.connectionsAttempted += 1;
      try {
        nodes[i].connectPeer({ peerId: nodes[j].peerId, url: `ws://127.0.0.1:${nodes[j].port}` });
      } catch (error) {
        stats.failures.push({ stage: 'connect', from: i, to: j, error: error.message });
      }
    }
  }

  await sleep(2000);

  const source = nodes[0];
  const sink = nodes[nodes.length - 1];
  const chunks = Array.from({ length: CHUNKS }, (_, index) => makeChunk(index));

  for (const chunk of chunks) {
    source.storeLocalChunk(chunk);
    try {
      const targets = source.selectReplicaTargets({ exclude: [source.peerId], limit: REPLICAS });
      const result = await source.putChunkOnNetwork(chunk, targets);
      if (result.replicas?.length) stats.chunksStored += 1;
      else stats.failures.push({ stage: 'store', chunk: chunk.hash, error: 'no replicas acked' });
    } catch (error) {
      stats.failures.push({ stage: 'store', chunk: chunk.hash, error: error.message });
    }
  }

  await sleep(1000);

  for (const chunk of chunks) {
    try {
      const fetched = await sink.fetchChunkFromNetwork(chunk.hash);
      if (fetched?.hash === chunk.hash) stats.chunksFetched += 1;
      else stats.failures.push({ stage: 'fetch', chunk: chunk.hash, error: 'hash mismatch' });
    } catch (error) {
      stats.failures.push({ stage: 'fetch', chunk: chunk.hash, error: error.message });
    }
  }

  for (const node of nodes) node.stop();

  const elapsedSeconds = Math.max(0.001, (Date.now() - stats.startedAt) / 1000);
  console.log(JSON.stringify({
    ...stats,
    elapsedSeconds,
    tmpRoot: TMP_ROOT,
    configured: { NODES, BASE_PORT, CHUNKS, CHUNK_BYTES, REPLICAS },
    successRate: CHUNKS ? stats.chunksFetched / CHUNKS : 0,
  }, null, 2));

  if (stats.chunksFetched !== CHUNKS) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
