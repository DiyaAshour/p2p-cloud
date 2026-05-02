import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startP2PTransport } from './p2p-transport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let transportNode = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';

  if (process.env.NODE_ENV === 'production') {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    mainWindow.loadURL(devUrl);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function ensureTransport(options = {}) {
  if (!transportNode) {
    transportNode = startP2PTransport(options);
  }
  return transportNode;
}

ipcMain.handle('p2p:start', async (_event, options = {}) => {
  const node = ensureTransport(options);
  return { ok: true, peerId: node.peerId, port: node.port, host: node.host };
});

ipcMain.handle('p2p:status', async () => {
  const node = ensureTransport({});
  return {
    ok: true,
    peerId: node.peerId,
    port: node.port,
    host: node.host,
    peers: Array.from(node.peerInfo.values()),
  };
});

ipcMain.handle('system:open-external', async (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    throw new Error('Only http/https URLs can be opened');
  }
  await shell.openExternal(url);
  return { ok: true };
});

app.whenReady().then(() => {
  ensureTransport({});
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}).catch((error) => {
  console.error('Electron failed:', error);
  app.exit(1);
});

app.on('before-quit', () => {
  if (transportNode) transportNode.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
