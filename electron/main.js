import { app, BrowserWindow, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMerkleTree, getMerkleProof } from './merkle-engine.js';
import { startP2PTransport } from './p2p-transport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;

function resolvePreloadPath() {
  const candidates = [
    path.join(__dirname, 'preload.js'),
    path.join(process.cwd(), 'electron', 'preload.js'),
  ];

  const preloadPath = candidates.find((c) => fs.existsSync(c));
  console.log('[electron] preload:', preloadPath);
  return preloadPath;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL('http://127.0.0.1:3000');
}

ipcMain.handle('electron:openDevTools', () => {
  if (mainWindow) {
    mainWindow.webContents.openDevTools();
  }
});

app.whenReady().then(() => {
  createMainWindow();
});
