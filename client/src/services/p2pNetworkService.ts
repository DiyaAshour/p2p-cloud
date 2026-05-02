import type { ChunkRecord, FileManifest } from './p2pChunkService';

export interface NetworkPeer {
  peerId: string;
  address?: string;
  port?: number;
  status: 'connecting' | 'connected' | 'disconnected';
  lastSeen: number;
  latencyMs?: number;
  capabilities: Array<'chunk-store' | 'manifest-index' | 'relay'>;
}

export interface NetworkMessage<T = unknown> {
  id: string;
  type: 'peer:hello' | 'peer:goodbye' | 'chunk:put' | 'chunk:get' | 'chunk:found' | 'manifest:broadcast' | 'network:broadcast';
  fromPeerId: string;
  toPeerId?: string;
  createdAt: number;
  payload: T;
}

export interface ChunkPutPayload {
  manifestHash: string;
  chunk: ChunkRecord;
}

export interface ChunkGetPayload {
  manifestHash: string;
  chunkHash: string;
}

export interface ChunkFoundPayload {
  manifestHash: string;
  chunk: ChunkRecord;
}

export interface ManifestBroadcastPayload {
  manifest: FileManifest;
}

type MessageHandler<T = unknown> = (message: NetworkMessage<T>) => void | Promise<void>;

const PEERS_KEY = 'p2p-cloud-network-peers-v1';
const OUTBOX_KEY = 'p2p-cloud-network-outbox-v1';

class P2PNetworkService {
  private localPeerId = '';
  private peers = new Map<string, NetworkPeer>();
  private chunkStore = new Map<string, ChunkRecord>();
  private manifestStore = new Map<string, FileManifest>();
  private handlers = new Map<NetworkMessage['type'], Set<MessageHandler<any>>>();
  private outbox: NetworkMessage[] = [];

  initialize(localPeerId: string): void {
    this.localPeerId = localPeerId;
    this.loadPeers();
    this.loadOutbox();

    this.on<ChunkPutPayload>('chunk:put', (message) => {
      this.chunkStore.set(message.payload.chunk.hash, message.payload.chunk);
      this.touchPeer(message.fromPeerId);
    });

    this.on<ManifestBroadcastPayload>('manifest:broadcast', (message) => {
      this.manifestStore.set(message.payload.manifest.fileHash, message.payload.manifest);
      this.touchPeer(message.fromPeerId);
    });

    this.on<NetworkPeer>('peer:hello', (message) => {
      const peer = message.payload;
      this.peers.set(peer.peerId, {
        ...peer,
        status: 'connected',
        lastSeen: Date.now(),
      });
      this.savePeers();
    });
  }

  connectPeer(peer: Omit<NetworkPeer, 'status' | 'lastSeen'>): NetworkPeer {
    if (!this.localPeerId) {
      throw new Error('P2P network is not initialized');
    }

    const startedAt = performance.now();
    const connectedPeer: NetworkPeer = {
      ...peer,
      status: 'connected',
      lastSeen: Date.now(),
      latencyMs: Math.round(performance.now() - startedAt),
    };

    this.peers.set(peer.peerId, connectedPeer);
    this.savePeers();

    this.emit({
      id: crypto.randomUUID(),
      type: 'peer:hello',
      fromPeerId: this.localPeerId,
      toPeerId: peer.peerId,
      createdAt: Date.now(),
      payload: this.getLocalPeer(),
    });

    return connectedPeer;
  }

  disconnectPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    this.peers.set(peerId, {
      ...peer,
      status: 'disconnected',
      lastSeen: Date.now(),
    });
    this.savePeers();

    this.emit({
      id: crypto.randomUUID(),
      type: 'peer:goodbye',
      fromPeerId: this.localPeerId,
      toPeerId: peerId,
      createdAt: Date.now(),
      payload: { peerId },
    });
  }

  getPeers(): NetworkPeer[] {
    return Array.from(this.peers.values()).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  getConnectedPeers(): NetworkPeer[] {
    return this.getPeers().filter((peer) => peer.status === 'connected');
  }

  async sendChunk(peerId: string, manifestHash: string, chunk: ChunkRecord): Promise<NetworkMessage<ChunkPutPayload>> {
    this.assertConnected(peerId);

    const message: NetworkMessage<ChunkPutPayload> = {
      id: crypto.randomUUID(),
      type: 'chunk:put',
      fromPeerId: this.localPeerId,
      toPeerId: peerId,
      createdAt: Date.now(),
      payload: { manifestHash, chunk },
    };

    this.queueMessage(message);
    await this.emit(message);
    this.markChunkPeer(chunk.hash, peerId);

    return message;
  }

  async requestChunk(peerId: string, manifestHash: string, chunkHash: string): Promise<ChunkRecord | null> {
    this.assertConnected(peerId);

    const request: NetworkMessage<ChunkGetPayload> = {
      id: crypto.randomUUID(),
      type: 'chunk:get',
      fromPeerId: this.localPeerId,
      toPeerId: peerId,
      createdAt: Date.now(),
      payload: { manifestHash, chunkHash },
    };

    this.queueMessage(request);
    await this.emit(request);

    const localChunk = this.chunkStore.get(chunkHash);
    if (!localChunk) {
      return null;
    }

    const response: NetworkMessage<ChunkFoundPayload> = {
      id: crypto.randomUUID(),
      type: 'chunk:found',
      fromPeerId: peerId,
      toPeerId: this.localPeerId,
      createdAt: Date.now(),
      payload: { manifestHash, chunk: localChunk },
    };

    await this.emit(response);
    return localChunk;
  }

  async broadcastManifest(manifest: FileManifest): Promise<NetworkMessage<ManifestBroadcastPayload>[]> {
    this.manifestStore.set(manifest.fileHash, manifest);

    const messages = this.getConnectedPeers().map((peer) => ({
      id: crypto.randomUUID(),
      type: 'manifest:broadcast' as const,
      fromPeerId: this.localPeerId,
      toPeerId: peer.peerId,
      createdAt: Date.now(),
      payload: { manifest },
    }));

    for (const message of messages) {
      this.queueMessage(message);
      await this.emit(message);
    }

    return messages;
  }

  async broadcast<T = unknown>(payload: T): Promise<NetworkMessage<T>[]> {
    const messages = this.getConnectedPeers().map((peer) => ({
      id: crypto.randomUUID(),
      type: 'network:broadcast' as const,
      fromPeerId: this.localPeerId,
      toPeerId: peer.peerId,
      createdAt: Date.now(),
      payload,
    }));

    for (const message of messages) {
      this.queueMessage(message);
      await this.emit(message);
    }

    return messages;
  }

  storeLocalChunk(chunk: ChunkRecord): void {
    this.chunkStore.set(chunk.hash, chunk);
  }

  storeLocalChunks(chunks: ChunkRecord[]): void {
    chunks.forEach((chunk) => this.storeLocalChunk(chunk));
  }

  getLocalChunk(chunkHash: string): ChunkRecord | null {
    return this.chunkStore.get(chunkHash) || null;
  }

  storeManifest(manifest: FileManifest): void {
    this.manifestStore.set(manifest.fileHash, manifest);
  }

  getManifest(fileHash: string): FileManifest | null {
    return this.manifestStore.get(fileHash) || null;
  }

  on<T = unknown>(type: NetworkMessage['type'], handler: MessageHandler<T>): () => void {
    const existing = this.handlers.get(type) || new Set();
    existing.add(handler);
    this.handlers.set(type, existing);

    return () => {
      existing.delete(handler);
    };
  }

  async flushOutbox(): Promise<void> {
    const pending = [...this.outbox];
    this.outbox = [];
    this.saveOutbox();

    for (const message of pending) {
      await this.emit(message);
    }
  }

  private async emit<T = unknown>(message: NetworkMessage<T>): Promise<void> {
    const handlers = this.handlers.get(message.type);
    if (!handlers) return;

    await Promise.all(Array.from(handlers).map((handler) => handler(message)));
  }

  private queueMessage(message: NetworkMessage): void {
    this.outbox.push(message);
    this.saveOutbox();
  }

  private assertConnected(peerId: string): void {
    if (!this.localPeerId) {
      throw new Error('P2P network is not initialized');
    }

    const peer = this.peers.get(peerId);
    if (!peer || peer.status !== 'connected') {
      throw new Error(`Peer is not connected: ${peerId}`);
    }
  }

  private markChunkPeer(chunkHash: string, peerId: string): void {
    const chunk = this.chunkStore.get(chunkHash);
    if (!chunk) return;

    if (!chunk.peers.includes(peerId)) {
      chunk.peers.push(peerId);
    }
  }

  private touchPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    this.peers.set(peerId, {
      ...peer,
      lastSeen: Date.now(),
      status: 'connected',
    });
    this.savePeers();
  }

  private getLocalPeer(): NetworkPeer {
    return {
      peerId: this.localPeerId,
      status: 'connected',
      lastSeen: Date.now(),
      capabilities: ['chunk-store', 'manifest-index'],
    };
  }

  private savePeers(): void {
    localStorage.setItem(PEERS_KEY, JSON.stringify(this.getPeers()));
  }

  private loadPeers(): void {
    try {
      const raw = localStorage.getItem(PEERS_KEY);
      if (!raw) return;

      const peers = JSON.parse(raw) as NetworkPeer[];
      peers.forEach((peer) => {
        if (peer.peerId !== this.localPeerId) {
          this.peers.set(peer.peerId, {
            ...peer,
            status: peer.status === 'connected' ? 'disconnected' : peer.status,
          });
        }
      });
    } catch (error) {
      console.warn('Failed to load network peers:', error);
    }
  }

  private saveOutbox(): void {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(this.outbox.slice(-200)));
  }

  private loadOutbox(): void {
    try {
      const raw = localStorage.getItem(OUTBOX_KEY);
      this.outbox = raw ? JSON.parse(raw) : [];
    } catch {
      this.outbox = [];
    }
  }
}

export const p2pNetworkService = new P2PNetworkService();
