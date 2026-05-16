const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'electron', 'replication-engine.js');
if (!fs.existsSync(file)) {
  console.warn('[replication-memory-safe] replication-engine.js not found; skipping');
  process.exit(0);
}

let src = fs.readFileSync(file, 'utf8');
const before = src;

src = src.replace(
  '  if (node?.getLocalChunk?.(chunkHash)) replicas.add(node.peerId);',
  '  // Memory-safe startup: do not call node.getLocalChunk() here.\n  // getLocalChunk() may read chunk data from disk and cache it in memory;\n  // networkSummary/countUnderReplicatedChunks can touch every chunk on startup.\n  if ((knownReplicas || []).includes(node?.peerId)) replicas.add(node.peerId);'
);

if (src !== before) {
  fs.writeFileSync(file, src, 'utf8');
  console.log('[replication-memory-safe] patched getHealthyReplicas to avoid loading chunk data during health checks');
} else {
  console.log('[replication-memory-safe] already safe or anchor not found');
}
