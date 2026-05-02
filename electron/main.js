import { app, ipcMain } from 'electron';
import { startP2PTransport } from './p2p-transport.js';

let transportNode = null;

ipcMain.handle('p2p:start', async (_event, options = {}) => {
  if (!transportNode) {
    transportNode = startP2PTransport(options);
  }
  return { ok: true, peerId: transportNode.peerId, port: transportNode.port };
});

app.whenReady().then(async () => {
  transportNode = startP2PTransport({});
  console.log('P2P Transport started');
}).catch((error) => {
  console.error('Electron failed:', error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  // keep app running as background node
});
