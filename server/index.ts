import express from "express";
import { createServer } from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.resolve(__dirname, "..", "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
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
};

const dbPath = path.resolve(__dirname, "..", "files_db.json");
let filesDb: StoredFile[] = [];
if (fs.existsSync(dbPath)) {
  try {
    filesDb = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
  } catch {
    filesDb = [];
  }
}

function saveDb() {
  fs.writeFileSync(dbPath, JSON.stringify(filesDb, null, 2));
}

function calculateStats() {
  const totalBytes = filesDb.reduce((sum, file) => sum + file.size, 0);
  const encryptedFiles = filesDb.filter((file) => file.isEncrypted).length;

  return {
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
      product: "P2P Cloud MVP",
      mode: "local-first vault",
      stats: calculateStats(),
    });
  });

  app.post("/api/upload", upload.single("file"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const hash = req.body.hash || crypto.randomBytes(12).toString("hex");
    const fileInfo: StoredFile = {
      id: hash,
      name: req.file.originalname,
      size: req.file.size,
      hash,
      uploadedAt: new Date().toISOString(),
      path: req.file.filename,
      isEncrypted: req.body.isEncrypted === "true",
      mimeType: req.file.mimetype,
    };

    filesDb.push(fileInfo);
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
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    console.log(`Vault storage directory: ${uploadsDir}`);
  });
}

startServer().catch(console.error);
