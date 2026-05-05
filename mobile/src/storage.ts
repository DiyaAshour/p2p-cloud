import * as SecureStore from 'expo-secure-store';

const WALLET_KEY = 'p2pcloud.mobile.wallet';
const DRIVE_PASSWORD_KEY = 'p2pcloud.mobile.drivePassword';
const AUTO_BACKUP_KEY = 'p2pcloud.mobile.autoBackupEnabled';
const QUEUE_KEY = 'p2pcloud.mobile.backupQueue';
const LAST_MEDIA_ID_KEY = 'p2pcloud.mobile.lastMediaId';

export type PersistedBackupQueueItem = {
  id: string;
  uri: string;
  name: string;
  mimeType?: string;
  status: 'queued' | 'encrypting' | 'uploading' | 'manifest' | 'done' | 'failed';
  progress: number;
  createdAt: string;
  error?: string;
};

function safeParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

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
  await SecureStore.setItemAsync(DRIVE_PASSWORD_KEY, password, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
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

export async function saveBackupQueue(items: PersistedBackupQueueItem[]) {
  await SecureStore.setItemAsync(QUEUE_KEY, JSON.stringify(items.slice(0, 200)));
}

export async function loadBackupQueue() {
  return safeParse<PersistedBackupQueueItem[]>(await SecureStore.getItemAsync(QUEUE_KEY), []);
}

export async function clearCompletedBackupQueue() {
  const items = await loadBackupQueue();
  const active = items.filter((item) => item.status !== 'done');
  await saveBackupQueue(active);
  return active;
}

export async function saveLastMediaId(id: string) {
  await SecureStore.setItemAsync(LAST_MEDIA_ID_KEY, id);
}

export async function loadLastMediaId() {
  return SecureStore.getItemAsync(LAST_MEDIA_ID_KEY);
}
