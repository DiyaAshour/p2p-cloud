import { useState, useCallback, useEffect } from 'react';
import { storageService, FileMetadata, StorageQuota } from '@/services/storageService';

export function useStorage() {
  const [encryptionKey, setEncryptionKey] = useState<string | null>(null);
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [quota, setQuota] = useState<StorageQuota>(storageService.getStorageQuota());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshFiles = useCallback(async () => {
    setIsLoading(true);
    try {
      const fileList = await storageService.listFiles();
      setFiles(fileList);
      setQuota(storageService.getStorageQuota());
    } catch (err) {
      console.error('Failed to refresh files:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load files on initial mount
  useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  const uploadFile = useCallback(
    async (file: File, indexed: boolean = false, peerId: string = "", encrypt: boolean = false) => {
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

  const downloadFile = useCallback(async (fileHash: string, decrypt: boolean = false) => {
    setIsLoading(true);
    setError(null);
    try {
      const key = decrypt && encryptionKey ? encryptionKey : undefined;
      const file = await storageService.getFile(fileHash, key);
      if (!file) {
        throw new Error('File not found');
      }
      
      // Trigger browser download
      const url = window.URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      return file;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to download file';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [encryptionKey]);

  const deleteFile = useCallback(async (fileHash: string) => {
    setIsLoading(true);
    setError(null);
    try {
      // Note: Delete API not implemented in server yet, but we'll update UI
      // await storageService.deleteFile(fileHash);
      await refreshFiles();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to delete file';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [refreshFiles]);

  const searchFiles = useCallback(async (query: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const results = await storageService.searchFiles(query);
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
