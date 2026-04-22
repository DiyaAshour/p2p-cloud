import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ElectronP2PNode } from './p2p-node.js';

if (typeof globalThis.CustomEvent !== 'function') {
  class NodeCustomEvent extends Event {
    constructor(type, params = {}) {
      super(type, params);
      this.detail = params.detail ?? null;
    }
  }
  globalThis.CustomEvent = NodeCustomEvent;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const vaultDir = path.resolve(__dirname, '..', 'uploads');
const manifestsDir = path.join(vaultDir, 'manifests');
const onboardingPath = path.join(vaultDir, 'onboarding.json');
const earningsPath = path.join(vaultDir, 'earnings.json');
const p2pNode = new ElectronP2PNode({ vaultDir });

async function ensureDirs() {
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(manifestsDir, { recursive: true });
}

async function saveManifest(manifest) {
  const filePath = path.join(manifestsDir, `${manifest.fileId}.json`);
  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
}

async function readManifest(fileId) {
  const filePath = path.join(manifestsDir, `${fileId}.json`);
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

async function saveOnboardingSession(payload) {
  await fs.writeFile(onboardingPath, JSON.stringify(payload, null, 2), 'utf-8');
}

async function readOnboardingSession() {
  try {
    const content = await fs.readFile(onboardingPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function readEarnings() {
  try {
    const content = await fs.readFile(earningsPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveEarnings(data) {
  await fs.writeFile(earningsPath, JSON.stringify(data, null, 2), 'utf-8');
}

async function main() {
  await ensureDirs();
  await p2pNode.start();
  console.log('[headless-p2p] started', p2pNode.getStatus());
}

process.on('SIGINT', async () => {
  try {
    await p2pNode.stop();
  } finally {
    process.exit(0);
  }
});

process.on('SIGTERM', async () => {
  try {
    await p2pNode.stop();
  } finally {
    process.exit(0);
  }
});

main().catch((error) => {
  console.error('[headless-p2p] failed:', error);
  process.exit(1);
});

export {
  p2pNode,
  saveManifest,
  readManifest,
  saveOnboardingSession,
  readOnboardingSession,
  readEarnings,
  saveEarnings,
};
