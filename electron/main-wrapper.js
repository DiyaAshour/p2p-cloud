import { app, Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
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

  // Safer defaults: faster than 1 MB chunks, but still low-memory.
  // Users can override any of these env vars for benchmarking.
  if (!process.env.P2P_CHUNK_SIZE_BYTES) process.env.P2P_CHUNK_SIZE_BYTES = String(2 * 1024 * 1024);
  if (!process.env.P2P_UPLOAD_CONCURRENCY) process.env.P2P_UPLOAD_CONCURRENCY = '4';
  if (!process.env.P2P_DOWNLOAD_CONCURRENCY) process.env.P2P_DOWNLOAD_CONCURRENCY = '6';

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
  });
}

function runPatchScript(projectRoot, scriptName) {
  const scriptPath = path.join(projectRoot, 'scripts', scriptName);
  if (!fs.existsSync(scriptPath)) return;
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) console.log(result.stdout.trim());
  if (result.stderr) console.warn(result.stderr.trim());
  if (result.status !== 0) throw new Error(`${scriptName} failed: ${result.stderr || result.stdout || result.status}`);
}

function applyRuntimeSafetyPatches() {
  const projectRoot = path.join(__dirname, '..');
  const mainFile = path.join(__dirname, 'main.js');
  if (!fs.existsSync(mainFile)) return;

  try {
    const mainSource = fs.readFileSync(mainFile, 'utf8');
    const needsDownloadPatch =
      mainSource.includes('Buffer.concat(buffers)') ||
      mainSource.includes('Array.from(plain)') ||
      !mainSource.includes('chunknet-downloads');
    const needsUploadPatch =
      !mainSource.includes("ipcMain.handle('p2p:uploadFiles'") ||
      !mainSource.includes('uploadFilePathStreaming');
    const needsUploadRamFinalPatch =
      mainSource.includes('chunk.data.toString') ||
      mainSource.includes('chunkMetas.push({ index, size: data.length, data, hash })');
    const needsDialogImport =
      !mainSource.includes("dialog } from 'electron'") &&
      !mainSource.includes("dialog, ");

    if (needsDownloadPatch || needsDialogImport) runPatchScript(projectRoot, 'patch-download-memory.cjs');
    if (needsUploadPatch || needsDialogImport) runPatchScript(projectRoot, 'patch-native-upload-streaming.cjs');
    runPatchScript(projectRoot, 'patch-upload-ram-final.cjs');

    const patched = fs.readFileSync(mainFile, 'utf8');
    if (patched.includes('Buffer.concat(buffers)') || patched.includes('Array.from(plain)')) {
      throw new Error('Unsafe large-file download code is still present after runtime patch.');
    }
    if (!patched.includes("ipcMain.handle('p2p:uploadFiles'") || !patched.includes('uploadFilePathStreaming')) {
      throw new Error('Streaming upload handler is missing after runtime patch.');
    }
    if (patched.includes('chunk.data.toString') || patched.includes('chunkMetas.push({ index, size: data.length, data, hash })')) {
      throw new Error('Upload chunk RAM retention is still present after runtime patch.');
    }
  } catch (error) {
    console.error('[runtime-safety] failed to apply P2P memory safety patches:', error?.message || error);
    throw error;
  }
}

function resolveTrayIcon() {
  const candidates = [
    path.join(__dirname, '..', 'assets', 'icon.ico'),
    path.join(__dirname, '..', 'assets', 'icon.png'),
  ];
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
    {
      label: 'Quit Chunknet',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('double-click', showMainWindow);
  return tray;
}

app.on('ready', () => {
  configureNetworkRuntime();
  createTray();
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: false,
      name: APP_TITLE,
    });
  } catch (error) {
    console.warn('[tray] failed to enable auto start:', error?.message || error);
  }
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
      tray.displayBalloon?.({
        title: APP_TITLE,
        content: 'Chunknet is still running in the background to keep your storage available.',
      });
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

if (gotSingleInstanceLock) {
  applyRuntimeSafetyPatches();
  await import('./main.js');
}
