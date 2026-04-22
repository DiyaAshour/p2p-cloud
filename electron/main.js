import { app, ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { ElectronP2PNode } from './p2p-node.js';

if (typeof globalThis.CustomEvent === 'undefined') {
  class NodeCustomEvent extends Event {
    constructor(type, params = {}) {
      super(type, params);
      this.detail = params.detail ?? null;
    }
  }

  globalThis.CustomEvent = NodeCustomEvent;
}

const execFileAsync = promisify(execFile);
const APP_URL = process.env.P2P_CLOUD_URL || 'http://127.0.0.1:3000';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const vaultDir = path.resolve(__dirname, '..', 'uploads');
const manifestsDir = path.join(vaultDir, 'manifests');
const onboardingPath = path.join(vaultDir, 'onboarding.json');
const earningsPath = path.join(vaultDir, 'earnings.json');
const p2pNode = new ElectronP2PNode({ vaultDir });

async function openInBrowser(url = APP_URL) {
  const target = new URL(url).toString();

  if (process.platform === 'win32') {
    try {
      await execFileAsync('cmd', ['/c', 'start', 'chrome', '', target]);
      return { ok: true, browser: 'chrome', url: target };
    } catch {
      await execFileAsync('cmd', ['/c', 'start', '', target]);
      return { ok: true, browser: 'default', url: target };
    }
  }

  if (process.platform === 'darwin') {
    try {
      await execFileAsync('open', ['-a', 'Google Chrome', target]);
      return { ok: true, browser: 'chrome', url: target };
    } catch {
      await execFileAsync('open', [target]);
      return { ok: true, browser: 'default', url: target };
    }
  }

  try {
    await execFileAsync('google-chrome', [target]);
    return { ok: true, browser: 'chrome', url: target };
  } catch {
    await execFileAsync('xdg-open', [target]);
    return { ok: true, browser: 'default', url: target };
  }
}

async function ensureDirs() {
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(manifestsDir, { recursive: true });
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

async function readEarnings() {
  try {
    const content = await fs.readFile(earningsPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveEarnings(data) {
  await fs.writeFile(earningsPath, JSON.stringify(data, null, 2), 'utf-8');
}

ipcMain.handle('system:open-external', async (_event, url) => {
  try {
    return await openInBrowser(url);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
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
ipcMain.handle('onboarding:save', async (_event, payload) => {
  await saveOnboardingSession(payload);
  return true;
});
ipcMain.handle('onboarding:read', async () => readOnboardingSession());
ipcMain.handle('earnings:get', async () => readEarnings());
ipcMain.handle('earnings:add', async (_event, { peerId, amount }) => {
  const earnings = await readEarnings();
  earnings[peerId] = (earnings[peerId] || 0) + amount;
  await saveEarnings(earnings);
  return true;
});

app.whenReady().then(async () => {
  try {
    await ensureDirs();
    await p2pNode.start();
    await openInBrowser(APP_URL);
  } catch (error) {
    console.error('Headless Electron P2P service failed:', error);
    app.exit(1);
  }
});

app.on('window-all-closed', () => {
  // Keep background P2P service alive without any BrowserWindow.
});

app.on('before-quit', async () => {
  try {
    await p2pNode.stop();
  } catch {
    // ignore shutdown errors
  }
});
