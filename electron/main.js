import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import isDev from 'electron-is-dev';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let serverProcess;
let viteProcess;

function startBackend() {
  const serverPath = isDev 
    ? path.join(__dirname, '../server/index.ts')
    : path.join(__dirname, '../dist/index.js');
  
  const cmd = isDev ? 'pnpm' : 'node';
  const args = isDev ? ['tsx', serverPath] : [serverPath];

  serverProcess = spawn(cmd, args, {
    shell: true,
    env: { ...process.env, NODE_ENV: isDev ? 'development' : 'production' }
  });

  serverProcess.stdout.on('data', (data) => console.log(`Server: ${data}`));
  serverProcess.stderr.on('data', (data) => console.error(`Server Error: ${data}`));
}

function startFrontend() {
  if (!isDev) {
    // في نسخة الإنتاج، نستخدم vite لخدمة الملفات أو نعتمد على السيرفر المدمج
    // هنا سنقوم بتشغيل vite preview أو ما يعادلها لضمان عمل الرابط 3000
    viteProcess = spawn('pnpm', ['vite', 'preview', '--port', '3000', '--host', '127.0.0.1'], {
      shell: true
    });
  } else {
    viteProcess = spawn('pnpm', ['dev'], {
      shell: true
    });
  }
}

async function createWindow() {
  const url = 'http://127.0.0.1:3000';

  // فتح المتصفح الافتراضي
  await shell.openExternal(url);

  mainWindow = new BrowserWindow({
    width: 450,
    height: 250,
    resizable: false,
    alwaysOnTop: true,
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`data:text/html;charset=utf-8,
    <body style="background: #0f172a; color: white; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; border: 2px solid #1e293b; border-radius: 8px;">
      <div style="text-align: center; padding: 20px;">
        <div style="font-size: 40px; margin-bottom: 10px;">🔐</div>
        <h2 style="margin: 0 0 10px 0; color: #38bdf8;">P2P Storage Browser</h2>
        <p style="font-size: 14px; color: #94a3b8; line-height: 1.5;">
          Opening in your default browser for <b>MetaMask</b> support...<br>
          Make sure the background server is running.
        </p>
        <div style="margin-top: 20px; display: flex; gap: 10px; justify-content: center;">
          <button onclick="window.close()" style="padding: 8px 20px; background: #0369a1; border: none; color: white; border-radius: 6px; cursor: pointer; font-weight: 600; transition: background 0.2s;">
            Close
          </button>
        </div>
      </div>
    </body>
  `);
  
  setTimeout(() => {
    if (mainWindow) mainWindow.close();
  }, 5000);
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  // إغلاق العمليات الخلفية عند إغلاق التطبيق
  if (serverProcess) serverProcess.kill();
  if (viteProcess) viteProcess.kill();
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (serverProcess) serverProcess.kill();
  if (viteProcess) viteProcess.kill();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// IPC handlers for P2P operations
ipcMain.handle('get-storage-path', () => {
  return path.join(app.getPath('userData'), 'storage');
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Create menu
const template = [
  {
    label: 'File',
    submenu: [
      {
        label: 'Exit',
        accelerator: 'CmdOrCtrl+Q',
        click: () => {
          app.quit();
        },
      },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
    ],
  },
  {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
    ],
  },
];

const menu = Menu.buildFromTemplate(template);
Menu.setApplicationMenu(menu);
