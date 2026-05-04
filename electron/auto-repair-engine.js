export function createAutoRepairEngine({
  getNode,
  getManifests,
  repairManifests,
  configuredTargetReplicas = 3,
  persistManifests,
  syncPush,
  intervalMs = Number(process.env.P2P_AUTO_REPAIR_INTERVAL_MS || 60000),
} = {}) {
  let timer = null;
  let running = false;
  let lastRunAt = null;
  let lastReport = [];
  let lastError = null;
  let runCount = 0;

  async function runOnce(reason = 'manual') {
    if (running) {
      return { ok: true, skipped: true, reason: 'already-running', lastRunAt, lastReport, lastError };
    }

    running = true;
    try {
      const node = getNode?.();
      const manifests = getManifests?.() || [];
      if (!node) throw new Error('P2P node is not running');

      const result = await repairManifests({
        node,
        manifests,
        configuredTargetReplicas,
        persistManifests,
        syncPush,
      });

      runCount += 1;
      lastRunAt = new Date().toISOString();
      lastReport = Array.isArray(result?.report) ? result.report : [];
      lastError = null;
      return { ok: true, reason, runCount, lastRunAt, changed: Boolean(result?.changed), report: lastReport };
    } catch (error) {
      lastError = error?.message || String(error);
      return { ok: false, reason, lastRunAt, lastError, report: lastReport };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return status();
    timer = setInterval(() => {
      void runOnce('interval');
    }, Math.max(10000, Number(intervalMs || 60000)));
    timer.unref?.();
    void runOnce('startup');
    return status();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    return status();
  }

  function status() {
    return {
      ok: true,
      enabled: Boolean(timer),
      running,
      intervalMs: Math.max(10000, Number(intervalMs || 60000)),
      runCount,
      lastRunAt,
      lastError,
      lastReport,
    };
  }

  return { start, stop, runOnce, status };
}
