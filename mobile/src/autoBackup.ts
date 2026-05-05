import * as MediaLibrary from 'expo-media-library';
import { loadLastMediaId, saveLastMediaId, type PersistedBackupQueueItem } from './storage';

export async function requestAutoBackupPermissions() {
  const permission = await MediaLibrary.requestPermissionsAsync();
  if (!permission.granted) throw new Error('Media library permission is required for automatic backup.');
  return true;
}

export async function scanRecentMediaForBackup(limit = 50): Promise<PersistedBackupQueueItem[]> {
  await requestAutoBackupPermissions();
  const lastMediaId = await loadLastMediaId();
  const page = await MediaLibrary.getAssetsAsync({
    first: limit,
    mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],
  });

  const assets = [];
  for (const asset of page.assets) {
    if (lastMediaId && asset.id === lastMediaId) break;
    assets.push(asset);
  }

  if (page.assets[0]?.id) await saveLastMediaId(page.assets[0].id);

  return assets.reverse().map((asset) => ({
    id: `media-${asset.id}`,
    uri: asset.uri,
    name: asset.filename || `${asset.mediaType}-${asset.id}`,
    mimeType: asset.mediaType === MediaLibrary.MediaType.video ? 'video/mp4' : 'image/jpeg',
    status: 'queued',
    progress: 0,
    createdAt: new Date().toISOString(),
  }));
}
