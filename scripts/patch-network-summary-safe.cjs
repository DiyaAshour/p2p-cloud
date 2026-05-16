const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const files = [path.join(root, 'electron', 'main.js'), path.join(root, 'electron', 'main-stable.js')];

for (const filePath of files) {
  if (!fs.existsSync(filePath)) continue;
  let src = fs.readFileSync(filePath, 'utf8');
  const before = src;
  if (!src.includes('function safePeerList(') && src.includes('function networkSummary() {')) {
    src = src.replace(
      'function networkSummary() {',
      "function safePeerList(node) {\n  return Array.from(node.peerInfo?.values?.() || []).slice(0, 50).map((peer) => ({ peerId: String(peer.peerId || ''), url: peer.url || null, status: peer.status || null, direction: peer.direction || null, lastSeen: peer.lastSeen || null }));\n}\n\nfunction networkSummary() {"
    );
  }
  src = src.replace('peers: Array.from(node.peerInfo?.values?.() || [])', 'peers: safePeerList(node)');
  if (src !== before) {
    fs.writeFileSync(filePath, src, 'utf8');
    console.log(`[network-summary-safe] patched ${path.relative(root, filePath)}`);
  } else {
    console.log(`[network-summary-safe] already safe or no summary in ${path.relative(root, filePath)}`);
  }
}
