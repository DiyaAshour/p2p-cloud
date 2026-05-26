// Runs Company Drive compatibility after the base company handlers finish registering.
setImmediate(() => {
  import('./company-drive-live-compat-ipc.js').catch((error) => {
    console.warn('[company-drive] live compatibility failed:', error?.message || error);
  });
});
