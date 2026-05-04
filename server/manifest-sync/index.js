import express from "express";
import cors from "cors";
import helmet from "helmet";
import fs from "fs";

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json());

const DB_FILE = "./manifests.json";

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/wallet/:address/manifests", (req, res) => {
  const db = loadDB();
  const address = req.params.address.toLowerCase();
  res.json({ manifests: db[address] || [] });
});

app.post("/wallet/:address/manifests", (req, res) => {
  const db = loadDB();
  const address = req.params.address.toLowerCase();
  const { manifest } = req.body;

  if (!manifest || !manifest.hash) {
    return res.status(400).json({ error: "Invalid manifest" });
  }

  db[address] = db[address] || [];
  db[address] = db[address].filter(m => m.hash !== manifest.hash);
  db[address].push(manifest);

  saveDB(db);
  res.json({ ok: true });
});

app.delete("/wallet/:address/manifests/:hash", (req, res) => {
  const db = loadDB();
  const address = req.params.address.toLowerCase();
  const { hash } = req.params;

  db[address] = (db[address] || []).filter(m => m.hash !== hash);
  saveDB(db);

  res.json({ ok: true });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Manifest Sync Server running on port ${PORT}`);
});
