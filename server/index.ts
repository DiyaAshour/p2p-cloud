import express from "express";
import { createServer } from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";
import crypto from "node:crypto";
import {
  type ChunkInfo,
  splitFileIntoChunks,
  rebuildFileFromLocalChunks,
  getChunkPath,
  hashBuffer,
} from "./chunking";
import { sendChunkToPeer, fetchChunkFromPeer } from "./chunkNetwork";

const NODE_ID = process.env.P2P_NODE_ID || "node-local";
const PUBLIC_URL = process.env.P2P_PUBLIC_URL || "http://127.0.0.1:3000";
const BOOTSTRAP_URL = process.env.P2P_BOOTSTRAP_URL || "";
const REPLICATION_FACTOR = Number(process.env.P2P_REPLICATION_FACTOR || 3);
const REPAIR_INTERVAL_MS = Number(process.env.P2P_REPAIR_INTERVAL_MS || 30_000);
const PEER_MAX_AGE_MS = Number(process.env.P2P_PEER_MAX_AGE_MS || 5 * 60_000);
const CHUNK_SIZE_BYTES = Number(process.env.P2P_CHUNK_SIZE_BYTES || 4 * 1024 * 1024);
const MAX_PARALLEL_CHUNK_FETCHES = Number(process.env.P2P_MAX_PARALLEL_CHUNK_FETCHES || 8);

type PeerInfo = {
  peerId: string;
  url: string;
  lastSeen: string;
  successCount?: number;
  failureCount?: number;
  latencyMs?: number;
};

let peers: PeerInfo[] = [];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.resolve(__dirname, "..", "uploads");
const chunksDir = path.resolve(__dirname, "..", "chunks");

for (const dir of [uploadsDir, chunksDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const uniquePrefix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    cb(null, `${uniquePrefix}-${safeName}`);
  },
});

const chunkStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const uniquePrefix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    cb(null, `${uniquePrefix}-${safeName}`);
  },
});

const upload = multer({ storage });
const chunkUpload = multer({ storage: chunkStorage });

type StoredFile = {
  id: string;
  name: string;
  size: number;
  hash: string;
  uploadedAt: string;
  path: string;
  isEncrypted: boolean;
  mimeType?: string;
  ownerNodeId: string;
  replicas: string[];
  storageMode?: "file" | "chunks";
  chunkSize?: number;
  chunks?: ChunkInfo[];
};

const dbPath = path.resolve(__dirname, "..", "files_db.json");
const peersDbPath = path.resolve(__dirname, "..", "peers_db.json");
let filesDb: StoredFile[] = [];

if (fs.existsSync(dbPath)) {
  try {
    filesDb = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
  } catch {
    filesDb = [];
  }
}

if (fs.existsSync(peersDbPath)) {
  try {
    peers = JSON.parse(fs.readFileSync(peersDbPath, "utf-8"));
  } catch {
    peers = [];
  }
}

function saveDb() {
  fs.writeFileSync(dbPath, JSON.stringify(filesDb, null, 2));
}

function savePeers() {
  fs.writeFileSync(peersDbPath, JSON.stringify(peers, null, 2));
}

function hashFile(filePath: string) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function scorePeer(peer: PeerInfo) {
  const success = peer.successCount || 0;
  const failure = peer.failureCount || 0;
  const latency = peer.latencyMs || 1_000;
  return success * 100 - failure * 200 - latency;
}

function rankedPeers(skipPeerIds: string[] = []) {
  const skip = new Set([NODE_ID, ...skipPeerIds]);
  return [...peers]
    .filter((peer) => !skip.has(peer.peerId))
    .sort((a, b) => scorePeer(b) - scorePeer(a));
}

function recordPeerResult(peerId: string, ok: boolean, latencyMs: number) {
  const peer = peers.find((entry) => entry.peerId === peerId);
  if (!peer) return;
  peer.lastSeen = new Date().toISOString();
  peer.successCount = (peer.successCount || 0) + (ok ? 1 : 0);
  peer.failureCount = (peer.failureCount || 0) + (ok ? 0 : 1);
  peer.latencyMs = latencyMs;
  savePeers();
}

function pruneStalePeers() {
  const now = Date.now();
  const before = peers.length;

  peers = peers.filter((peer) => {
    const lastSeen = Date.parse(peer.lastSeen || "");
    return Number.isFinite(lastSeen) && now - lastSeen <= PEER_MAX_AGE_MS;
  });

  if (peers.length !== before) {
    savePeers();
  }
}

function upsertPeer(peer: any) {
  if (!peer?.peerId || !peer?.url || peer.peerId === NODE_ID) return;

  const existing = peers.find((entry) => entry.peerId === peer.peerId);
  const normalizedUrl = String(peer.url).replace(/\/+$/, "");

  if (existing) {
    existing.url = normalizedUrl;
    existing.lastSeen = new Date().toISOString();
  } else {
    peers.push({
      peerId: peer.peerId,
      url: normalizedUrl,
      lastSeen: new Date().toISOString(),
      successCount: 0,
      failureCount: 0,
    });
  }

  savePeers();
}

async function registerNode() {
  if (!BOOTSTRAP_URL) return;

  try {
    const response = await fetch(`${BOOTSTRAP_URL}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        peerId: NODE_ID,
        url: PUBLIC_URL,
      }),
    });

    const data = await response.json();
    const discoveredPeers = Array.isArray(data.peers) ? data.peers : [];

    for (const peer of discoveredPeers) {
      upsertPeer(peer);
    }

    pruneStalePeers();
    console.log("connected peers:", peers.length);
  } catch (error) {
    console.log("bootstrap register failed");
  }
}

async function replicate(filePath: string, fileName: string, hash: string, skipPeerIds: string[] = []) {
  const targets = rankedPeers(skipPeerIds).slice(0, Math.max(0, REPLICATION_FACTOR - 1));
  const replicatedTo: string[] = [];

  for (const peer of targets) {
    try {
      const started = Date.now();
      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(filePath)]), fileName);
      form.append("hash", hash);
      form.append("ownerNodeId", NODE_ID);

      const response = await fetch(`${peer.url}/api/p2p/store`, {
        method: "POST",
        body: form,
      });

      recordPeerResult(peer.peerId, response.ok, Date.now() - started);

      if (response.ok) {
        replicatedTo.push(peer.peerId);
        console.log("replicated to", peer.peerId);
      } else {
        console.log("replication failed", peer.peerId);
      }
    } catch {
      recordPeerResult(peer.peerId, false, 0);
      console.log("replication failed", peer.peerId);
    }
  }

  return replicatedTo;
}

async function replicateChunks(chunks: ChunkInfo[]) {
  for (const chunk of chunks) {
    const targets = rankedPeers(chunk.replicas || []).slice(
      0,
      Math.max(0, REPLICATION_FACTOR - (chunk.replicas || []).length)
    );

    const results = await Promise.all(
      targets.map((peer) => sendChunkToPeer({ chunksDir, chunkHash: chunk.hash, peer }))
    );

    for (const result of results) {
      recordPeerResult(result.peerId, result.ok, result.latencyMs);
      if (result.ok && !chunk.replicas.includes(result.peerId)) {
        chunk.replicas.push(result.peerId);
      }
    }
  }
}

async function fetchOneChunkFast(chunk: ChunkInfo) {
  const localPath = getChunkPath(chunksDir, chunk.hash);
  if (fs.existsSync(localPath)) return true;

  const peersToTry = rankedPeers().slice(0, Math.max(1, REPLICATION_FACTOR));
  if (peersToTry.length === 0) return false;

  const attempts = await Promise.all(
    peersToTry.map((peer) => fetchChunkFromPeer({ chunksDir, chunkHash: chunk.hash, peer, verify: hashBuffer }))
  );

  for (const result of attempts) {
    recordPeerResult(result.peerId, result.ok, result.latencyMs);
  }

  return attempts.some((result) => result.ok);
}

async function ensureChunksAvailable(chunks: ChunkInfo[]) {
  const missing = chunks.filter((chunk) => !fs.existsSync(getChunkPath(chunksDir, chunk.hash)));
  if (missing.length === 0) return true;

  for (let i = 0; i < missing.length; i += MAX_PARALLEL_CHUNK_FETCHES) {
    const batch = missing.slice(i, i + MAX_PARALLEL_CHUNK_FETCHES);
    const results = await Promise.all(batch.map((chunk) => fetchOneChunkFast(chunk)));
    if (!results.every(Boolean)) return false;
  }

  return true;
}

async function streamChunksToResponse(res: express.Response, file: StoredFile) {
  if (!file.chunks?.length) return false;

  const orderedChunks = [...file.chunks].sort((a, b) => a.index - b.index);

  for (const chunk of orderedChunks) {
    const chunkPath = getChunkPath(chunksDir, chunk.hash);
    if (!fs.existsSync(chunkPath)) return false;

    const buffer = fs.readFileSync(chunkPath);
    if (hashBuffer(buffer) !== chunk.hash) return false;

    if (!res.write(buffer)) {
      await new Promise<void>((resolve) => res.once("drain", resolve));
    }
  }

  res.end();
  return true;
}

async function repairReplication() {
  pruneStalePeers();

  for (const file of filesDb) {
    if (file.storageMode === "chunks" && file.chunks?.length) {
      await replicateChunks(file.chunks);
      saveDb();
      continue;
    }

    const filePath = path.join(uploadsDir, file.path);
    if (!fs.existsSync(filePath)) continue;

    file.replicas = Array.from(new Set(file.replicas || [NODE_ID]));

    if (!file.replicas.includes(NODE_ID)) {
      file.replicas.push(NODE_ID);
    }

    if (file.replicas.length >= REPLICATION_FACTOR) continue;

    const replicatedTo = await replicate(filePath, file.name, file.hash, file.replicas);

    if (replicatedTo.length > 0) {
      file.replicas = Array.from(new Set([...file.replicas, ...replicatedTo]));
      saveDb();
      console.log(`repaired ${file.name}: ${file.replicas.length}/${REPLICATION_FACTOR}`);
    }
  }
}

function calculateStats() {
  const totalBytes = filesDb.reduce((sum, file) => sum + file.size, 0);
  const encryptedFiles = filesDb.filter((file) => file.isEncrypted).length;
  const underReplicatedFiles = filesDb.filter((file) => {
    if (file.storageMode === "chunks" && file.chunks?.length) {
      return file.chunks.some((chunk) => (chunk.replicas || []).length < REPLICATION_FACTOR);
    }
    return (file.replicas || []).length < REPLICATION_FACTOR;
  }).length;
  const totalChunks = filesDb.reduce((sum, file) => sum + (file.chunks?.length || 0), 0);

  return {
    nodeId: NODE_ID,
    publicUrl: PUBLIC_URL,
    peers: peers.length,
    totalFiles: filesDb.length,
    totalChunks,
    chunkSizeBytes: CHUNK_SIZE_BYTES,
    underReplicatedFiles,
    encryptedFiles,
    publicFiles: filesDb.length - encryptedFiles,
    totalBytes,
    totalMB: Number((totalBytes / 1024 / 1024).toFixed(2)),
  };
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      product: "P2P Cloud",
      mode: "distributed-chunk-http-p2p-node",
      stats: calculateStats(),
    });
  });

  app.post("/api/bootstrap/register", async (_req, res) => {
    await registerNode();
    res.json({ ok: true, peers });
  });

  app.post("/api/repair", async (_req, res) => {
    await repairReplication();
    res.json({ ok: true, stats: calculateStats() });
  });

  app.post("/api/peers/prune", (_req, res) => {
    pruneStalePeers();
    res.json({ ok: true, peers });
  });

  app.post("/api/peers", (req, res) => {
    const { peerId, url } = req.body || {};
    if (!peerId || !url) {
      return res.status(400).json({ error: "peerId and url required" });
    }

    upsertPeer({ peerId, url });
    res.status(201).json({ ok: true, peers });
  });

  app.get("/api/peers", (_req, res) => {
    res.json(peers);
  });

  app.get("/api/chunks/:hash", (req, res) => {
    const chunkPath = getChunkPath(chunksDir, req.params.hash);
    if (!fs.existsSync(chunkPath)) {
      return res.status(404).json({ error: "Chunk not found" });
    }

    res.sendFile(chunkPath);
  });

  app.post("/api/p2p/chunks/:hash", chunkUpload.single("chunk"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "no chunk" });

    const actualHash = hashFile(req.file.path);
    if (actualHash !== req.params.hash) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "chunk hash mismatch" });
    }

    const finalPath = getChunkPath(chunksDir, actualHash);
    if (!fs.existsSync(finalPath)) {
      fs.renameSync(req.file.path, finalPath);
    } else {
      fs.unlinkSync(req.file.path);
    }

    res.status(201).json({ ok: true, hash: actualHash, nodeId: NODE_ID });
  });

  app.get("/api/p2p/chunks/:hash", (req, res) => {
    const chunkPath = getChunkPath(chunksDir, req.params.hash);
    if (!fs.existsSync(chunkPath)) return res.status(404).json({ error: "chunk not found" });
    res.sendFile(chunkPath);
  });

  app.get("/api/manifests/:hash", (req, res) => {
    const file = filesDb.find((entry) => entry.hash === req.params.hash);
    if (!file) return res.status(404).json({ error: "Manifest not found" });

    res.json({
      fileHash: file.hash,
      fileName: file.name,
      fileSize: file.size,
      chunkSize: file.chunkSize,
      chunks: file.chunks || [],
    });
  });

  app.post("/api/p2p/store", upload.single("file"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "no file" });
    }

    const storedPath = path.join(uploadsDir, req.file.filename);
    const hash = req.body.hash || hashFile(storedPath);
    const existing = filesDb.find((entry) => entry.hash === hash);

    if (existing) {
      if (!existing.replicas.includes(NODE_ID)) {
        existing.replicas.push(NODE_ID);
        saveDb();
      }
      return res.json({ ok: true, file: existing, duplicate: true });
    }

    const manifest = splitFileIntoChunks({
      filePath: storedPath,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      chunkSize: CHUNK_SIZE_BYTES,
      chunksDir,
      localNodeId: NODE_ID,
    });

    const fileInfo: StoredFile = {
      id: hash,
      name: req.file.originalname,
      size: req.file.size,
      hash,
      uploadedAt: new Date().toISOString(),
      path: req.file.filename,
      isEncrypted: req.body.isEncrypted === "true",
      mimeType: req.file.mimetype,
      ownerNodeId: req.body.ownerNodeId || "remote",
      replicas: [NODE_ID],
      storageMode: "chunks",
      chunkSize: CHUNK_SIZE_BYTES,
      chunks: manifest.chunks,
    };

    filesDb.push(fileInfo);
    saveDb();
    await replicateChunks(fileInfo.chunks || []);
    saveDb();

    console.log("received replica:", req.file.originalname);

    res.status(201).json({
      ok: true,
      file: fileInfo,
    });
  });

  app.post("/api/upload", upload.single("file"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath = path.join(uploadsDir, req.file.filename);
    const hash = req.body.hash || hashFile(filePath);
    const existing = filesDb.find((entry) => entry.hash === hash);

    if (existing) {
      if (existing.storageMode === "chunks" && existing.chunks?.length) {
        await replicateChunks(existing.chunks);
      } else {
        const replicatedTo = await replicate(filePath, req.file.originalname, hash, existing.replicas);
        existing.replicas = Array.from(new Set([...existing.replicas, ...replicatedTo]));
      }
      saveDb();
      return res.json({ ...existing, duplicate: true });
    }

    const manifest = splitFileIntoChunks({
      filePath,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      chunkSize: CHUNK_SIZE_BYTES,
      chunksDir,
      localNodeId: NODE_ID,
    });

    const fileInfo: StoredFile = {
      id: hash,
      name: req.file.originalname,
      size: req.file.size,
      hash,
      uploadedAt: new Date().toISOString(),
      path: req.file.filename,
      isEncrypted: req.body.isEncrypted === "true",
      mimeType: req.file.mimetype,
      ownerNodeId: NODE_ID,
      replicas: [NODE_ID],
      storageMode: "chunks",
      chunkSize: CHUNK_SIZE_BYTES,
      chunks: manifest.chunks,
    };

    filesDb.push(fileInfo);
    saveDb();
    await replicateChunks(fileInfo.chunks || []);
    saveDb();

    res.status(201).json(fileInfo);
  });

  app.get("/api/files", (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";

    if (!query) {
      return res.json(filesDb);
    }

    const results = filesDb.filter((file) => {
      return file.name.toLowerCase().includes(query) || file.hash.toLowerCase().includes(query);
    });

    res.json(results);
  });

  app.get("/api/stats", (_req, res) => {
    res.json(calculateStats());
  });

  app.get("/api/download/:hash", async (req, res) => {
    const file = filesDb.find((entry) => entry.hash === req.params.hash);

    if (!file) {
      return res.status(404).json({ error: "File not found" });
    }

    if (file.storageMode === "chunks" && file.chunks?.length) {
      const available = await ensureChunksAvailable(file.chunks);
      if (!available) {
        return res.status(503).json({ error: "File chunks are not available on the network" });
      }

      res.setHeader("Content-Disposition", `attachment; filename=\"${file.name.replace(/\"/g, "")}\"`);
      res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
      res.setHeader("Content-Length", String(file.size));

      const streamed = await streamChunksToResponse(res, file);
      if (!streamed && !res.headersSent) {
        return res.status(503).json({ error: "File chunks are not available locally" });
      }
      return;
    }

    const filePath = path.join(uploadsDir, file.path);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Stored file is missing" });
    }

    res.download(filePath, file.name);
  });

  app.delete("/api/files/:hash", (req, res) => {
    const index = filesDb.findIndex((entry) => entry.hash === req.params.hash);

    if (index === -1) {
      return res.status(404).json({ error: "File not found" });
    }

    const [file] = filesDb.splice(index, 1);
    saveDb();

    const filePath = path.join(uploadsDir, file.path);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({ success: true, removed: file.hash });
  });

  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  app.use(express.static(staticPath));

  app.get("*", (req, res) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).json({ error: "API route not found" });
    }

    res.sendFile(path.join(staticPath, "index.html"));
  });

  const port = process.env.PORT || 3000;

  server.listen(port, async () => {
    console.log(`P2P Cloud node running on http://localhost:${port}/`);
    console.log(`Node ID: ${NODE_ID}`);
    console.log(`Public URL: ${PUBLIC_URL}`);
    console.log(`Vault storage directory: ${uploadsDir}`);
    console.log(`Chunk storage directory: ${chunksDir}`);

    await registerNode();
    await repairReplication();

    setInterval(() => {
      registerNode().then(repairReplication).catch(() => {
        console.log("repair cycle failed");
      });
    }, REPAIR_INTERVAL_MS).unref();
  });
}

startServer().catch(console.error);
