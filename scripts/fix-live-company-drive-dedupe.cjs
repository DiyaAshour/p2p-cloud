#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const liveFile = path.join(root, 'client', 'src', 'NativeP2PAppLive.tsx');
const preloadFile = path.join(root, 'electron', 'preload.cjs');
const seedFile = path.join(root, 'electron', 'seed-auth-cooldown-ipc.js');

function read(file) {
  if (!fs.existsSync(file)) {
    console.error('[fix-live-company-drive-dedupe] missing ' + path.relative(root, file));
    process.exit(1);
  }
  return fs.readFileSync(file, 'utf8');
}

function write(file, content) {
  fs.writeFileSync(file, content, 'utf8');
}

function dedupeExactLine(source, line) {
  const lines = source.split(/\r?\n/);
  let seen = false;
  const next = [];
  for (const current of lines) {
    if (current.trim() === line.trim()) {
      if (seen) continue;
      seen = true;
    }
    next.push(current);
  }
  return next.join('\n');
}

function ensureLineAfter(source, anchor, line) {
  source = dedupeExactLine(source, line);
  if (!source.includes(anchor)) return source;
  if (source.includes(line)) return source;
  return source.replace(anchor, anchor + '\n' + line);
}

function patchLive() {
  let source = read(liveFile);

  const hiddenKey = 'const PERSONAL_HIDDEN_COMPANY_FILES_KEY = "chunknet.ui.personalHiddenCompanyFiles";';
  const foldersKey = 'const COMPANY_FOLDERS_KEY = "chunknet.ui.companyFolders";';
  const anchor = 'const ACTIVE_WORKSPACE_KEY = "chunknet.ui.activeWorkspace";';

  source = dedupeExactLine(source, hiddenKey);
  source = dedupeExactLine(source, foldersKey);

  if (!source.includes(hiddenKey) && source.includes(anchor)) {
    source = source.replace(anchor, anchor + '\n' + hiddenKey);
  }

  if (!source.includes(foldersKey) && source.includes(hiddenKey)) {
    source = source.replace(hiddenKey, hiddenKey + '\n' + foldersKey);
  }

  source = source.replace(
    /\| "company:updateFile";\s*\| "audit:list"\s*\| "audit:record"\s*\| "audit:clear"\s*\| "audit:listManifests";/,
    '| "company:updateFile"\n  | "audit:list"\n  | "audit:record"\n  | "audit:clear"\n  | "audit:listManifests";'
  );

  source = dedupeExactLine(source, 'const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);');

  write(liveFile, source);
  console.log('[fix-live-company-drive-dedupe] NativeP2PAppLive constants deduped');
}

function patchPreload() {
  let source = read(preloadFile);
  const auditLines = [
    "  'audit:list',",
    "  'audit:record',",
    "  'audit:clear',",
    "  'audit:listManifests',",
  ];

  for (const line of auditLines) source = dedupeExactLine(source, line);

  if (!source.includes("'audit:record'")) {
    const anchor = "  'company:updateFile',";
    source = source.includes(anchor)
      ? source.replace(anchor, anchor + '\n' + auditLines.join('\n'))
      : source;
  }

  if (!source.includes("channel.startsWith('audit:')")) {
    source = source.replace(
      "channel.startsWith('company:') || channel.startsWith('drive:')",
      "channel.startsWith('company:') || channel.startsWith('audit:') || channel.startsWith('drive:')"
    );
  }

  write(preloadFile, source);
  console.log('[fix-live-company-drive-dedupe] preload audit allowlist ready');
}

function patchSeed() {
  let source = read(seedFile);
  const auditImport = "import './audit-p2p-ipc.js';";
  source = dedupeExactLine(source, auditImport);

  if (!source.includes(auditImport)) {
    const companyImport = "import './company-drive-ipc.js';";
    source = source.includes(companyImport)
      ? source.replace(companyImport, companyImport + '\n' + auditImport)
      : auditImport + '\n' + source;
  }

  write(seedFile, source);
  console.log('[fix-live-company-drive-dedupe] seed audit import ready');
}

patchLive();
patchPreload();
patchSeed();
console.log('[fix-live-company-drive-dedupe] OK');
