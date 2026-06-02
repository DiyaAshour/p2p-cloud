import { execFile } from 'node:child_process';
import os from 'node:os';

function execNetsh(args = []) {
  return new Promise((resolve) => {
    execFile('netsh', args, { windowsHide: true }, (error, stdout = '', stderr = '') => {
      resolve({ ok: !error, error, stdout, stderr, args });
    });
  });
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function importantP2PPorts() {
  const basePorts = [
    normalizePort(process.env.P2P_TRANSPORT_PORT || 8787),
  ];

  const extraPorts = String(process.env.P2P_FIREWALL_EXTRA_PORTS || '')
    .split(',')
    .map((part) => normalizePort(part.trim()));

  return unique([...basePorts, ...extraPorts]);
}

export async function ensureWindowsFirewallRules({ ports = importantP2PPorts(), appPath = process.execPath } = {}) {
  if (os.platform() !== 'win32') {
    return { ok: true, skipped: true, reason: 'not-windows', ports: [] };
  }

  const safePorts = unique((ports || []).map(normalizePort));
  if (!safePorts.length) {
    return { ok: false, skipped: true, reason: 'no-valid-ports', ports: [] };
  }

  const results = [];

  for (const port of safePorts) {
    const ruleName = `Chunknet P2P TCP ${port} Inbound`;

    await execNetsh(['advfirewall', 'firewall', 'delete', 'rule', `name=${ruleName}`]);

    const added = await execNetsh([
      'advfirewall', 'firewall', 'add', 'rule',
      `name=${ruleName}`,
      'dir=in',
      'action=allow',
      'protocol=TCP',
      `localport=${port}`,
      'profile=any',
    ]);

    results.push({ port, direction: 'inbound', ruleName, ok: added.ok, error: added.error?.message || added.stderr || null });
  }

  if (appPath) {
    const outboundRuleName = 'Chunknet App Outbound';
    await execNetsh(['advfirewall', 'firewall', 'delete', 'rule', `name=${outboundRuleName}`]);
    const added = await execNetsh([
      'advfirewall', 'firewall', 'add', 'rule',
      `name=${outboundRuleName}`,
      'dir=out',
      'action=allow',
      `program=${appPath}`,
      'profile=any',
    ]);
    results.push({ direction: 'outbound', ruleName: outboundRuleName, ok: added.ok, error: added.error?.message || added.stderr || null });
  }

  const ok = results.every((item) => item.ok);
  if (!ok) {
    console.warn('[windows-firewall] one or more firewall rules failed. Run Chunknet as Administrator once to install firewall rules.', results);
  } else {
    console.log('[windows-firewall] firewall rules ready', { ports: safePorts });
  }

  return { ok, skipped: false, ports: safePorts, results };
}
