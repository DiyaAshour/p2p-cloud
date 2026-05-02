import express from "express";
import { createServer } from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";
import crypto from "node:crypto";

const NODE_ID = process.env.P2P_NODE_ID || "node-local";
const PUBLIC_URL = process.env.P2P_PUBLIC_URL || "http://127.0.0.1:3000";
const BOOTSTRAP_URL = process.env.P2P_BOOTSTRAP_URL || "";
const REPLICATION_FACTOR = Number(process.env.P2P_REPLICATION_FACTOR || 3);

type PeerInfo = {
  peerId: string;
  url: string;
  lastSeen: string;
};

let peers: PeerInfo[] = [];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.resolve(__dirname, "..", "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const uniquePrefix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    cb(null, `${uniquePrefix}-${safeName}`);
  },
});

const upload = multer({ storage });

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

    console.log("connected peers:", peers.length);
  } catch (error) {
    console.log("bootstrap register failed");
  }
}

async function replicate(filePath: string, fileName: string, hash: string) {
  for (const peer of peers.slice(0, REPLICATION_FACTOR - 1)) {
    try {
      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(filePath)]), fileName);
      form.append("hash", hash);
      form.append("ownerNodeId", NODE_ID);

      await fetch(`${peer.url}/api/p2p/store`, {
        method: "POST",
        body: form,
      });

      console.log("replicated to", peer.peerId);
    } catch {
      console.log("replication failed", peer.peerId);
    }
  }
}

function calculateStats() {
  const totalBytes = filesDb.reduce((sum, file) => sum + file.size, 0);
  const encryptedFiles = filesDb.filter((file) => file.isEncrypted).length;

  return {
    nodeId: NODE_ID,
    publicUrl: PUBLIC_URL,
    peers: peers.length,
    totalFiles: filesDb.length,
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
      mode: "http-p2p-node",
      stats: calculateStats(),
    });
  });

  app.post("/api/bootstrap/register", async (_req, res) => {
    await registerNode();
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

  app.post("/api/p2p/store", upload.single("file"), (req, res) => {
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
    };

    filesDb.push(fileInfo);
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
      await replicate(filePath, req.file.originalname, hash);
      return res.json({ ...existing, duplicate: true });
    }

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
    };

    filesDb.push(fileInfo);
    saveDb();

    await replicate(filePath, req.file.originalname, hash);

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

  app.get("/api/download/:hash", (req, res) => {
    const file = filesDb.find((entry) => entry.hash === req.params.hash);

    if (!file) {
      return res.status(404).json({ error: "File not found" });
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

    await registerNode();
  });
}

startServer().catch(console.error);
