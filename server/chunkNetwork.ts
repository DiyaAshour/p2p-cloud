import fs from "fs";
import { getChunkPath } from "./chunking";

export type ChunkPeer = {
  peerId: string;
  url: string;
};

export type ChunkReplicationResult = {
  peerId: string;
  ok: boolean;
  latencyMs: number;
};

const API_KEY = process.env.P2P_API_KEY || "";

function peerHeaders(extra: HeadersInit = {}) {
  return API_KEY ? { ...extra, "x-p2p-api-key": API_KEY } : extra;
}

function normalizePeerUrl(url: string) {
  return url.replace(/\/+$/, "");
}

export async function sendChunkToPeer(options: {
  chunksDir: string;
  chunkHash: string;
  peer: ChunkPeer;
}) {
  const startedAt = Date.now();
  const chunkPath = getChunkPath(options.chunksDir, options.chunkHash);

  if (!fs.existsSync(chunkPath)) {
    return { peerId: options.peer.peerId, ok: false, latencyMs: 0 } satisfies ChunkReplicationResult;
  }

  try {
    const form = new FormData();
    form.append("chunk", new Blob([fs.readFileSync(chunkPath)]), options.chunkHash);

    const response = await fetch(`${normalizePeerUrl(options.peer.url)}/api/p2p/chunks/${options.chunkHash}`, {
      method: "POST",
      headers: peerHeaders(),
      body: form,
    });

    return {
      peerId: options.peer.peerId,
      ok: response.ok,
      latencyMs: Date.now() - startedAt,
    } satisfies ChunkReplicationResult;
  } catch {
    return {
      peerId: options.peer.peerId,
      ok: false,
      latencyMs: Date.now() - startedAt,
    } satisfies ChunkReplicationResult;
  }
}

export async function fetchChunkFromPeer(options: {
  chunksDir: string;
  chunkHash: string;
  peer: ChunkPeer;
  verify: (buffer: Buffer) => string;
}) {
  const startedAt = Date.now();

  try {
    const response = await fetch(`${normalizePeerUrl(options.peer.url)}/api/p2p/chunks/${options.chunkHash}`, {
      headers: peerHeaders(),
    });

    if (!response.ok) {
      return { peerId: options.peer.peerId, ok: false, latencyMs: Date.now() - startedAt };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (options.verify(buffer) !== options.chunkHash) {
      return { peerId: options.peer.peerId, ok: false, latencyMs: Date.now() - startedAt };
    }

    fs.writeFileSync(getChunkPath(options.chunksDir, options.chunkHash), buffer);

    return { peerId: options.peer.peerId, ok: true, latencyMs: Date.now() - startedAt };
  } catch {
    return { peerId: options.peer.peerId, ok: false, latencyMs: Date.now() - startedAt };
  }
}
