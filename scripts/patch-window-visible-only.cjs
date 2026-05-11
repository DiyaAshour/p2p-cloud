const fs = require('node:fs');

const file = 'electron/main.js';
if (!fs.existsSync(file)) {
  console.log('[patch-window-visible-only] electron/main.js not found');
} else {
  let s = fs.readFileSync(file, 'utf8');
  const before = s;

  s = s.replace(/show:\s*false/g, 'show: true');

  if (!s.includes('[window-visible] force show')) {
    s = s.replace(
      "mainWindow.on('closed', () => { mainWindow = null; });",
      "mainWindow.on('closed', () => { mainWindow = null; });\n  setTimeout(() => {\n    try {\n      if (mainWindow && !mainWindow.isDestroyed()) {\n        mainWindow.show();\n        mainWindow.focus();\n        console.log('[window-visible] force show');\n      }\n    } catch (error) {\n      console.warn('[window-visible] failed:', error?.message || error);\n    }\n  }, 1500);"
    );
  }

  if (s !== before) {
    fs.writeFileSync(file, s, 'utf8');
    console.log('[patch-window-visible-only] patched electron/main.js');
  } else {
    console.log('[patch-window-visible-only] already patched');
  }
}
