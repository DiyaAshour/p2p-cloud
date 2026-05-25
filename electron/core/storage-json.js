import fs from 'node:fs';
import path from 'node:path';
import { manifestsPath, walletPath } from './storage-paths.js';

export function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

export function readWallet() {
  return readJson(walletPath(), {});
}

export function writeWallet(value = {}) {
  writeJson(walletPath(), value && typeof value === 'object' ? value : {});
}

export function readManifests() {
  const value = readJson(manifestsPath(), []);
  return Array.isArray(value) ? value : [];
}

export function writeManifests(value) {
  writeJson(manifestsPath(), Array.isArray(value) ? value : []);
}
