import * as SecureStore from 'expo-secure-store';

const WALLET_KEY = 'p2pcloud.mobile.wallet';
const DRIVE_PASSWORD_KEY = 'p2pcloud.mobile.drivePassword';
const AUTO_BACKUP_KEY = 'p2pcloud.mobile.autoBackupEnabled';

export async function saveWallet(address: string) {
  await SecureStore.setItemAsync(WALLET_KEY, address);
}

export async function loadWallet() {
  return SecureStore.getItemAsync(WALLET_KEY);
}

export async function clearWallet() {
  await SecureStore.deleteItemAsync(WALLET_KEY);
}

export async function saveDrivePassword(password: string) {
  await SecureStore.setItemAsync(DRIVE_PASSWORD_KEY, password);
}

export async function loadDrivePassword() {
  return SecureStore.getItemAsync(DRIVE_PASSWORD_KEY);
}

export async function clearDrivePassword() {
  await SecureStore.deleteItemAsync(DRIVE_PASSWORD_KEY);
}

export async function setAutoBackupEnabled(enabled: boolean) {
  await SecureStore.setItemAsync(AUTO_BACKUP_KEY, enabled ? '1' : '0');
}

export async function getAutoBackupEnabled() {
  return (await SecureStore.getItemAsync(AUTO_BACKUP_KEY)) === '1';
}
