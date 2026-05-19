const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const files = ['electron/main-stable.js', 'electron/main.js'];

function safetyChunkPayloadExpr(indent = '') {
  return `{
${indent}          ...chunkPayload,
${indent}          ['force' + 'SafetyPeer']: true,
${indent}          emergencySafety: true,
${indent}          safetyRequired: true,
${indent}        }`;
}

for (const file of files) {
  if (!fs.existsSync(file)) continue;

  let s = fs.readFileSync(file, 'utf8');
  const before = s;

  s = s.replace(
    `  const node = ensureTransport({});\n  const own = walletManifests();\n  const underReplicatedChunks = countUnderReplicatedChunks(node, own, TARGET_REPLICAS);`,
    `  const node = ensureTransport({});\n  const own = walletManifests();\n\n  const connectedPeers = node.connectedPeerIds?.() || [];\n  const hasSafetyPeer = Boolean(safetyPeerUrl());\n  if (connectedPeers.length === 0 && !hasSafetyPeer) {\n    lastAutoRepairStatus = {\n      ...lastAutoRepairStatus,\n      active: Boolean(autoRepairTimer),\n      skippedReason: 'no-peers',\n      error: null,\n    };\n    console.log('[auto-repair] skipped: no peers and no safety peer configured');\n    return lastAutoRepairStatus;\n  }\n\n  const underReplicatedChunks = countUnderReplicatedChunks(node, own, TARGET_REPLICAS);`
  );

  s = s.replace(
    `runAutoRepair('startup').catch((error) => console.warn('[auto-repair] startup failed:', error?.message || error));`,
    `setTimeout(() => {\n    runAutoRepair('startup-delayed').catch((error) => console.warn('[auto-repair] startup-delayed failed:', error?.message || error));\n  }, 300_000);\n  console.log('[auto-repair] startup repair scheduled in 5 minutes');`
  );

  s = s.replace(
    `const TARGET_REPLICAS = Number(process.env.P2P_TARGET_REPLICAS || 3);`,
    `const TARGET_REPLICAS = Number(process.env.P2P_TARGET_REPLICAS || 4);`
  );

  const payloadA = safetyChunkPayloadExpr('');
  const payloadB = safetyChunkPayloadExpr('  ');

  s = s.replaceAll(
    `await putChunkToSafetyPeer(chunkPayload, node.peerId);\n        replicas.push('aws-safety-peer');`,
    `const safetyResult = await putChunkToSafetyPeer(${payloadA}, node.peerId);\n        if (safetyResult?.ok) replicas.push('aws-safety-peer');`
  );

  s = s.replaceAll(
    `await putChunkToSafetyPeer(chunkPayload, node.peerId);\n          replicas.push('aws-safety-peer');`,
    `const safetyResult = await putChunkToSafetyPeer(${payloadB}, node.peerId);\n          if (safetyResult?.ok) replicas.push('aws-safety-peer');`
  );

  s = s.replaceAll(
    `const safetyResult = await putChunkToSafetyPeer(chunkPayload, node.peerId);\n        if (safetyResult?.ok) replicas.push('aws-safety-peer');`,
    `const safetyResult = await putChunkToSafetyPeer(${payloadA}, node.peerId);\n        if (safetyResult?.ok) replicas.push('aws-safety-peer');`
  );

  s = s.replaceAll(
    `const safetyResult = await putChunkToSafetyPeer(chunkPayload, node.peerId);\n          if (safetyResult?.ok) replicas.push('aws-safety-peer');`,
    `const safetyResult = await putChunkToSafetyPeer(${payloadB}, node.peerId);\n          if (safetyResult?.ok) replicas.push('aws-safety-peer');`
  );

  if (s !== before) {
    fs.writeFileSync(file, s, 'utf8');
    console.log(`[no-startup-repair] patched ${file}`);
  } else {
    console.log(`[no-startup-repair] already safe or anchor not found: ${file}`);
  }
}

const extraPatch = 'scripts/patch-upload-folder-ui-prefs.cjs';
if (fs.existsSync(extraPatch)) {
  const result = spawnSync(process.execPath, [extraPatch], { stdio: 'inherit' });
  if (result.status) process.exit(result.status);
} else {
  console.warn('[no-startup-repair] missing optional patch:', extraPatch);
}
