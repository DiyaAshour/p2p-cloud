// Runs Company Drive hardening after the base company handlers finish registering.
// The base file currently imports hardening early, so this late loader forces a second
// isolated module execution with a query string and overrides the selected handlers.
setImmediate(async () => {
  try {
    await import(`./company-drive-hardening-ipc.js?late=${Date.now()}`);
  } catch (error) {
    console.warn('[company-drive] late hardening failed:', error?.message || error);
  }
});
