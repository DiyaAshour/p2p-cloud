#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const files = {
  preload: path.join(root, 'electron', 'preload.cjs'),
  engine: path.join(root, 'electron', 'company-drive-ipc.js'),
  hardening: path.join(root, 'electron', 'company-drive-hardening-ipc.js'),
  liveCompat: path.join(root, 'electron', 'company-drive-live-compat-ipc.js'),
  liveUi: path.join(root, 'client', 'src', 'NativeP2PAppLive.tsx'),
  joinPatch: path.join(root, 'scripts', 'patch-live-join-company-drive.cjs'),
};

function read(label) {
  const file = files[label];
  if (!fs.existsSync(file)) throw new Error(`Missing ${label}: ${path.relative(root, file)}`);
  return fs.readFileSync(file, 'utf8');
}

function mustInclude(label, text, needle) {
  if (!text.includes(needle)) {
    throw new Error(`${label} is missing: ${needle}`);
  }
}

const preload = read('preload');
const engine = read('engine');
const hardening = read('hardening');
const liveCompat = read('liveCompat');
const liveUi = read('liveUi');
const joinPatch = read('joinPatch');

for (const channel of [
  'company:state',
  'company:deviceIdentity',
  'company:createWorkspace',
  'company:inviteMember',
  'company:changeMemberRole',
  'company:removeMember',
  'company:addFile',
  'company:updateFile',
]) {
  mustInclude('preload.cjs', preload, channel);
  mustInclude('NativeP2PAppLive.tsx', liveUi, channel);
  mustInclude('company-drive-live-compat-ipc.js', liveCompat, channel);
}

for (const channel of ['company:importWorkspaceAccess']) {
  mustInclude('preload.cjs', preload, channel);
  mustInclude('company-drive-live-compat-ipc.js', liveCompat, channel);
  mustInclude('patch-live-join-company-drive.cjs', joinPatch, channel);
}

mustInclude('company-drive-ipc.js', engine, 'company-drive-hardening-ipc.js');
mustInclude('company-drive-hardening-ipc.js', hardening, 'company-drive-live-compat-ipc.js');
mustInclude('company-drive-live-compat-ipc.js', liveCompat, 'workspaceId');
mustInclude('company-drive-live-compat-ipc.js', liveCompat, 'company-files.json');
mustInclude('company-drive-live-compat-ipc.js', liveCompat, 'file && typeof payload.file');
mustInclude('company-drive-live-compat-ipc.js', liveCompat, 'Only the Company Drive owner');
mustInclude('patch-live-join-company-drive.cjs', joinPatch, 'const joinCompanyDrive = () =>');
mustInclude('patch-live-join-company-drive.cjs', joinPatch, 'Join Company Drive');
mustInclude('patch-live-join-company-drive.cjs', joinPatch, 'Join with token');

if (liveUi.includes('const joinCompanyDrive = () =>')) {
  mustInclude('NativeP2PAppLive.tsx', liveUi, 'company:importWorkspaceAccess');
  mustInclude('NativeP2PAppLive.tsx', liveUi, 'Join Company Drive');
  console.log('[company-drive-live-contract] Join UI is already patched.');
} else {
  console.warn('[company-drive-live-contract] Join UI patch is available but not applied yet. Run: pnpm run patch:join-company');
}

console.log('[company-drive-live-contract] OK');
console.log('Verified: preload channels, Live UI channels, loader chain, workspaceId support, file-object addFile, owner-only controls, and Join Company patch availability.');
