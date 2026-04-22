import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import { pipe } from 'it-pipe';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE_REQUEST_PROTOCOL = '/p2p-cloud/file-exchange/1.0.0';
const CHUNK_STORE_PROTOCOL = '/p2p-cloud/chunk-store/1.0.0';
const CHUNK_REQUEST_PROTOCOL = '/p2p-cloud/chunk-request/1.0.0';
const FILE_TOPIC = 'p2p-cloud/files';
const NODE_TOPIC = 'p2p-cloud/nodes';
const DEFAULT_BOOTSTRAP = '/ip4/13.51.69.60/tcp/4001';
const DEFAULT_PORT = 4001;

export class ElectronP2PNode {
  constructor(options = {}) {
    this.node = null;
    this.started = false;
    this.vaultDir = options.vaultDir;
    this.chunkDir = path.join(this.vaultDir, 'chunks');
    this.metadata = new Map();
    this.remoteIndex = new Map();
    this.remoteNodes = new Map();
    this.localChunks = new Map();
    this.subscribers = new Set();
    this.repairTimer = null;
    this.listenPort = Number(process.env.P2P_PORT || options.port || DEFAULT_PORT);
    this.bootstrapPeers = [process.env.P2P_BOOTSTRAP_ADDR || options.bootstrapAddr || DEFAULT_BOOTSTRAP].filter(Boolean);
    this.config = {
      walletAddress: null,
      totalSharedBytes: 5 * 1024 * 1024 * 1024,
      acceptsNetworkStorage: true,
      archiveOwnFilesLocally: true,
      defaultReplicationFactor: 2,
      ...(options.config || {}),
    };
  }

  async ensureDirs() {
    await fs.mkdir(this.vaultDir, { recursive: true });
    await fs.mkdir(this.chunkDir, { recursive: true });
  }

  async start() {
    if (this.started) {
      return this.getStatus();
    }

    await this.ensureDirs();

    this.node = await createLibp2p({
      addresses: {
        listen: [
          `/ip4/0.0.0.0/tcp/${this.listenPort}`,
        ],
      },
      transports: [tcp(), webSockets()],
      connectionEncryption: [noise()],
      streamMuxers: [yamux()],
      services: {
        pubsub: gossipsub({
          allowPublishToZeroPeers: true,
          emitSelf: false,
        }),
      },
    });

    this.node.handle(FILE_REQUEST_PROTOCOL, async ({ stream }) => {
      await pipe(
        stream,
        async function* (source) {
          for await (const chunk of source) {
            const fileHash = uint8ArrayToString(chunk.subarray ? chunk.subarray() : chunk);
            const entry = this.metadata.get(fileHash);
            if (!entry) {
              yield uint8ArrayFromString(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
              continue;
            }

            try {
              const filePath = path.join(this.vaultDir, entry.path);
              const fileBuffer = await fs.readFile(filePath);
              yield uint8ArrayFromString(
                JSON.stringify({
                  ok: true,
                  file: fileBuffer.toString('base64'),
                  metadata: entry,
                })
              );
            } catch {
              yield uint8ArrayFromString(JSON.stringify({ ok: false, error: 'READ_FAILED' }));
            }
          }
        }.bind(this)
      );
    });

    this.node.handle(CHUNK_STORE_PROTOCOL, async ({ stream }) => {
      let raw = '';
      await pipe(
        stream,
        async (source) => {
          for await (const chunk of source) {
            raw += uint8ArrayToString(chunk.subarray ? chunk.subarray() : chunk);
          }
        }
      );

      const payload = JSON.parse(raw || '{}');
      const stored = await this.storeChunk(payload);
      await pipe([uint8ArrayFromString(JSON.stringify(stored))], stream);
    });

    this.node.handle(CHUNK_REQUEST_PROTOCOL, async ({ stream }) => {
      let raw = '';
      await pipe(
        stream,
        async (source) => {
          for await (const chunk of source) {
            raw += uint8ArrayToString(chunk.subarray ? chunk.subarray() : chunk);
          }
        }
      );

      const payload = JSON.parse(raw || '{}');
      const chunkRecord = await this.readChunk(payload.chunkId);
      await pipe(
        [uint8ArrayFromString(JSON.stringify(chunkRecord || { ok: false, error: 'NOT_FOUND' }))],
        stream
      );
    });

    this.node.services.pubsub.subscribe(FILE_TOPIC);
    this.node.services.pubsub.subscribe(NODE_TOPIC);

    this.node.services.pubsub.addEventListener('message', (event) => {
      try {
        const topic = event.detail.topic;
        const payload = JSON.parse(uint8ArrayToString(event.detail.data));

        if (topic === FILE_TOPIC && payload?.hash && payload?.peerId) {
          this.remoteIndex.set(payload.hash, payload);
        }

        if (topic === NODE_TOPIC && payload?.peerId) {
          this.remoteNodes.set(payload.peerId, payload);
        }

        this.broadcast();
      } catch {
        // ignore malformed payloads
      }
    });

    await this.node.start();
    this.started = true;

    for (const addr of this.bootstrapPeers) {
      try {
        await this.node.dial(addr);
      } catch {
        // ignore unavailable bootstrap peers
      }
    }

    await this.announceNode();
    this.startRepairLoop();
    this.broadcast();
    return this.getStatus();
  }

  async stop() {
    if (!this.node || !this.started) return;
    if (this.repairTimer) {
      clearInterval(this.repairTimer);
      this.repairTimer = null;
    }
    await this.node.stop();
    this.started = false;
    this.broadcast();
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  broadcast() {
    const status = this.getStatus();
    for (const listener of this.subscribers) {
      listener(status);
    }
  }

  getStatus() {
    return {
      started: this.started,
      peerId: this.node?.peerId?.toString?.() || null,
      peers: this.node?.getConnections?.().length || 0,
      localFiles: this.metadata.size,
      remoteFiles: this.remoteIndex.size,
      localChunks: this.localChunks.size,
      sharedCapacityBytes: this.config.totalSharedBytes,
      acceptsNetworkStorage: this.config.acceptsNetworkStorage,
      knownNodes: Array.from(this.remoteNodes.values()),
    };
  }

  async updateConfig(nextConfig) {
    this.config = {
      ...this.config,
      ...nextConfig,
    };
    await this.announceNode();
    this.broadcast();
    return this.getStatus();
  }

  async announceNode() {
    if (!this.node?.services?.pubsub) return;
    await this.node.services.pubsub.publish(
      NODE_TOPIC,
      uint8ArrayFromString(
        JSON.stringify({
          peerId: this.node.peerId.toString(),
          walletAddress: this.config.walletAddress,
          totalSharedBytes: this.config.totalSharedBytes,
          availableSharedBytes: Math.max(this.config.totalSharedBytes - this.getLocalChunkBytes(), 0),
          acceptsNewChunks: this.config.acceptsNetworkStorage,
          lastSeenAt: Date.now(),
        })
      )
    );
  }

  async announceFile(fileMetadata) {
    this.metadata.set(fileMetadata.hash, fileMetadata);
    if (!this.node?.services?.pubsub) {
      this.broadcast();
      return;
    }

    await this.node.services.pubsub.publish(
      FILE_TOPIC,
      uint8ArrayFromString(
        JSON.stringify({
          hash: fileMetadata.hash,
          name: fileMetadata.name,
          size: fileMetadata.size,
          peerId: this.node.peerId.toString(),
          uploadedAt: fileMetadata.uploadedAt,
          isEncrypted: fileMetadata.isEncrypted,
        })
      )
    );

    this.broadcast();
  }

  async storeChunk(payload) {
    if (!payload?.chunkId || !payload?.base64 || !payload?.checksum) {
      return { ok: false, error: 'INVALID_PAYLOAD' };
    }

    if (!this.config.acceptsNetworkStorage) {
      return { ok: false, error: 'STORAGE_DISABLED' };
    }

    const bytes = Buffer.from(payload.base64, 'base64');
    const actualChecksum = this.createChecksum(bytes);
    if (actualChecksum !== payload.checksum) {
      return { ok: false, error: 'CHECKSUM_MISMATCH' };
    }

    const nextUsage = this.getLocalChunkBytes() + bytes.byteLength;
    if (nextUsage > this.config.totalSharedBytes) {
      return { ok: false, error: 'INSUFFICIENT_CAPACITY' };
    }

    const chunkPath = path.join(this.chunkDir, `${payload.chunkId}.bin`);
    await fs.writeFile(chunkPath, bytes);

    this.localChunks.set(payload.chunkId, {
      chunkId: payload.chunkId,
      fileId: payload.fileId,
      index: payload.index,
      size: bytes.byteLength,
      checksum: payload.checksum,
      encrypted: payload.encrypted,
      storagePeerIds: Array.from(new Set([...(payload.storagePeerIds || []), this.node?.peerId?.toString?.()].filter(Boolean))),
    });

    await this.announceNode();
    this.broadcast();
    return { ok: true, checksum: actualChecksum };
  }

  async readChunk(chunkId) {
    const entry = this.localChunks.get(chunkId);
    if (!entry) {
      return null;
    }

    const chunkPath = path.join(this.chunkDir, `${chunkId}.bin`);
    const data = await fs.readFile(chunkPath);
    const checksum = this.createChecksum(data);
    if (checksum !== entry.checksum) {
      return { ok: false, error: 'CHECKSUM_MISMATCH' };
    }

    return {
      ok: true,
      chunkId,
      base64: data.toString('base64'),
      checksum,
      metadata: entry,
    };
  }

  async sendChunkToPeer(peerId, payload) {
    if (!this.node) {
      throw new Error('P2P node not started');
    }

    const stream = await this.node.dialProtocol(peerId, CHUNK_STORE_PROTOCOL);
    let response = '';
    await pipe(
      [uint8ArrayFromString(JSON.stringify(payload))],
      stream,
      async (source) => {
        for await (const chunk of source) {
          response += uint8ArrayToString(chunk.subarray ? chunk.subarray() : chunk);
        }
      }
    );

    const parsed = JSON.parse(response || '{}');
    return parsed.ok === true;
  }

  async requestChunkFromPeer(peerId, chunkId) {
    if (!this.node) {
      throw new Error('P2P node not started');
    }

    const stream = await this.node.dialProtocol(peerId, CHUNK_REQUEST_PROTOCOL);
    let response = '';
    await pipe(
      [uint8ArrayFromString(JSON.stringify({ chunkId }))],
      stream,
      async (source) => {
        for await (const chunk of source) {
          response += uint8ArrayToString(chunk.subarray ? chunk.subarray() : chunk);
        }
      }
    );

    const parsed = JSON.parse(response || '{}');
    return parsed.ok ? parsed : null;
  }

  async requestRemoteFile(fileHash) {
    if (!this.node) {
      throw new Error('P2P node not started');
    }

    const remoteEntry = this.remoteIndex.get(fileHash);
    if (!remoteEntry?.peerId) {
      return null;
    }

    const stream = await this.node.dialProtocol(remoteEntry.peerId, FILE_REQUEST_PROTOCOL);
    let response = '';
    await pipe(
      [uint8ArrayFromString(fileHash)],
      stream,
      async (source) => {
        for await (const chunk of source) {
          response += uint8ArrayToString(chunk.subarray ? chunk.subarray() : chunk);
        }
      }
    );

    const parsed = JSON.parse(response || '{}');
    if (!parsed.ok) {
      return null;
    }

    return {
      metadata: parsed.metadata,
      buffer: parsed.file,
    };
  }

  startRepairLoop() {
    if (this.repairTimer) {
      clearInterval(this.repairTimer);
    }

    this.repairTimer = setInterval(async () => {
      for (const [chunkId, chunk] of this.localChunks.entries()) {
        const alivePeers = chunk.storagePeerIds.filter((id) =>
          id === this.node?.peerId?.toString?.() || this.remoteNodes.has(id)
        );

        if (alivePeers.length >= this.config.defaultReplicationFactor) {
          continue;
        }

        const data = await this.readChunk(chunkId);
        if (!data?.base64) {
          continue;
        }

        const targets = Array.from(this.remoteNodes.keys())
          .filter((id) => !chunk.storagePeerIds.includes(id))
          .slice(0, this.config.defaultReplicationFactor - alivePeers.length);

        for (const peerId of targets) {
          const ok = await this.sendChunkToPeer(peerId, {
            ...chunk,
            base64: data.base64,
          });

          if (ok) {
            chunk.storagePeerIds.push(peerId);
          }
        }
      }
    }, 15000);
  }

  getLocalChunkBytes() {
    return Array.from(this.localChunks.values()).reduce((sum, chunk) => sum + chunk.size, 0);
  }

  createChecksum(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}

export { FILE_REQUEST_PROTOCOL, CHUNK_STORE_PROTOCOL, CHUNK_REQUEST_PROTOCOL, FILE_TOPIC, NODE_TOPIC };
