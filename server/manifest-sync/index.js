import express from "express";
import cors from "cors";
import helmet from "helmet";
import Database from "better-sqlite3";

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json());

const db = new Database("./manifests.db");

db.exec(`
CREATE TABLE IF NOT EXISTS manifests (
  id TEXT PRIMARY KEY,
  wallet TEXT,
  hash TEXT,
  data TEXT
);
`);

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/wallet/:address/manifests", (req, res) => {
  const { address } = req.params;
  const rows = db.prepare("SELECT data FROM manifests WHERE wallet = ?").all(address.toLowerCase());
  const manifests = rows.map(r => JSON.parse(r.data));
  res.json({ manifests });
});

app.post("/wallet/:address/manifests", (req, res) => {
  const { address } = req.params;
  const { manifest } = req.body;
  if (!manifest || !manifest.hash) return res.status(400).json({ error: "Invalid manifest" });

  db.prepare(`
    INSERT OR REPLACE INTO manifests (id, wallet, hash, data)
    VALUES (?, ?, ?, ?)
  `).run(`${address}:${manifest.hash}`, address.toLowerCase(), manifest.hash, JSON.stringify(manifest));

  res.json({ ok: true });
});

app.delete("/wallet/:address/manifests/:hash", (req, res) => {
  const { address, hash } = req.params;
  db.prepare("DELETE FROM manifests WHERE wallet = ? AND hash = ?").run(address.toLowerCase(), hash);
  res.json({ ok: true });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Manifest Sync Server running on port ${PORT}`);
});
