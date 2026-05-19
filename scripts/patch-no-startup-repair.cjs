const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const files = ['electron/main-stable.js', 'electron/main.js'];

for (const file of files) {
  if (!fs.existsSync(file)) continue;

  let s = fs.readFileSync(file, 'utf8');
  const before = s;

  // Fix 1: add peer check inside runAutoRepair
  s = s.replace(
    `  const node = ensureTransport({});\n  const own = walletManifests();\n  const underReplicatedChunks = countUnderReplicatedChunks(node, own, TARGET_REPLICAS);`,
    `  const node = ensureTransport({});\n  const own = walletManifests();\n\n  // Skip repair if no peers available (P2P peers OR safety peer)\n  const connectedPeers = node.connectedPeerIds?.() || [];\n  const hasSafetyPeer = Boolean(safetyPeerUrl());\n  if (connectedPeers.length === 0 && !hasSafetyPeer) {\n    lastAutoRepairStatus = {\n      ...lastAutoRepairStatus,\n      active: Boolean(autoRepairTimer),\n      skippedReason: 'no-peers',\n      error: null,\n    };\n    console.log('[auto-repair] skipped: no peers connected (will retry on next interval)');\n    return lastAutoRepairStatus;\n  }\n\n  const underReplicatedChunks = countUnderReplicatedChunks(node, own, TARGET_REPLICAS);`
  );

  // Fix 2: replace immediate startup repair with 5-minute delayed version
  s = s.replace(
    `runAutoRepair('startup').catch((error) => console.warn('[auto-repair] startup failed:', error?.message || error));`,
    `setTimeout(() => {\n    runAutoRepair('startup-delayed').catch((error) => console.warn('[auto-repair] startup-delayed failed:', error?.message || error));\n  }, 300_000);\n  console.log('[auto-repair] startup repair scheduled in 5 minutes (skips automatically if no peers)');`
  );

  if (s !== before) {
    fs.writeFileSync(file, s, 'utf8');
    console.log(`[no-startup-repair] patched ${file}`);
  } else {
    console.log(`[no-startup-repair] already safe or anchor not found: ${file}`);
  }
}

// Keep upload-folder and synced UI preference handlers installed after all prepare patches.
// This must run last because the streaming upload/download patch rewrites the upload/download region.
const extraPatch = 'scripts/patch-upload-folder-ui-prefs.cjs';
if (fs.existsSync(extraPatch)) {
  const result = spawnSync(process.execPath, [extraPatch], { stdio: 'inherit' });
  if (result.status) process.exit(result.status);
} else {
  console.warn('[no-startup-repair] missing optional patch:', extraPatch);
}
