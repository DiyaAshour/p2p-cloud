import express from "express";
import { createServer } from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure uploads directory exists
const uploadsDir = path.resolve(__dirname, "..", "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    // Use the original name or a hash
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

// Simple in-memory database for file metadata (persisted to a JSON file)
const dbPath = path.resolve(__dirname, "..", "files_db.json");
let filesDb: any[] = [];
if (fs.existsSync(dbPath)) {
  try {
    filesDb = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
  } catch (e) {
    filesDb = [];
  }
}

function saveDb() {
  fs.writeFileSync(dbPath, JSON.stringify(filesDb, null, 2));
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(express.json());

  // API for file uploads
  app.post("/api/upload", upload.single("file"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const fileInfo = {
      name: req.file.originalname,
      size: req.file.size,
      hash: req.body.hash || Math.random().toString(36).substring(7),
      uploadedAt: new Date().toISOString(),
      path: req.file.filename,
      isEncrypted: req.body.isEncrypted === 'true'
    };

    filesDb.push(fileInfo);
    saveDb();

    console.log(`✅ File uploaded and saved: ${fileInfo.name}`);
    res.json(fileInfo);
  });

  // API to list files
  app.get("/api/files", (_req, res) => {
    res.json(filesDb);
  });

  // API to download files
  app.get("/api/download/:filename", (req, res) => {
    const filePath = path.join(uploadsDir, req.params.filename);
    if (fs.existsSync(filePath)) {
      res.download(filePath);
    } else {
      res.status(404).json({ error: "File not found" });
    }
  });

  // Serve static files from dist/public in production
  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  app.use(express.static(staticPath));

  // Handle client-side routing - serve index.html for all routes
  app.get("*", (req, res) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: "API route not found" });
    }
    res.sendFile(path.join(staticPath, "index.html"));
  });

  const port = process.env.PORT || 3000;

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    console.log(`Uploads directory: ${uploadsDir}`);
  });
}

startServer().catch(console.error);
