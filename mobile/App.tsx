import React, { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Image, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { Buffer } from 'buffer';
import { Ionicons } from '@expo/vector-icons';
import { buildEncryptedMobileUpload, assertDrivePassword, assertWallet } from './src/cryptoDrive';
import { CONFIG, StoredManifest, deleteWalletManifest, downloadAndDecryptManifest, listWalletManifests, pushWalletManifest, uploadChunksToStoragePeer } from './src/p2pApi';
import { clearDrivePassword, clearWallet, loadDrivePassword, loadWallet, saveDrivePassword, saveWallet } from './src/storage';

const COLORS = {
  bg: '#05060a',
  panel: '#11131c',
  panel2: '#171a25',
  border: '#262b3a',
  text: '#f8fafc',
  muted: '#94a3b8',
  cyan: '#67e8f9',
  green: '#86efac',
  amber: '#fcd34d',
  red: '#fca5a5',
};

type QueueItem = {
  id: string;
  name: string;
  status: 'queued' | 'encrypting' | 'uploading' | 'manifest' | 'done' | 'failed';
  progress: number;
  error?: string;
};

function short(address = '') {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'Not connected';
}

function bytes(n = 0) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${n} B`;
}

function fileBase(name = '') {
  const parts = String(name).split('/').filter(Boolean);
  return parts[parts.length - 1] || name || 'file';
}

async function readUriAsBytes(uri: string) {
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  return Buffer.from(base64, 'base64');
}

export default function App() {
  const [wallet, setWallet] = useState('');
  const [drivePassword, setDrivePassword] = useState('');
  const [manifests, setManifests] = useState<StoredManifest[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [autoBackupEnabled, setAutoBackupEnabled] = useState(false);
  const [message, setMessage] = useState('Ready');

  const connected = useMemo(() => /^0x[a-fA-F0-9]{40}$/.test(wallet.trim()), [wallet]);
  const unlocked = drivePassword.trim().length >= CONFIG.minDrivePasswordLength;
  const totalBytes = manifests.reduce((sum, item) => sum + Number(item.size || 0), 0);

  useEffect(() => {
    (async () => {
      const [savedWallet, savedPassword] = await Promise.all([loadWallet(), loadDrivePassword()]);
      if (savedWallet) setWallet(savedWallet);
      if (savedPassword) setDrivePassword(savedPassword);
    })().catch((error) => setMessage(error?.message || 'Failed to restore session'));
  }, []);

  useEffect(() => {
    if (connected) void refresh();
  }, [connected]);

  async function saveSession() {
    try {
      const normalized = assertWallet(wallet);
      assertDrivePassword(drivePassword, CONFIG.minDrivePasswordLength);
      await Promise.all([saveWallet(normalized), saveDrivePassword(drivePassword.trim())]);
      setWallet(normalized);
      setMessage('Secure session saved on this device');
      await refresh(normalized);
    } catch (error: any) {
      Alert.alert('Session not ready', error?.message || 'Check wallet and Drive Password.');
    }
  }

  async function disconnect() {
    await Promise.all([clearWallet(), clearDrivePassword()]);
    setWallet('');
    setDrivePassword('');
    setManifests([]);
    setMessage('Disconnected');
  }

  async function refresh(targetWallet = wallet) {
    if (!targetWallet || !/^0x[a-fA-F0-9]{40}$/.test(targetWallet)) return;
    setBusy(true);
    try {
      const data = await listWalletManifests(targetWallet.toLowerCase());
      setManifests(data);
      setMessage(`Loaded ${data.length} item(s)`);
    } catch (error: any) {
      setMessage(error?.message || 'Refresh failed');
    } finally {
      setBusy(false);
    }
  }

  function updateQueue(id: string, patch: Partial<QueueItem>) {
    setQueue((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function uploadLocalFile(input: { uri: string; name: string; mimeType?: string }) {
    const ownerWallet = assertWallet(wallet);
    assertDrivePassword(drivePassword, CONFIG.minDrivePasswordLength);
    const id = `${Date.now()}-${input.name}`;
    setQueue((items) => [{ id, name: input.name, status: 'queued', progress: 0 }, ...items]);
    try {
      updateQueue(id, { status: 'encrypting', progress: 5 });
      const fileBytes = await readUriAsBytes(input.uri);
      const upload = await buildEncryptedMobileUpload({
        ownerWallet,
        drivePassword,
        name: `Mobile Backup/${input.name}`,
        mimeType: input.mimeType,
        bytes: fileBytes,
        chunkSize: CONFIG.chunkSizeBytes,
      });
      updateQueue(id, { status: 'uploading', progress: 20 });
      await uploadChunksToStoragePeer(upload.chunks, (done, total) => updateQueue(id, { progress: 20 + Math.floor((done / total) * 65) }));
      updateQueue(id, { status: 'manifest', progress: 92 });
      await pushWalletManifest(upload.manifest);
      updateQueue(id, { status: 'done', progress: 100 });
      setMessage(`Uploaded ${input.name}`);
      await refresh(ownerWallet);
    } catch (error: any) {
      updateQueue(id, { status: 'failed', error: error?.message || 'Upload failed' });
      Alert.alert('Upload failed', error?.message || 'Upload failed');
    }
  }

  async function pickPhotos() {
    if (!connected || !unlocked) return Alert.alert('Unlock first', `Enter wallet and ${CONFIG.minDrivePasswordLength}+ character Drive Password.`);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return Alert.alert('Permission needed', 'Photo access is required for encrypted backup.');
    const result = await ImagePicker.launchImageLibraryAsync({ allowsMultipleSelection: true, quality: 1, mediaTypes: ImagePicker.MediaTypeOptions.All });
    if (result.canceled) return;
    for (const asset of result.assets) {
      await uploadLocalFile({ uri: asset.uri, name: asset.fileName || `photo-${Date.now()}.jpg`, mimeType: asset.mimeType || 'image/jpeg' });
    }
  }

  async function pickFiles() {
    if (!connected || !unlocked) return Alert.alert('Unlock first', `Enter wallet and ${CONFIG.minDrivePasswordLength}+ character Drive Password.`);
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return;
    for (const asset of result.assets) {
      await uploadLocalFile({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType || 'application/octet-stream' });
    }
  }

  async function enableAutoBackup() {
    const permission = await MediaLibrary.requestPermissionsAsync();
    if (!permission.granted) return Alert.alert('Permission needed', 'Media library permission is required for photo backup.');
    setAutoBackupEnabled(true);
    setMessage('Auto backup is prepared. Background scheduling is the next production step.');
    Alert.alert('Auto Backup prepared', 'The app now has media permissions. Production background backup can be enabled with native background tasks and upload queue persistence.');
  }

  async function downloadFile(item: StoredManifest) {
    if (!unlocked) return Alert.alert('Drive Password required', `Enter at least ${CONFIG.minDrivePasswordLength} characters.`);
    setBusy(true);
    try {
      setMessage(`Downloading ${fileBase(item.name)}...`);
      const plain = await downloadAndDecryptManifest(item, drivePassword, (done, total) => setMessage(`Downloading chunks ${done}/${total}`));
      const target = `${FileSystem.documentDirectory}${fileBase(item.name)}`;
      await FileSystem.writeAsStringAsync(target, Buffer.from(plain).toString('base64'), { encoding: FileSystem.EncodingType.Base64 });
      setMessage(`Saved to app documents: ${fileBase(item.name)}`);
      Alert.alert('Downloaded', `Saved inside app documents:\n${target}`);
    } catch (error: any) {
      Alert.alert('Download failed', error?.message || 'Download failed');
      setMessage(error?.message || 'Download failed');
    } finally {
      setBusy(false);
    }
  }

  async function deleteFile(item: StoredManifest) {
    Alert.alert('Delete file?', fileBase(item.name), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteWalletManifest(item.ownerWallet, item.hash);
            await refresh();
          } catch (error: any) {
            Alert.alert('Delete failed', error?.message || 'Delete failed');
          }
        },
      },
    ]);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <View style={styles.logo}><Ionicons name="cloud" size={26} color={COLORS.cyan} /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>p2p.cloud Mobile Pro</Text>
            <Text style={styles.subtitle}>Encrypted photo, video, and file backup</Text>
          </View>
        </View>

        <View style={styles.grid}>
          <View style={styles.stat}><Text style={styles.statLabel}>Files</Text><Text style={styles.statValue}>{manifests.length}</Text></View>
          <View style={styles.stat}><Text style={styles.statLabel}>Storage</Text><Text style={styles.statValue}>{bytes(totalBytes)}</Text></View>
          <View style={styles.stat}><Text style={styles.statLabel}>Mode</Text><Text style={styles.statValue}>Pro</Text></View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Secure unlock</Text>
          <TextInput style={styles.input} autoCapitalize="none" autoCorrect={false} placeholder="0x wallet address" placeholderTextColor={COLORS.muted} value={wallet} onChangeText={setWallet} />
          <TextInput style={styles.input} secureTextEntry placeholder={`Drive Password (${CONFIG.minDrivePasswordLength}+ characters)`} placeholderTextColor={COLORS.muted} value={drivePassword} onChangeText={setDrivePassword} />
          <View style={styles.row}>
            <Pressable style={[styles.button, styles.primary]} onPress={saveSession}><Text style={styles.primaryText}>Save & Sync</Text></Pressable>
            <Pressable style={styles.button} onPress={disconnect}><Text style={styles.buttonText}>Disconnect</Text></Pressable>
          </View>
          <Text style={styles.hint}>{connected ? `Wallet ${short(wallet)}` : 'Enter wallet'} · {unlocked ? 'Drive unlocked' : 'Password needed'}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Backup actions</Text>
          <View style={styles.row}>
            <Pressable style={[styles.button, styles.primary]} onPress={pickPhotos} disabled={busy}><Text style={styles.primaryText}>Upload photos</Text></Pressable>
            <Pressable style={[styles.button, styles.primary]} onPress={pickFiles} disabled={busy}><Text style={styles.primaryText}>Upload files</Text></Pressable>
          </View>
          <Pressable style={[styles.button, autoBackupEnabled && styles.success]} onPress={enableAutoBackup}><Text style={styles.buttonText}>{autoBackupEnabled ? 'Auto backup prepared' : 'Prepare auto photo backup'}</Text></Pressable>
        </View>

        {!!queue.length && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Upload queue</Text>
            {queue.slice(0, 8).map((item) => (
              <View key={item.id} style={styles.queueItem}>
                <Text style={styles.fileName}>{item.name}</Text>
                <Text style={styles.hint}>{item.status} · {item.progress}% {item.error ? `· ${item.error}` : ''}</Text>
                <View style={styles.progress}><View style={[styles.progressFill, { width: `${item.progress}%` }]} /></View>
              </View>
            ))}
          </View>
        )}

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>Your drive</Text>
            <Pressable onPress={() => refresh()}><Text style={styles.link}>Refresh</Text></Pressable>
          </View>
          <Text style={styles.hint}>{message}</Text>
          <FlatList
            data={manifests}
            scrollEnabled={false}
            keyExtractor={(item) => item.hash}
            renderItem={({ item }) => (
              <View style={styles.fileRow}>
                <View style={styles.fileIcon}><Ionicons name={String(item.mimeType || '').startsWith('image/') ? 'image' : 'document'} size={22} color={COLORS.cyan} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fileName}>{fileBase(item.name)}</Text>
                  <Text style={styles.hint}>{bytes(item.size)} · {new Date(item.uploadedAt).toLocaleDateString()}</Text>
                </View>
                <Pressable onPress={() => downloadFile(item)} style={styles.iconButton}><Ionicons name="download" size={20} color={COLORS.green} /></Pressable>
                <Pressable onPress={() => deleteFile(item)} style={styles.iconButton}><Ionicons name="trash" size={20} color={COLORS.red} /></Pressable>
              </View>
            )}
            ListEmptyComponent={<Text style={styles.empty}>No files yet. Upload your first encrypted mobile backup.</Text>}
          />
        </View>

        <Text style={styles.footer}>Manifest: {CONFIG.manifestSyncUrl}\nStorage peer: {CONFIG.storagePeerUrl}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  container: { padding: 18, paddingBottom: 48 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 18, marginTop: Platform.OS === 'android' ? 18 : 4 },
  logo: { width: 52, height: 52, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0e749033', borderWidth: 1, borderColor: '#67e8f966' },
  title: { color: COLORS.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: COLORS.muted, marginTop: 2 },
  grid: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  stat: { flex: 1, backgroundColor: COLORS.panel, borderRadius: 18, padding: 14, borderWidth: 1, borderColor: COLORS.border },
  statLabel: { color: COLORS.muted, fontSize: 12 },
  statValue: { color: COLORS.text, fontSize: 18, fontWeight: '800', marginTop: 6 },
  card: { backgroundColor: COLORS.panel, borderRadius: 22, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: COLORS.border },
  cardTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800', marginBottom: 12 },
  input: { backgroundColor: COLORS.panel2, color: COLORS.text, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 13, borderWidth: 1, borderColor: COLORS.border, marginBottom: 10 },
  row: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  button: { backgroundColor: COLORS.panel2, borderRadius: 14, paddingVertical: 13, paddingHorizontal: 14, borderWidth: 1, borderColor: COLORS.border, marginBottom: 10 },
  primary: { backgroundColor: COLORS.cyan, borderColor: COLORS.cyan },
  success: { borderColor: COLORS.green, backgroundColor: '#16653455' },
  buttonText: { color: COLORS.text, fontWeight: '700' },
  primaryText: { color: COLORS.bg, fontWeight: '900' },
  hint: { color: COLORS.muted, fontSize: 12, marginTop: 2 },
  link: { color: COLORS.cyan, fontWeight: '800' },
  queueItem: { backgroundColor: COLORS.panel2, borderRadius: 14, padding: 12, marginBottom: 8 },
  progress: { height: 6, borderRadius: 10, backgroundColor: '#334155', marginTop: 8, overflow: 'hidden' },
  progressFill: { height: 6, backgroundColor: COLORS.cyan },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  fileIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.panel2 },
  fileName: { color: COLORS.text, fontWeight: '700' },
  iconButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: COLORS.panel2 },
  empty: { color: COLORS.muted, paddingVertical: 20, textAlign: 'center' },
  footer: { color: '#64748b', textAlign: 'center', fontSize: 11, marginTop: 8 },
});
