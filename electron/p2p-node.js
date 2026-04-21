import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webRTC } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { kadDHT } from '@libp2p/kad-dht';
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
    this.bootstrapPeers = [
      '/dns4/node1.p2pcloud.net/tcp/443/wss',
      '/dns4/node2.p2pcloud.net/tcp/443/wss'
    ];
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
      transports: [tcp(), webRTC(), webSockets()],
      connectionEncryption: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        dht: kadDHT(),
        pubsub: gossipsub({ allowPublishToZeroPeers: true, emitSelf: false }),
      },
    });

    await this.node.start();
    this.started = true;

    for (const addr of this.bootstrapPeers) {
      try {
        await this.node.dial(addr);
      } catch {}
    }

    await this.announceNode();
    this.startRepairLoop();
    this.broadcast();
    return this.getStatus();
  }

  createChecksum(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}
