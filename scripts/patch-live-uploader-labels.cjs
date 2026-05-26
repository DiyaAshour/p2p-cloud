#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const file = path.join(root, 'client', 'src', 'NativeP2PAppLive.tsx');

function fail(message) {
  console.error('[patch-live-uploader-labels] ' + message);
  process.exit(1);
}

if (!fs.existsSync(file)) fail('Missing NativeP2PAppLive.tsx');
let source = fs.readFileSync(file, 'utf8');

if (!source.includes('uploadedByName?: string;')) {
  const anchor = `  ownerWallet?: string;\n  replicas?: string[];`;
  if (!source.includes(anchor)) fail('P2PFile type anchor not found');
  source = source.replace(
    anchor,
    `  ownerWallet?: string;\n  uploadedByName?: string;\n  uploadedByWallet?: string;\n  uploadedByDeviceId?: string;\n  replicas?: string[];`
  );
}

if (!source.includes('function uploaderLabel(file: P2PFile')) {
  const anchor = `  function folderStats(folder: DriveFolder) {`;
  if (!source.includes(anchor)) fail('folderStats anchor not found');
  const helper = `  function uploaderLabel(file: P2PFile, cf?: CompanyFile | null): string {
    const raw = String(
      cf?.uploadedByName ||
        cf?.uploadedByDeviceId ||
        file.uploadedByName ||
        file.uploadedByWallet ||
        file.uploadedByDeviceId ||
        file.ownerWallet ||
        ""
    ).trim();

    const currentId = String(wallet?.accountId || wallet?.address || "").trim().toLowerCase();
    const currentName = wallet?.username || identityLabel;

    if (!raw) return currentName || "Unknown";
    if (raw.toLowerCase() === currentId) return currentName || "You";
    if (raw.startsWith("seed:") || raw.startsWith("0x")) return short(raw);
    return raw.length > 36 ? short(raw) : raw;
  }

`;
  source = source.replace(anchor, helper + anchor);
}

const oldBlock = `            {cf?.uploadedByName && (
              <p className="text-xs text-zinc-500">by: {cf.uploadedByName}</p>
            )}`;
const newBlock = `            <p className="text-[11px] text-zinc-500">
              Uploaded by {uploaderLabel(file, cf)}
            </p>`;

if (source.includes(oldBlock)) {
  source = source.replace(oldBlock, newBlock);
} else if (!source.includes('Uploaded by {uploaderLabel(file, cf)}')) {
  fail('Uploader display block not found');
}

fs.writeFileSync(file, source, 'utf8');
console.log('[patch-live-uploader-labels] patched NativeP2PAppLive.tsx');
