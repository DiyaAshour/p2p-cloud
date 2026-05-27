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
- `scripts/verify-runtime.cjs` to verify required Electron runtime modules and IPC allowlist.

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

## Core Runtime Rules

1. Electron is the trusted local runtime.
2. React is UI only.
3. All privileged work goes through IPC/preload.
4. Large downloads must stream/write to disk through Electron, not return huge buffers to React.
5. `.env` files are local only and must not contain committed secrets.
6. Production scripts must be source-based and must not run legacy `patch`/`apply` scripts.
7. Any new feature must be documented in `المرجع.md`.

## Useful Scripts

| Script | Purpose |
|---|---|
| `pnpm security:scan` | Blocks committed secrets and unsafe `.env` values |
| `pnpm production:scan` | Blocks legacy patch/apply scripts from the production path |
| `pnpm verify` | Runs security, production, and Electron runtime verification |
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
