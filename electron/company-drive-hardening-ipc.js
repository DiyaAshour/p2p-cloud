// Company Drive hardening now delegates to the Live UI compatibility layer.
// This file is imported by company-drive-ipc.js, so keep it small and stable.
setImmediate(() => {
  import('./company-drive-live-compat-ipc.js').catch((error) => {
    console.warn('[company-drive] live compatibility failed:', error?.message || error);
  });
});
