const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const livePath = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');

if (!fs.existsSync(livePath)) {
  console.warn('[live-network-folders] NativeP2PAppLive.tsx not found');
  process.exit(0);
}

const src = fs.readFileSync(livePath, 'utf8');
const looksTruncated =
  !src.includes('export default function NativeP2PAppLive') ||
  !src.includes('<main className=') ||
  !src.includes('</main>') ||
  !src.includes('TabsContent value="admin"') ||
  src.length < 30000;

if (looksTruncated) {
  console.warn('[live-network-folders] NativeP2PAppLive.tsx is incomplete. Run: git restore client/src/NativeP2PAppLive.tsx && git pull');
  process.exit(0);
}

const bulkMovePatch = path.join(process.cwd(), 'scripts', 'patch-live-bulk-file-move.cjs');
if (fs.existsSync(bulkMovePatch)) {
  execFileSync(process.execPath, [bulkMovePatch], { stdio: 'inherit' });
}

// Retired unsafe patch.
// This script used to inject large TSX blocks into NativeP2PAppLive.tsx and could
// leave the file syntactically broken. Keep it as a compile-safe guard only.
// Folder backend IPCs are still installed by patch-network-folder-metadata,
// patch-folder-runtime-stable, patch-manifest-folder-item-aliases, and preload patches.
console.log('[live-network-folders] unsafe TSX injection retired; compile-safe guard passed');
