const fs = require('node:fs');

const file = 'client/src/NativeP2PAppLive.tsx';
if (!fs.existsSync(file)) {
  console.warn('[patch-ui-protection-status] missing file:', file);
  process.exit(0);
}

let s = fs.readFileSync(file, 'utf8');
const before = s;

const start = s.indexOf('function protection(file: P2PFile) {');
if (start === -1) {
  console.warn('[patch-ui-protection-status] protection() not found');
  process.exit(0);
}

const marker = '\n\n// ─── Component';
const end = s.indexOf(marker, start);
if (end === -1) {
  console.warn('[patch-ui-protection-status] component marker not found');
  process.exit(0);
}

const replacement = `function protection(file: P2PFile) {
  const totalChunks = Number(file.totalChunks || (file as any).chunks?.length || 0);

  if (!totalChunks || totalChunks <= 0) {
    return {
      label: "No chunks",
      tone: "text-zinc-400",
      details: "0/0 chunks",
    };
  }

  const chunks = Array.isArray((file as any).chunks) ? (file as any).chunks : [];

  const chunkIsSafetyProtected = (chunk: any) => {
    const replicas = Array.isArray(chunk?.replicas) ? chunk.replicas : [];

    return Boolean(
      replicas.includes("aws-safety-peer") ||
      chunk?.safetyPeer?.enabled === true ||
      chunk?.protectionMode === "aws-safety" ||
      chunk?.replicationStatus === "protected" ||
      chunk?.safetyStatus === "uploaded"
    );
  };

  const chunkIsPeerProtected = (chunk: any) => {
    const replicas = Array.isArray(chunk?.replicas) ? chunk.replicas : [];
    const peerReplicas = replicas.filter((peerId: string) => peerId && peerId !== "aws-safety-peer");
    return Number(chunk?.confirmedReplicas || peerReplicas.length || 0) >= Number(chunk?.targetReplicas || 4);
  };

  const protectedByChunks = chunks.length
    ? chunks.filter((chunk: any) => chunkIsPeerProtected(chunk) || chunkIsSafetyProtected(chunk)).length
    : Number(file.protectedChunks || 0);

  const safetyProtectedChunks = chunks.length
    ? chunks.filter((chunk: any) => chunkIsSafetyProtected(chunk) && !chunkIsPeerProtected(chunk)).length
    : Number((file as any).safetyProtectedChunks || 0);

  const peerProtectedChunks = chunks.length
    ? chunks.filter((chunk: any) => chunkIsPeerProtected(chunk)).length
    : Number((file as any).p2pProtectedChunks || 0);

  const status = String(file.replicationStatus || "").toLowerCase();

  if (protectedByChunks >= totalChunks || status === "protected") {
    return {
      label: "Protected",
      tone: "text-emerald-300",
      details: safetyProtectedChunks > 0
        ? `${protectedByChunks}/${totalChunks} chunks · AWS safety`
        : `${protectedByChunks}/${totalChunks} chunks`,
    };
  }

  if (protectedByChunks > 0 || status === "protecting") {
    return {
      label: "Protecting",
      tone: "text-blue-300",
      details: `${protectedByChunks}/${totalChunks} protected`,
    };
  }

  const needsRepair = Number(file.needsRepairChunks ?? Math.max(0, totalChunks - protectedByChunks));

  return {
    label: "Needs repair",
    tone: "text-amber-300",
    details: `${needsRepair} chunk(s) need repair`,
  };
}`;

s = s.slice(0, start) + replacement + s.slice(end);

if (s !== before) {
  fs.writeFileSync(file, s, 'utf8');
  console.log('[patch-ui-protection-status] patched NativeP2PAppLive protection()');
} else {
  console.log('[patch-ui-protection-status] already patched');
}
