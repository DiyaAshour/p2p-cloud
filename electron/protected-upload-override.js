import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const TARGET_REPLICAS = Math.max(4, Number(process.env.P2P_TARGET_REPLICAS || 4));
const MIN_CONFIRMED_REPLICAS = Math.max(3, Number(process.env.P2P_UPLOAD_MIN_CONFIRMED_REPLICAS || 3));

function dataDir() {
  return path.join(app.getPath('userData'), 'native-p2p-storage');
}

function manifestsPath() {
  return path.join(dataDir(), 'manifests.json');
}

function readManifests() {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestsPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeManifests(manifests) {
  fs.mkdirSync(path.dirname(manifestsPath()), { recursive: true });
  fs.writeFileSync(manifestsPath(), JSON.stringify(manifests, null, 2), 'utf8');
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function classifyChunk(chunk = {}) {
  const replicas = unique(chunk.replicas || []);
  const confirmed = replicas.filter((id) => id !== 'aws-safety-peer').length;
  const hasSafety = replicas.includes('aws-safety-peer');
  const protectedEnough = confirmed >= TARGET_REPLICAS;
  const safeEnough = confirmed >= MIN_CONFIRMED_REPLICAS || (hasSafety && confirmed >= MIN_CONFIRMED_REPLICAS - 1);

  return {
    ...chunk,
    replicas,
    confirmedReplicas: confirmed,
    targetReplicas: TARGET_REPLICAS,
    minimumConfirmedReplicas: MIN_CONFIRMED_REPLICAS,
    replicationStatus: protectedEnough ? 'protected' : safeEnough ? 'protecting' : 'needs-repair',
  };
}

function markFileProtection(file = {}) {
  const chunks = Array.isArray(file.chunks) ? file.chunks.map(classifyChunk) : [];
  const protectedChunks = chunks.filter((chunk) => chunk.replicationStatus === 'protected').length;
  const repairChunks = chunks.filter((chunk) => chunk.replicationStatus === 'needs-repair').length;
  const replicationStatus = repairChunks > 0 ? 'needs-repair' : protectedChunks === chunks.length ? 'protected' : 'protecting';
  const replicas = unique(chunks.flatMap((chunk) => chunk.replicas || []));

  return {
    ...file,
    chunks,
    replicas,
    uploadStatus: 'available',
    replicationStatus,
    protectedChunks,
    needsRepairChunks: repairChunks,
    replicationUpdatedAt: new Date().toISOString(),
  };
}

function updateStoredManifests(files = []) {
  if (!files.length) return files;
  const map = new Map(files.map((file) => [file.hash, markFileProtection(file)]));
  const manifests = readManifests();
  const next = manifests.map((manifest) => map.has(manifest.hash) ? { ...manifest, ...map.get(manifest.hash) } : manifest);
  writeManifests(next);
  return files.map((file) => map.get(file.hash) || file);
}

function installProtectedUploadStatusOverride() {
  const handlers = ipcMain._invokeHandlers;
  const oldUploadFiles = handlers?.get?.('p2p:uploadFiles');
  const oldUploadPath = handlers?.get?.('p2p:uploadPath');
  const oldSummary = handlers?.get?.('p2p:networkSummary');
  if (!oldUploadFiles) {
    console.warn('[protected-upload] base p2p:uploadFiles handler missing; skipped');
    return;
  }

  try { ipcMain.removeHandler('p2p:uploadFiles'); } catch {}
  ipcMain.handle('p2p:uploadFiles', async (event, payload = {}) => {
    const result = await oldUploadFiles(event, payload);
    if (result?.cancelled || !Array.isArray(result?.files)) return result;
    const files = updateStoredManifests(result.files);
    const summary = oldSummary ? await oldSummary(event, {}) : result.summary;
    return { ...result, files, summary };
  });

  if (oldUploadPath) {
    try { ipcMain.removeHandler('p2p:uploadPath'); } catch {}
    ipcMain.handle('p2p:uploadPath', async (event, payload = {}) => {
      const result = await oldUploadPath(event, payload);
      if (!result?.file) return result;
      const [file] = updateStoredManifests([result.file]);
      const summary = oldSummary ? await oldSummary(event, {}) : result.summary;
      return { ...result, file, summary };
    });
  }

  console.log('[protected-upload] status override installed', { targetReplicas: TARGET_REPLICAS, minConfirmed: MIN_CONFIRMED_REPLICAS });
}

installProtectedUploadStatusOverride();
