const fs = require('node:fs');

const files = ['electron/main.js', 'electron/main-stable.js'];
let changed = false;

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  let s = fs.readFileSync(file, 'utf8');
  const before = s;

  // Avoid hidden-window startup hangs in dev. Some renderer failures prevent
  // ready-to-show from firing, leaving Electron running with no visible window.
  s = s.replace(/show:\s*false/g, 'show: true');

  if (!s.includes('[electron-window] created main window')) {
    s = s.replace(
      /(mainWindow\s*=\s*new BrowserWindow\s*\([\s\S]*?\}\s*\);)/,
      `$1\n  console.log('[electron-window] created main window');\n  setTimeout(() => {\n    try {\n      if (mainWindow && !mainWindow.isDestroyed()) {\n        mainWindow.show();\n        if (mainWindow.isMinimized()) mainWindow.restore();\n        mainWindow.focus();\n        console.log('[electron-window] forced show/focus');\n      }\n    } catch (error) {\n      console.warn('[electron-window] force show failed:', error?.message || error);\n    }\n  }, 1500);`
    );
  }

  if (!s.includes('[electron-window] renderer did-fail-load')) {
    s = s.replace(
      /(mainWindow\.webContents\.setWindowOpenHandler\([^;]*;)/,
      `$1\n  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {\n    console.error('[electron-window] renderer did-fail-load:', errorCode, errorDescription, validatedURL);\n    try { mainWindow?.show(); mainWindow?.webContents.openDevTools({ mode: 'detach' }); } catch {}\n  });\n  mainWindow.webContents.on('did-finish-load', () => {\n    console.log('[electron-window] renderer did-finish-load');\n    try { mainWindow?.show(); mainWindow?.focus(); } catch {}\n  });`
    );
  }

  if (s !== before) {
    fs.writeFileSync(file, s, 'utf8');
    changed = true;
    console.log(`[patch-electron-window-show] patched ${file}`);
  }
}

console.log(changed ? '[patch-electron-window-show] applied' : '[patch-electron-window-show] no changes needed');
