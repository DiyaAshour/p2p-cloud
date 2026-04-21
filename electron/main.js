import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { ElectronP2PNode } from './p2p-node.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
const vaultDir = path.resolve(__dirname, '..', 'uploads');
const manifestsDir = path.join(vaultDir, 'manifests');
const onboardingPath = path.join(vaultDir, 'onboarding.json');
const p2pNode = new ElectronP2PNode({ vaultDir });

async function ensureDirs() {
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(manifestsDir, { recursive: true });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL('http://127.0.0.1:3000');
}

async function saveManifest(manifest) {
  const filePath = path.join(manifestsDir, `${manifest.fileId}.json`);
  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
}

async function readManifest(fileId) {
  const filePath = path.join(manifestsDir, `${fileId}.json`);
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

async function saveOnboardingSession(payload) {
  await fs.writeFile(onboardingPath, JSON.stringify(payload, null, 2), 'utf-8');
}

async function readOnboardingSession() {
  try {
    const content = await fs.readFile(onboardingPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function getDiskInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    total,
    free,
  };
}

app.whenReady().then(async () => {
  await ensureDirs();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('p2p:start', async () => p2pNode.start());
ipcMain.handle('p2p:stop', async () => {
  await p2pNode.stop();
  return p2pNode.getStatus();
});
ipcMain.handle('p2p:status', () => p2pNode.getStatus());
ipcMain.handle('p2p:update-config', async (_event, config) => p2pNode.updateConfig(config));
ipcMain.handle('p2p:announce', async (_event, metadata) => {
  await p2pNode.announceFile(metadata);
  return true;
});
ipcMain.handle('p2p:chunk-store', async (_event, peerId, payload) => {
  return p2pNode.sendChunkToPeer(peerId, payload);
});
ipcMain.handle('p2p:chunk-request', async (_event, peerId, chunkId) => {
  return p2pNode.requestChunkFromPeer(peerId, chunkId);
});
ipcMain.handle('p2p:manifest-save', async (_event, manifest) => {
  await saveManifest(manifest);
  return true;
});
ipcMain.handle('p2p:manifest-read', async (_event, fileId) => {
  return readManifest(fileId);
});
ipcMain.handle('system:get-disk-info', async () => getDiskInfo());
ipcMain.handle('onboarding:save', async (_event, payload) => {
  await saveOnboardingSession(payload);
  return true;
});
ipcMain.handle('onboarding:read', async () => readOnboardingSession());
