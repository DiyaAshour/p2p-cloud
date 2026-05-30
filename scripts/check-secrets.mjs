#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ALLOWED_ENV_PLACEHOLDER = [
  '# This file is intentionally sanitized.',
  '# Do not commit real local environment values.',
  '# Copy .env.example to .env on your own machine/server and fill the values locally.',
].join('\n');

const BLOCKED_TRACKED_ENV_FILES = new Set([
  '.env.local',
  '.env.development.local',
  '.env.test.local',
  '.env.production.local',
]);

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.pnpm-store',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '.parcel-cache',
  'tmp',
  'temp',
]);

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.yml', '.yaml', '.env', '.example', '.txt', '.sh', '.ps1', '.html', '.css', '.gitignore', ''
]);

const directEnvSecretPatterns = [
  { name: 'PayPal client secret literal', re: /^\s*PAYPAL_CLIENT_SECRET\s*=\s*(?!replace-with|your_|$)[^\s#]{12,}/im },
  { name: 'Plan unlock secret literal', re: /^\s*(?:P2P_)?PLAN_UNLOCK_SECRET\s*=\s*(?!replace-with|your_|$)[^\s#]{16,}/im },
  { name: 'Manifest auth secret literal', re: /^\s*(?:P2P_)?MANIFEST_SYNC_AUTH_SECRET\s*=\s*(?!replace-with|your_|$)[^\s#]{16,}/im },
  { name: 'Storage admin token literal', re: /^\s*STORAGE_PEER_ADMIN_TOKEN\s*=\s*(?!replace-with|your_|$)[^\s#]{16,}/im },
  { name: 'Safety peer delete token literal', re: /^\s*P2P_SAFETY_PEER_DELETE_TOKEN\s*=\s*(?!replace-with|your_|$)[^\s#]{16,}/im },
];

const sourceSecretPatterns = [
  { name: 'Private key material', re: /-----BEGIN (?:RSA |EC |OPENSSH |PRIVATE )?PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9_]{30,}/ },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Generic hardcoded secret assignment', re: /(?:secret|token|password|private[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-/.+=]{24,}['"]/i },
];

function normalizeText(content = '') {
  return String(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replaceAll('\\', '/');
    if (entry.isDirectory()) walk(full, out);
    else out.push(rel);
  }
  return out;
}

function isTextCandidate(file) {
  const base = path.basename(file);
  if (base === '.gitignore' || base.startsWith('.env')) return true;
  return TEXT_EXTENSIONS.has(path.extname(file));
}

function isEnvLikeFile(file) {
  const base = path.basename(file);
  return base === '.env' || base.startsWith('.env') || file.endsWith('.env') || file.endsWith('.env.example');
}

function readFile(file) {
  return normalizeText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

const failures = [];

for (const file of walk(ROOT).filter(isTextCandidate)) {
  const base = path.basename(file);
  const content = readFile(file);

  if (BLOCKED_TRACKED_ENV_FILES.has(base)) {
    failures.push(`${file}: tracked local env file must not be committed`);
  }

  if (base === '.env' && content.trim() !== ALLOWED_ENV_PLACEHOLDER.trim()) {
    failures.push(`${file}: .env must stay sanitized; put real values only on your machine/server`);
  }

  if (file !== '.env.example' && isEnvLikeFile(file)) {
    for (const pattern of directEnvSecretPatterns) {
      if (pattern.re.test(content)) failures.push(`${file}: ${pattern.name}`);
    }
  }

  for (const pattern of sourceSecretPatterns) {
    if (file === '.env.example') continue;
    if (pattern.re.test(content)) failures.push(`${file}: ${pattern.name}`);
  }
}

if (failures.length) {
  console.error('\nSecret audit failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error('\nFix: remove real secrets from Git, keep only placeholders, then rotate any leaked keys.\n');
  process.exit(1);
}

console.log('Secret audit passed: no obvious committed secrets found.');
