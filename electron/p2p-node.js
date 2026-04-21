import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webRTC } from '@libp2p/webrtc';
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

const FILE_REQUEST_PROTOCOL = '/p2p-cloud/file-exchange/1.0.0';
const FILE_TOPIC = 'p2p-cloud/files';

export class ElectronP2PNode {
  constructor(options = {}) {
    this.node = null;
    this.started = false;
    this.vaultDir = options.vaultDir;
    this.metadata = new Map();
    this.remoteIndex = new Map();
    this.subscribers = new Set();
  }

  async start() {
    if (this.started) {
      return this.getStatus();
    }

    this.node = await createLibp2p({
      transports: [tcp(), webRTC()],
      connectionEncryption: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        dht: kadDHT(),
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

    this.node.services.pubsub.subscribe(FILE_TOPIC);
    this.node.services.pubsub.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(uint8ArrayToString(event.detail.data));
        if (!payload?.hash || !payload?.peerId) return;
        this.remoteIndex.set(payload.hash, payload);
        this.broadcast();
      } catch {
        // ignore malformed payloads
      }
    });

    await this.node.start();
    this.started = true;
    this.broadcast();
    return this.getStatus();
  }

  async stop() {
    if (!this.node || !this.started) return;
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
    };
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

    const parsed = JSON.parse(response);
    if (!parsed.ok) {
      return null;
    }

    return {
      metadata: parsed.metadata,
      buffer: parsed.file,
    };
  }
}

export { FILE_REQUEST_PROTOCOL, FILE_TOPIC };
