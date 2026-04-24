# P2P Decentralized Storage Browser

A peer-to-peer decentralized file storage application built with Electron, React, and Web3 technologies. This application allows users to store files locally, model file metadata across a peer network, and connect cryptocurrency wallets for future storage payments.

> **Project status:** this is an active prototype. The UI, wallet flow, local storage, and P2P metadata layer are in progress. Some production-grade P2P behaviors, such as real peer transport, DHT-backed discovery, encrypted chunk replication, and automated crypto payments, are planned but not fully implemented yet.

## Features

- **Web3 Wallet Integration**: Connect MetaMask or other Web3 wallets
- **P2P Metadata Layer**: Track peers, heartbeats, file metadata, and replication targets
- **Local Storage Foundation**: Store files locally as the base for distributed backup
- **Payment Model Prototype**: Storage pricing model for future cryptocurrency payments ($1 per 1TB per month)
- **File Indexing**: Mark files as discoverable or private in metadata
- **File Search**: Search known file metadata by name or hash
- **Desktop Application**: Built with Electron for cross-platform support

## Current P2P Implementation

The current P2P service is a prototype abstraction rather than a complete distributed network transport. It currently supports:

- registering peers in memory
- tracking peer online/offline state with heartbeat timestamps
- broadcasting file metadata events through application events
- searching known file metadata
- calculating basic network statistics

The following items are still roadmap work before this can be considered a production P2P storage network:

- real transport between peers using libp2p, WebRTC, WebSocket, or TCP
- bootstrap peer configuration and peer discovery outside localhost
- file chunk upload/download between peers
- encryption before replication
- hash verification for downloaded chunks
- replication repair when peers go offline
- persistent peer and file metadata storage

## System Requirements

- Node.js 18+ and pnpm
- MetaMask browser extension (for Web3 wallet integration)
- 2GB RAM minimum
- 500MB disk space

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/DiyaAshour/p2p-cloud.git
cd p2p-cloud
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Environment Setup

Create a `.env.local` file in the project root:

```env
VITE_APP_TITLE=P2P Storage Browser
VITE_APP_ID=p2p-storage-browser
VITE_FRONTEND_FORGE_API_URL=http://localhost:3000
```

## Development

### Start Development Server

For web development:

```bash
pnpm run dev
```

This starts the Vite development server on `http://localhost:3000`.

### Start Electron App (Desktop)

In a separate terminal:

```bash
pnpm run dev:electron
```

This will start both the Vite dev server and the Electron application.

### Build for Production

```bash
pnpm run build:electron
```

This creates a distributable Electron application.

## Usage

### 1. Connect Your Wallet

1. Click "Connect Wallet" button
2. Approve the connection in MetaMask
3. Your wallet address and balance will be displayed

### 2. Upload Files

1. Go to the "Upload Files" tab
2. Select files from your computer
3. Optionally check "Index files for network search" to make files discoverable
4. Click "Upload Files"

### 3. Browse Files

1. Go to the "File Browser" tab
2. View all uploaded files
3. Download files by clicking the download icon
4. Delete files by clicking the trash icon

### 4. Search Files

1. Use the search bar to find files by name or hash
2. Results are displayed from known local/network metadata

### 5. Manage Storage

1. Go to the "Statistics" tab
2. View storage usage and estimated costs
3. Select a storage plan (1TB, 3TB, 5TB, 10TB)

## Architecture

### Frontend Structure

```text
client/
├── src/
│   ├── pages/           # Page components
│   ├── components/      # Reusable UI components
│   ├── hooks/           # Custom React hooks
│   ├── services/        # Client-side business logic services
│   ├── App.tsx          # Root component
│   └── index.css        # Global styles
├── public/              # Static assets
└── index.html           # HTML entry point
```

### Server / Core Structure

```text
server/
├── p2pNetwork.ts        # In-memory P2P metadata and peer status service
├── index.ts             # Server entry point
└── _core/               # Framework/core server utilities

shared/
├── types.ts             # Shared app types
└── const.ts             # Shared constants

electron/
├── main.js              # Electron main process
└── preload.js           # Preload script for IPC
```

## Key Technologies

- **React 19**: UI framework
- **Electron 28**: Desktop application framework
- **ethers.js 6**: Web3 library for wallet integration
- **libp2p packages**: Planned P2P networking foundation
- **Tailwind CSS 4**: Styling
- **shadcn/ui**: UI component library
- **IndexedDB / local storage services**: Client-side storage foundation

## Payment System

The application currently uses a simple payment model:

- **1 TB Storage**: $1/month
- **3 TB Storage**: $3/month
- **5 TB Storage**: $5/month
- **10 TB Storage**: $10/month

Automated smart-contract payments are planned roadmap work. Do not treat the current prototype as a production payment processor.

## P2P Network Roadmap

The intended production design is to use libp2p-style peer networking for:

- peer discovery through bootstrap nodes and/or DHT
- file chunk distribution across multiple peers
- redundancy and replication repair
- optional public indexing for searchable files
- private encrypted storage for non-indexed files

## Security

Current and planned security goals:

- **Wallet Integration**: Uses MetaMask for secure key management
- **Message Signing**: Planned authentication for peer actions
- **Encryption**: Planned file encryption before upload/replication
- **Integrity Checks**: Planned content hashes for files and chunks
- **Electron Safety**: Keep browser windows isolated and restrict unsafe IPC patterns

## Troubleshooting

### MetaMask Connection Issues

1. Ensure MetaMask is installed and unlocked
2. Check that you're on the correct network
3. Try disconnecting and reconnecting

### File Upload Issues

1. Check available disk space
2. Ensure files are not too large (max 4GB per file)
3. Check local app permissions

### P2P Network Issues

1. Remember that real peer transport is still prototype/roadmap work
2. Check that peer metadata is being registered correctly
3. Restart the application to clear in-memory peer state

## API Reference

### useWallet Hook

```typescript
const {
  address,
  balance,
  isConnected,
  chainId,
  isLoading,
  error,
  connect,
  disconnect,
  refreshBalance,
} = useWallet();
```

### useStorage Hook

```typescript
const {
  files,
  quota,
  isLoading,
  error,
  uploadFile,
  downloadFile,
  deleteFile,
  searchFiles,
  setStorageQuota,
  refreshFiles,
} = useStorage();
```

## Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:

1. Check the troubleshooting section
2. Open an issue on GitHub
3. Contact the development team

## Roadmap

- [ ] Real libp2p node startup and peer transport
- [ ] Bootstrap peer configuration
- [ ] File chunking and hash verification
- [ ] Encrypted file/chunk replication
- [ ] Replication factor and repair jobs
- [ ] Smart contract integration for automated payments
- [ ] IPFS integration option for distributed storage
- [ ] Multi-chain wallet support
- [ ] Mobile application
- [ ] Advanced file versioning
- [ ] Collaborative file sharing
- [ ] Network statistics dashboard

## Disclaimer

This is a prototype application. Use at your own risk. Always back up important files before uploading to any experimental storage network.
