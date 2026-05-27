const fs = require('node:fs');
const path = require('node:path');
const { IPC_CHANNELS } = require('../electron/ipc-contract.cjs');

const root = process.cwd();
const ignoredDirs = new Set(['.git', 'node_modules', '.pnpm-store', 'dist', 'release', 'coverage']);
const sourceDirs = ['electron', 'client/src'];
const channelPattern = /['"]([a-z][a-z0-9-]*:[a-zA-Z0-9-]+)['"]/g;
const knownNonIpcPrefixes = new Set(['http:', 'https:', 'ws:', 'wss:', 'file:', 'data:']);
const contractSet = new Set(IPC_CHANNELS);

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) walk(absolute, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(cjs|mjs|js|jsx|ts|tsx)$/.test(entry.name)) continue;
    files.push(absolute);
  }
  return files;
}

const failures = [];
const discovered = new Map();

for (const sourceDir of sourceDirs) {
  for (const file of walk(path.join(root, sourceDir))) {
    const relative = path.relative(root, file).replace(/\\/g, '/');
    if (relative === 'electron/ipc-contract.cjs') continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(channelPattern)) {
      const channel = match[1];
      const prefix = channel.split(':')[0] + ':';
      if (knownNonIpcPrefixes.has(prefix)) continue;
      if (!discovered.has(channel)) discovered.set(channel, new Set());
      discovered.get(channel).add(relative);
      if (!contractSet.has(channel)) failures.push(`${relative}: IPC-like channel is not in electron/ipc-contract.cjs -> ${channel}`);
    }
  }
}

const duplicateChannels = IPC_CHANNELS.filter((channel, index) => IPC_CHANNELS.indexOf(channel) !== index);
for (const channel of duplicateChannels) failures.push(`Duplicate IPC channel in contract: ${channel}`);

if (!contractSet.has('p2p:downloadToPath')) failures.push('Missing required large-file download channel: p2p:downloadToPath');
if (!contractSet.has('p2p:uploadFiles')) failures.push('Missing required upload channel: p2p:uploadFiles');
if (!contractSet.has('p2p:listFiles')) failures.push('Missing required file listing channel: p2p:listFiles');
if (!contractSet.has('p2p:networkSummary')) failures.push('Missing required network summary channel: p2p:networkSummary');

if (failures.length > 0) {
  console.error('[verify-ipc-contract] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-ipc-contract] ok:', {
  contractChannels: IPC_CHANNELS.length,
  discoveredChannels: discovered.size,
});
