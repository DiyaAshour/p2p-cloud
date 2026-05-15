import { app, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function dataDir() { return path.join(app.getPath('userData'), 'native-p2p-storage'); }
function objectDir() { return path.join(dataDir(), 'company-objects'); }
function chunkStoreDir() { return process.env.P2P_CHUNK_STORE_DIR || path.join(dataDir(), 'chunks'); }
function now() { return new Date().toISOString(); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeHash(hash = '') { return String(hash || '').replace(/[^a-fA-F0-9]/g, ''); }
function objectPath(hash) { return path.join(objectDir(), `${safeHash(hash)}.json`); }
function chunkPath(hash) { return path.join(chunkStoreDir(), `${safeHash(hash)}.json`); }
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
function writeJson(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8'); }
function decodeChunknetToken(token = '') { const match = String(token || '').trim().match(/^chunknet:\/\/([^/]+)\/(.+)$/); if (!match) throw new Error('Invalid Chunknet token.'); const [, kind, encoded] = match; return { kind, payload: JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) }; }
function encodeChunknetToken(kind, payload) { return `chunknet://${kind}/${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`; }

function storeCompanyObject({ kind, token, payload = null, workspaceId = '', note = '' } = {}) {
  const parsed = token ? decodeChunknetToken(token) : null;
  const objectKind = kind || parsed?.kind || payload?.kind || 'company-object';
  const objectPayload = payload || parsed?.payload || token;
  const object = {
    objectType: 'chunknet-company-object-v1',
    kind: objectKind,
    workspaceId: workspaceId || objectPayload?.workspaceId || objectPayload?.workspace?.workspaceId || objectPayload?.invite?.workspaceId || '',
    token: token || encodeChunknetToken(objectKind, objectPayload),
    payload: objectPayload,
    note,
    createdAt: now(),
  };
  const data = Buffer.from(JSON.stringify(object), 'utf8');
  const hash = sha256(data);
  const chunkPayload = { hash, data: data.toString('base64'), index: 0, size: data.length, ownerWallet: 'company-object', encrypted: false, objectType: object.objectType, kind: object.kind, workspaceId: object.workspaceId };
  writeJson(objectPath(hash), { ...object, hash, size: data.length });
  writeJson(chunkPath(hash), { ...chunkPayload, storedAt: now() });
  return { ok: true, hash, uri: `chunknet://object/${hash}`, object: { ...object, hash, size: data.length }, chunk: chunkPayload };
}

function readCompanyObject({ hashOrUri } = {}) {
  const raw = String(hashOrUri || '').trim();
  const hash = raw.startsWith('chunknet://object/') ? raw.replace('chunknet://object/', '') : raw;
  if (!safeHash(hash)) throw new Error('Object hash is required.');
  const localPath = objectPath(hash);
  if (fs.existsSync(localPath)) return { ok: true, source: 'object-store', object: readJson(localPath) };
  const cp = chunkPath(hash);
  if (!fs.existsSync(cp)) throw new Error('Company object not found locally yet. Connect peers or import token manually.');
  const chunk = readJson(cp);
  const object = JSON.parse(Buffer.from(chunk.data, 'base64').toString('utf8'));
  writeJson(localPath, { ...object, hash, size: chunk.size });
  return { ok: true, source: 'chunk-store', object: { ...object, hash, size: chunk.size } };
}

function tokenFromCompanyObject({ hashOrUri } = {}) {
  const result = readCompanyObject({ hashOrUri });
  return { ok: true, token: result.object.token, object: result.object };
}

function installDistributedObjectIpc() {
  for (const channel of ['company:publishObject', 'company:readObject', 'company:tokenFromObject']) {
    try { ipcMain.removeHandler(channel); } catch {}
  }
  ipcMain.handle('company:publishObject', async (_event, payload = {}) => storeCompanyObject(payload));
  ipcMain.handle('company:readObject', async (_event, payload = {}) => readCompanyObject(payload));
  ipcMain.handle('company:tokenFromObject', async (_event, payload = {}) => tokenFromCompanyObject(payload));
  console.log('[company] level 3 distributed object IPC installed');
}

installDistributedObjectIpc();
