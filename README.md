# P2P Storage Browser

Pure Electron peer-to-peer storage client.

## Run

```bash
pnpm electron:dev
```

## Build

```bash
pnpm build
pnpm electron:build
```

Renderer data access goes through `window.electron.invoke(...)` only.
