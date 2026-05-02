# P2P Decentralized Storage Browser

Decentralized storage network where every user becomes a node.

## Core Idea

- Files are stored locally
- Files are replicated across peers
- Users contribute storage to the network
- Users can retrieve files from any peer holding replicas

## What Exists Now

- Peer registration via bootstrap server
- Peer discovery
- File metadata tracking
- Local storage system
- Electron desktop app
- Wallet integration (MetaMask)

## What You Can Do

- Upload files
- Store locally
- Track files across peers
- Search files
- Connect wallet

## How It Works

1. Node starts
2. Registers with bootstrap server
3. Gets list of peers
4. Shares file metadata
5. Requests files from peers

## Run

```bash
pnpm install
pnpm run electron:dev
```

## Bootstrap Server

```bash
node server/bootstrap.js
```

## Architecture

- Electron app (client)
- Express bootstrap server
- P2P network layer (in progress)

## Goal

Build a fully decentralized storage network:

- File chunking
- Replication
- Encryption
- Payments

