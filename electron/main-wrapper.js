import { app, Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_TITLE = 'Chunknet';
let tray = null;
let isQuitting = false;
let closeNoticeShown = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

function isVirtualInterfaceName(name = '') {
  const n = String(name).toLowerCase();
  return [
    'hyper-v',
    'vethernet',
    'virtual',
    'vmware',
    'virtualbox',
    'docker',
    'wsl',
    'loopback',
    'bluetooth',
    'npcap',
    'tap',
    'tun',
  ].some((bad) => n.includes(bad));
}

function scoreIp(ip = '') {
  if (ip.startsWith('192.168.')) return 100;
  if (ip.startsWith('10.')) return 80;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 60;
  return 10;
}

function chooseLanAddress() {
  const candidates = [];
  const nets = os.networkInterfaces();
  for (const [name, items] of Object.entries(nets)) {
    if (isVirtualInterfaceName(name)) continue;
    for (const net of items || []) {
      if (!net || net.internal || net.family !== 'IPv4') continue;
      const ip = net.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      candidates.push({ ip, name, score: scoreIp(ip) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.ip || '127.0.0.1';
}

function configureNetworkRuntime() {
  const port = process.env.P2P_TRANSPORT_PORT || '8787';
  if (!process.env.P2P_CHUNK_SIZE_BYTES) process.env.P2P_CHUNK_SIZE_BYTES = String(2 * 1024 * 1024);
  if (!process.env.P2P_UPLOAD_CONCURRENCY) process.env.P2P_UPLOAD_CONCURRENCY = '4';
  if (!process.env.P2P_DOWNLOAD_CONCURRENCY) process.env.P2P_DOWNLOAD_CONCURRENCY = '6';
  if (!process.env.P2P_AUTO_REPAIR_INTERVAL_MS) process.env.P2P_AUTO_REPAIR_INTERVAL_MS = String(3 * 60 * 60 * 1000);
  if (!process.env.P2P_AUTO_REPAIR_START_DELAY_MS) process.env.P2P_AUTO_REPAIR_START_DELAY_MS = String(5 * 60 * 1000);

  if (!process.env.P2P_PUBLIC_URL && !process.env.VITE_P2P_PUBLIC_URL) {
    const ip = chooseLanAddress();
    process.env.P2P_PUBLIC_URL = `ws://${ip}:${port}`;
    console.log('[runtime] selected public peer URL:', process.env.P2P_PUBLIC_URL);
  }
  if (!process.env.P2P_CHUNK_STORE_DIR) {
    process.env.P2P_CHUNK_STORE_DIR = path.join(app.getPath('userData'), 'native-p2p-storage', 'chunks');
    console.log('[runtime] selected chunk store:', process.env.P2P_CHUNK_STORE_DIR);
  }
  console.log('[runtime] transfer defaults:', {
    chunkSizeBytes: process.env.P2P_CHUNK_SIZE_BYTES,
    uploadConcurrency: process.env.P2P_UPLOAD_CONCURRENCY,
    downloadConcurrency: process.env.P2P_DOWNLOAD_CONCURRENCY,
    autoRepairIntervalMs: process.env.P2P_AUTO_REPAIR_INTERVAL_MS,
    autoRepairStartDelayMs: process.env.P2P_AUTO_REPAIR_START_DELAY_MS,
  });
}

function resolveTrayIcon() {
  const candidates = [path.join(__dirname, '..', 'assets', 'icon.ico'), path.join(__dirname, '..', 'assets', 'icon.png')];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) return nativeImage.createEmpty();
  const image = nativeImage.createFromPath(found);
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

function showMainWindow() {
  const win = globalThis.__p2pCloudMainWindow;
  if (!win || win.isDestroyed()) return;
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

function createTray() {
  if (tray) return tray;
  tray = new Tray(resolveTrayIcon());
  tray.setToolTip(`${APP_TITLE} — running securely in the background`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Chunknet', click: showMainWindow },
    { type: 'separator' },
    { label: 'Secure storage is running', enabled: false },
    { label: 'Close window keeps protection online', enabled: false },
    { type: 'separator' },
    { label: 'Quit Chunknet', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', showMainWindow);
  return tray;
}

app.on('ready', () => {
  configureNetworkRuntime();
  createTray();
});

app.on('browser-window-created', (_event, win) => {
  globalThis.__p2pCloudMainWindow = win;
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
    createTray();
    if (!closeNoticeShown && tray) {
      closeNoticeShown = true;
      tray.displayBalloon?.({ title: APP_TITLE, content: 'Chunknet is still running in the background to keep your storage available.' });
    }
  });
});

app.on('before-quit', () => { isQuitting = true; });

if (gotSingleInstanceLock) {
  await import('./main-stable.js');
}
