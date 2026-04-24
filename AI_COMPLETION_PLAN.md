# AI Completion Plan for p2p-cloud

This document turns the current prototype into an actionable completion plan for an AI coding agent such as Codex, Claude Code, or Cursor Agent.

## Current state

The project is a local-first Electron/React/Web3 prototype with a server-side upload API and an in-memory P2P metadata service.

The README correctly identifies these production gaps:

- real peer transport
- bootstrap/discovery outside localhost
- file chunk upload/download between peers
- encryption before replication
- hash verification
- replication repair when peers go offline
- persistent peer/file metadata
- smart-contract payments

## Completion target

Build a working MVP that is honest and testable:

1. Local encrypted file vault works reliably.
2. Files are chunked and content-addressed.
3. File manifests are persisted.
4. P2P metadata sync works over a real libp2p transport.
5. Peers can request and download chunks.
6. Downloaded chunks are verified before reassembly.
7. Replication factor is tracked and repair jobs are queued.
8. Wallet connection remains optional until payment contracts are implemented.

## Milestone 1: Stabilize local vault

- Add missing runtime dependencies used by the server.
- Replace the JSON DB file with a small persistence layer.
- Add typed file records and validation.
- Add tests for upload, list, search, download, and delete.
- Ensure `pnpm check`, `pnpm test`, and `pnpm build` pass.

Acceptance criteria:

- Fresh clone installs without missing modules.
- Uploading and downloading a file preserves exact bytes.
- Delete removes both metadata and stored bytes.

## Milestone 2: Chunking and hashing

- Split files into fixed-size chunks.
- Hash each chunk with SHA-256.
- Create a manifest containing file name, size, MIME type, chunk hashes, total chunks, encryption status, and owner peer.
- Store chunks by hash on disk.
- Reassemble files from chunk hashes.

Acceptance criteria:

- Same file produces the same manifest hash.
- Reassembled file matches the original file hash.
- Missing chunk errors are explicit.

## Milestone 3: Encryption

- Encrypt chunks before storage/replication.
- Store encryption metadata separately from encrypted chunk bytes.
- Do not expose raw keys in logs or API responses.
- Add passphrase-based local encryption for MVP.

Acceptance criteria:

- Stored chunks are not readable as plaintext.
- Wrong passphrase cannot reassemble the file.
- Correct passphrase restores exact bytes.

## Milestone 4: Real P2P metadata transport

- Start a libp2p node on the server side.
- Add bootstrap peer configuration through environment variables.
- Publish file manifests over pubsub.
- Subscribe to manifest events from peers.
- Persist discovered peers and manifests.

Acceptance criteria:

- Two app instances can discover each other using configured bootstrap addresses.
- Upload on one peer appears as searchable metadata on the other.
- Restarting an app preserves known manifests.

## Milestone 5: Chunk transfer

- Add a libp2p protocol for chunk requests.
- Request missing chunks by hash from peers listed in the manifest.
- Verify every received chunk hash before saving.
- Reassemble only after all chunks are verified.

Acceptance criteria:

- Peer B can download a file uploaded by Peer A.
- Corrupt chunks are rejected.
- Missing chunks produce a recoverable error.

## Milestone 6: Replication and repair

- Add replication factor setting.
- Track which peers claim each chunk.
- Add a repair queue when peers go offline.
- Re-replicate chunks to healthy peers.

Acceptance criteria:

- The UI shows replication status.
- Offline peers reduce health score.
- Repair job attempts to restore target replication factor.

## Milestone 7: Payment readiness

- Keep current pricing UI as a plan selector.
- Add a payment abstraction interface.
- Add mock payment provider for tests.
- Only integrate smart contracts after storage behavior is stable.

Acceptance criteria:

- The app does not claim real automated payments until contracts exist.
- Storage plan limits are enforced locally.

## Recommended AI-agent prompt

```text
You are completing the p2p-cloud repository. Work in small pull requests. Do not rewrite the whole app. First run install, typecheck, tests, and build. Fix only the first failing layer before adding new features.

Goal: turn the prototype into a working local-first encrypted P2P storage MVP.

Order:
1. Stabilize dependencies and tests.
2. Implement chunking and SHA-256 manifests.
3. Implement encryption for chunks.
4. Implement libp2p metadata sync.
5. Implement verified chunk transfer.
6. Implement replication health and repair queue.
7. Prepare payment abstraction without pretending real payments exist.

For each PR:
- Explain what changed.
- Add or update tests.
- Keep README honest about what is implemented.
- Ensure pnpm check, pnpm test, and pnpm build pass.
```

## First recommended code fix

`server/index.ts` imports `multer`, but `package.json` should include `multer` and `@types/multer` so a fresh install can compile and run consistently.
