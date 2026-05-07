# Big download fix

The current `p2p:download` path returns `bytes` to the React renderer. Large files such as 600 MB can fail with `RangeError: Invalid array length` because the renderer receives a huge array through IPC.

Required safe fix:

1. Keep the existing `p2p:download` path for small files.
2. Add a new `p2p:downloadToPath` IPC path for large files.
3. Let Electron main choose a save location with `dialog.showSaveDialog`.
4. Fetch chunks in main process and write them directly to a temporary file.
5. For encrypted files, decrypt chunk-by-chunk using the existing AES-GCM metadata.
6. Rename the temporary file after integrity verification succeeds.
7. In the UI, route files >= 100 MB to `p2p:downloadToPath` and keep small files on the old browser Blob path.

This avoids returning 600 MB / 5 GB arrays to the renderer and prevents the IPC/Chromium memory crash.
