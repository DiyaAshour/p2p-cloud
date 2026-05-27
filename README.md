# Chunknet / p2p-cloud

Chunknet is an Electron-first peer-to-peer cloud storage client with encrypted chunks, peer discovery, manifest sync, replication, repair logic, and wallet/payment integration paths.

The desktop app is the primary product path. Renderer data access must go through the Electron preload bridge using `window.electron.invoke(...)`; the UI must not call P2P/storage APIs directly with browser `fetch`.

## Engineering Reference

Read the living architecture document first:

```bash
المرجع.md
```

That file explains the architecture, upload/download flow, P2P transport, bootstrap discovery, manifest sync, storage peer, encryption, wallet/payment layer, risks, and the 9/10 hardening plan.

## Requirements

- Node.js 20+
- pnpm 10+
- Windows, macOS, or Linux for development
- Electron runtime installed through `pnpm install`

## Setup

```bash
pnpm install
cp .env.example .env
```

Then edit `.env` locally. Never commit real `.env` values.

## Verify Runtime

Before running or packaging, verify the Electron runtime wiring:

```bash
pnpm verify
```

`pnpm verify` now runs:

- `pnpm security:scan` to block committed secrets and unsafe `.env` values.
- `pnpm production:scan` to block legacy patch/apply scripts from the production path.
- `pnpm verify:ipc` to verify every Electron IPC-like channel is declared in the shared contract.
- `pnpm verify:renderer` to verify the React renderer does not use browser network calls for app data.
- `pnpm verify:large-files` to verify large transfers stay out of renderer memory.
- `pnpm verify:manifest-auth` to verify manifest writes/deletes require authenticated owner-bound requests.
- `pnpm verify:storage-peer` to verify storage peer hash/rate/delete protections.
- `pnpm verify:bootstrap` to verify bootstrap peer registration safety.
- `pnpm verify:wallet-payment` to verify wallet quota and signed paid-plan unlock safety.
- `pnpm verify:encryption` to verify encryption/key safety.
- `pnpm verify:release` to verify the release build path is guarded.
- `pnpm verify:smoke-plan` to verify the manual smoke test checklist is present and complete.
- `scripts/verify-runtime.cjs` to verify required Electron runtime modules and IPC contract wiring.

For deeper checks:

```bash
pnpm health
pnpm health:deep
```

## Run Desktop App

```bash
pnpm electron:dev
```

This starts:

- Vite renderer on `127.0.0.1:3000`
- PayPal checkout service on the configured port
- Electron through the launch script

## Build / Package

```bash
pnpm build
```

Equivalent explicit command:

```bash
pnpm package:win
```

Directory-only package:

```bash
pnpm package:dir
```

## Release Smoke Test Gate

Automated checks are required but not enough for a release. Before publishing a build, complete the manual checklist:

```bash
docs/RELEASE_SMOKE_TEST.md
```

The checklist covers:

- Clean Windows install.
- Identity/wallet login.
- Small, medium, and `1 GB+` upload/download.
- Multi-peer discovery and transfer.
- Manifest sync authentication.
- Storage peer validation and delete protection.
- PayPal sandbox paid-plan unlock.
- Encryption cross-device recovery with same wallet/seed and drive password.

Run this check after editing the release checklist:

```bash
pnpm verify:smoke-plan
```

## Manifest Auth Safety Policy

Manifest metadata controls file discovery, ownership, and reconstruction. Mutating manifest routes must never be open.

Required for manifest writes/deletes:

```bash
MANIFEST_SYNC_REQUIRE_AUTH=true
MANIFEST_SYNC_AUTH_SECRET
P2P_MANIFEST_SYNC_AUTH_SECRET
x-manifest-auth-version
x-manifest-identity
x-manifest-timestamp
x-manifest-nonce
x-manifest-body-sha256
x-manifest-signature
```

Required protections:

- HMAC-SHA256 signature verification.
- Timing-safe signature comparison.
- Nonce replay protection.
- Timestamp expiry protection.
- Body hash verification.
- Identity/path ownership check.
- Manifest `ownerWallet` ownership check.
- `POST /wallet/:address/manifests` must use `requireManifestAuth`.
- `DELETE /wallet/:address/manifests/:hash` must use `requireManifestAuth`.

Run this check after touching manifest sync code:

```bash
pnpm verify:manifest-auth
```

## Large File Safety Policy

Large file uploads/downloads must not move complete file payloads through React renderer memory.

Forbidden patterns for app file transfers:

```bash
p2p:download
URL.createObjectURL(...)
arrayBuffer()
atob(...)
Buffer.from(...)
FileReader
return base64 file payloads
return raw Buffer file payloads
```

Required path:

```bash
p2p:downloadToPath
```

Runtime files that must stay present:

```bash
electron/download-to-path-override.js
electron/stream-upload-override.js
```

Run this check after touching upload/download paths:

```bash
pnpm verify:large-files
```

## Electron-only Renderer Policy

React renderer code must not communicate directly with P2P/storage/payment services through browser networking.

Forbidden in `client/src`:

```bash
fetch(...)
axios
XMLHttpRequest
VITE_P2P_API_BASE_URL
VITE_API_URL
localhost P2P/storage URLs
```

Allowed path:

```bash
window.electron.invoke('<declared-channel>', payload)
```

Run this check after changing renderer data access:

```bash
pnpm verify:renderer
```

## IPC Contract Policy

All Electron IPC channels must be declared in one source of truth:

```bash
electron/ipc-contract.cjs
```

Rules:

1. Do not add ad-hoc channel strings directly to `preload.cjs`.
2. Do not expose unrestricted `ipcRenderer.invoke` to the renderer.
3. Add every new channel to `electron/ipc-contract.cjs` first.
4. Run `pnpm verify:ipc` after adding or renaming any channel.
5. Large-file operations must keep using `p2p:downloadToPath` / source-based streaming paths instead of returning huge buffers to React.

## Core Runtime Rules

1. Electron is the trusted local runtime.
2. React is UI only.
3. All privileged work goes through IPC/preload.
4. Large downloads must stream/write to disk through Electron, not return huge buffers to React.
5. `.env` files are local only and must not contain committed secrets.
6. Production scripts must be source-based and must not run legacy `patch`/`apply` scripts.
7. IPC channels must be declared in `electron/ipc-contract.cjs`.
8. Renderer data access must be Electron-only; no direct browser network data path.
9. Large file transfers must use disk/streaming paths, not renderer Buffer/Base64 paths.
10. Manifest writes/deletes must require authenticated owner-bound requests.
11. Paid plans must require signed plan-unlock tokens, not raw UI payloads.
12. Release builds must pass automated guards and the manual smoke test checklist.
13. Any new feature must be documented in `المرجع.md`.

## Useful Scripts

| Script | Purpose |
|---|---|
| `pnpm security:scan` | Blocks committed secrets and unsafe `.env` values |
| `pnpm production:scan` | Blocks legacy patch/apply scripts from the production path |
| `pnpm verify:ipc` | Verifies IPC channel usage against `electron/ipc-contract.cjs` |
| `pnpm verify:renderer` | Verifies renderer app data access is Electron-only |
| `pnpm verify:large-files` | Verifies large file transfers stay out of renderer memory |
| `pnpm verify:manifest-auth` | Verifies manifest writes/deletes require authenticated owner-bound requests |
| `pnpm verify:storage-peer` | Verifies storage peer validates chunks, rate-limits peers, and protects deletes |
| `pnpm verify:bootstrap` | Verifies bootstrap validates peers and rate-limits discovery |
| `pnpm verify:wallet-payment` | Verifies upload quota and paid-plan unlock safety |
| `pnpm verify:encryption` | Verifies encryption/key safety |
| `pnpm verify:release` | Verifies the release build path is fully guarded |
| `pnpm verify:smoke-plan` | Verifies the release smoke test checklist is complete |
| `pnpm verify` | Runs all security, runtime, release, and smoke-plan guards |
| `pnpm health` | Runs the standard health check |
| `pnpm health:deep` | Runs deeper health checks |
| `pnpm electron:dev` | Runs the desktop app in development |
| `pnpm renderer:build` | Builds the renderer after verification |
| `pnpm package:win` | Builds and packages the Windows app |
| `pnpm package:dir` | Builds a directory package |
| `pnpm paypal:server` | Starts the PayPal checkout service |
| `pnpm sync:manifests` | Starts manifest sync service |
| `pnpm storage:peer` | Starts storage peer service |

## Legacy Scripts Policy

Legacy scripts are kept only for historical recovery or manual migration. They must not be used by `verify`, `renderer:build`, `build`, `package:win`, `dist`, `electron:dev`, or `start`.

Allowed naming for old migration helpers:

```bash
legacy:*
```

Forbidden naming for production package scripts:

```bash
patch:*
apply:*
```

## Local Environment Policy

Use `.env.example` as the template and keep real values in `.env` only on your own machine/server.

If `.env` was committed by mistake, sanitize it immediately, rotate any exposed credentials, and remove it from Git tracking locally:

```bash
git rm --cached .env
git commit -m "chore: stop tracking local env file"
```
