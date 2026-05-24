/**
 * electron/core/identity.js — Identity normalisation, validation, and guards.
 *
 * Modules that compare wallet addresses or seed identities should import from
 * here instead of re-implementing String().trim().toLowerCase() everywhere.
 */

export function normalizeIdentity(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function isValidWalletAddress(address = '') {
  return /^0x[a-fA-F0-9]{40}$/.test(String(address || '').trim());
}

export function isValidIdentity(identity = '') {
  const value = normalizeIdentity(identity);
  return isValidWalletAddress(value) || /^seed:[a-f0-9]{16,128}$/.test(value);
}

export function activeIdentity(walletState = {}) {
  return normalizeIdentity(walletState.accountId || walletState.address || '');
}

export function isVerifiedSeedIdentity(walletState = {}) {
  const accountId = String(walletState.accountId || walletState.address || '');
  return Boolean(
    walletState.connected &&
    walletState.verified &&
    walletState.authMode === 'seed' &&
    accountId.startsWith('seed:')
  );
}

export function assertVerifiedIdentity(walletState = {}) {
  if (isVerifiedSeedIdentity(walletState)) return;
  if (!walletState.connected || !walletState.verified || !activeIdentity(walletState)) {
    throw new Error('Verified identity required. Connect wallet or sign in with Seed Account first.');
  }
}

// Backward-compatible alias while older modules still say Wallet.
export const assertVerifiedWallet = assertVerifiedIdentity;

export function usedBytes(manifests = [], identity = '') {
  const normalized = normalizeIdentity(identity);
  return manifests
    .filter(
      (manifest) =>
        normalizeIdentity(manifest.ownerWallet) === normalized &&
        !manifest.isFolder &&
        manifest.kind !== 'folder' &&
        manifest.kind !== 'ui:prefs' &&
        !String(manifest.hash || '').startsWith('folder:') &&
        !String(manifest.hash || '').startsWith('ui:prefs:')
    )
    .reduce((sum, manifest) => sum + Number(manifest.size || 0), 0);
}
