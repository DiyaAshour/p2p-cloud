import { useState, useCallback, useEffect } from 'react';
import { storageService, FileMetadata, StorageQuota, VaultStats } from '@/services/storageService';

const emptyStats: VaultStats = {
  totalFiles: 0,
  encryptedFiles: 0,
  publicFiles: 0,
  totalBytes: 0,
  totalMB: 0,
};

export function useStorage() {
  const [encryptionKey, setEncryptionKey] = useState<string | null>(null);
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [quota, setQuota] = useState<StorageQuota>(storageService.getStorageQuota());
  const [stats, setStats] = useState<VaultStats>(emptyStats);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshFiles = useCallback(async () => {
    setIsLoading(true);
    try {
      const [fileList, vaultStats] = await Promise.all([
        storageService.listFiles(),
        storageService.getStats(),
      ]);
      setFiles(fileList);
      setStats(vaultStats);
      setQuota(storageService.getStorageQuota());
    } catch (err) {
      console.error('Failed to refresh files:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  const uploadFile = useCallback(
    async (file: File, indexed: boolean = false, peerId: string = '', encrypt: boolean = false) => {
      setIsLoading(true);
      setError(null);
      try {
        const key = encrypt && encryptionKey ? encryptionKey : undefined;
        const metadata = await storageService.addFile(file, indexed, peerId, key);
        await refreshFiles();
        return metadata;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to upload file';
        setError(errorMessage);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [encryptionKey, refreshFiles]
  );

  const downloadFile = useCallback(
    async (file: FileMetadata) => {
      setIsLoading(true);
      setError(null);
      try {
        const key = file.isEncrypted ? encryptionKey ?? undefined : undefined;
        const downloadedFile = await storageService.getFile(file, key);
        if (!downloadedFile) {
          throw new Error('File not found');
        }

        const url = window.URL.createObjectURL(downloadedFile);
        const a = document.createElement('a');
        a.href = url;
        a.download = downloadedFile.name;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        return downloadedFile;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to download file';
        setError(errorMessage);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [encryptionKey]
  );

  const deleteFile = useCallback(
    async (fileHash: string) => {
      setIsLoading(true);
      setError(null);
      try {
        await storageService.deleteFile(fileHash);
        await refreshFiles();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to delete file';
        setError(errorMessage);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [refreshFiles]
  );

  const searchFiles = useCallback(async (query: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const results = await storageService.searchFiles(query);
      setFiles(results);
      return results;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to search files';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    files,
    quota,
    stats,
    isLoading,
    error,
    uploadFile,
    downloadFile,
    encryptionKey,
    setEncryptionKey,
    deleteFile,
    searchFiles,
    refreshFiles,
  };
}
