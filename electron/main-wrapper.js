import { app, Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_TITLE = 'p2p.cloud';
let tray = null;
let isQuitting = false;
let closeNoticeShown = false;

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
  tray.setToolTip(`${APP_TITLE} — running as a network peer`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open p2p.cloud', click: showMainWindow },
    { type: 'separator' },
    { label: 'Network peer is running', enabled: false },
    { label: 'Close window keeps peer online', enabled: false },
    { type: 'separator' },
    {
      label: 'Quit p2p.cloud',
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
        content: 'p2p.cloud is still running in the background as a network peer.',
      });
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

await import('./main.js');
