const manifestSyncUrl = process.env.EXPO_PUBLIC_MANIFEST_SYNC_URL || 'http://localhost:8790';
const storagePeerUrl = process.env.EXPO_PUBLIC_STORAGE_PEER_URL || 'ws://localhost:8787';

export default {
  expo: {
    name: 'p2p.cloud Mobile',
    slug: 'p2p-cloud-mobile',
    version: '0.1.0',
    orientation: 'portrait',
    scheme: 'p2pcloud',
    userInterfaceStyle: 'dark',
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'cloud.p2p.mobile',
      infoPlist: {
        NSPhotoLibraryUsageDescription: 'p2p.cloud needs photo access to back up encrypted photos.',
        NSPhotoLibraryAddUsageDescription: 'p2p.cloud can save downloaded files to your device.',
      },
    },
    android: {
      package: 'cloud.p2p.mobile',
      permissions: ['READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'READ_EXTERNAL_STORAGE'],
    },
    extra: {
      manifestSyncUrl,
      storagePeerUrl,
      minDrivePasswordLength: 12,
      chunkSizeBytes: 1048576,
    },
  },
};
