# p2p.cloud Release Checklist

This document is the production checklist for publishing a real Windows installer.

## Current MVP baseline

- Electron desktop app builds successfully.
- Windows NSIS installer is produced by `pnpm run electron:build`.
- Bootstrap discovery runs on AWS at `ws://54.166.171.208:8788`.
- Wallet manifest sync runs on AWS at `http://54.166.171.208:8790`.
- Files uploaded under one wallet appear on another device using the same wallet.
- P2P peers can discover each other and transfer chunks when reachable.

## Build locally

```bash
pnpm install
pnpm run electron:build
```

Expected output:

```text
dist/p2p-cloud-1.0.0-setup.exe
```

## Smoke test before release

1. Install the generated EXE on Device A.
2. Install the generated EXE on Device B.
3. Connect the same wallet on both devices.
4. Upload a small file from Device A.
5. Confirm Device A logs a successful manifest push.
6. Confirm `http://54.166.171.208:8790/health` shows at least one wallet.
7. Open Device B and confirm the file appears.
8. Confirm peers are visible when both devices are reachable.
9. Download the file from Device B.

## Server health checks

```bash
pm2 status
curl http://127.0.0.1:8790/health
ss -ltnp | grep -E '8788|8790'
```

Public health check:

```text
http://54.166.171.208:8790/health
```

## Release naming

Use semantic tags:

```text
v1.0.0
v1.0.1
v1.1.0
```

Recommended first release:

```text
p2p.cloud MVP v1.0.0
```

## Known MVP limits

- Wallet ownership is not yet cryptographically signed for manifest writes.
- HTTP is used for MVP infrastructure; HTTPS should be added before broad public launch.
- P2P WebSocket peers require reachable ports or LAN accessibility.
- If peers are offline, chunks may not be downloadable unless local copies exist.
- Manifest sync stores file metadata, not file bytes.

## Production hardening backlog

- Add wallet signature verification for manifest writes.
- Add HTTPS with a domain and TLS certificate.
- Add rate limiting to manifest sync.
- Add encrypted chunk fallback storage or relay support.
- Add NAT traversal via WebRTC/relay.
- Add app auto-update.
- Add code signing certificate for Windows.
- Add user-facing network health panel.
