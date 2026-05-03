import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startP2PTransport } from './p2p-transport.js';
import { buildMerkleTree, getMerkleProof } from './merkle-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_REPLICAS = 3;
const CHUNK_SIZE_BYTES = 1024 * 1024;

let manifests = [];
let transportNode = null;

function ensureTransport() {
  if (!transportNode) transportNode = startP2PTransport({});
  return transportNode;
}

function split(buffer) {
  const out = [];
  for (let i = 0; i < buffer.length; i += CHUNK_SIZE_BYTES) {
    const slice = buffer.slice(i, i + CHUNK_SIZE_BYTES);
    out.push({
      data: slice,
      hash: '0x' + crypto.createHash('sha256').update(slice).digest('hex')
    });
  }
  return out;
}

ipcMain.handle('p2p:upload', async (_, payload) => {
  const node = ensureTransport();
  const buffer = Buffer.from(payload.bytes);

  const chunks = split(buffer);
  const leaves = chunks.map(c => c.hash);
  const tree = buildMerkleTree(leaves);

  const manifest = {
    name: payload.name,
    root: tree.root,
    totalChunks: chunks.length,
    chunks: []
  };

  chunks.forEach((chunk, i) => {
    const proof = getMerkleProof(tree, i);

    node.putChunkOnNetwork({
      hash: chunk.hash,
      data: chunk.data.toString('base64'),
      index: i
    });

    manifest.chunks.push({
      hash: chunk.hash,
      index: i,
      proof
    });
  });

  manifests.push(manifest);

  return {
    rootHash: tree.root,
    totalChunks: chunks.length
  };
});

ipcMain.handle('p2p:getProof', async (_, { root, index }) => {
  const file = manifests.find(m => m.root === root);
  if (!file) throw new Error('not found');

  const chunk = file.chunks.find(c => c.index === index);
  return chunk;
});

app.whenReady().then(() => {
  ensureTransport();
});
