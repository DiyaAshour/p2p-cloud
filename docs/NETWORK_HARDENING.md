# P2P Network Hardening

This branch adds scaling guardrails for larger peer networks and safer big-file transfers.

## Added

- Bootstrap peer cap, rate limit, TTL cleanup, and response limits.
- Transport total, inbound, outbound, and UI connection caps.
- Peer buckets: fast, stable, probation, congested, quarantine, offline, dead.
- Adaptive routing by score, bucket, and socket pressure.
- Bounded chunk lookup fanout instead of flooding all peers.
- Backpressure for pending chunk requests and pending chunk acknowledgements.
- Socket bufferedAmount protection.
- Token-bucket upload throttling per peer and globally.
- Retry cooldown with jitter to reduce reconnect storms.
- Persistent peer reputation across restarts.
- Bootstrap stress runner via `pnpm run stress:p2p`.
- Malicious peer stress runner via `pnpm run stress:p2p:malicious`.
- Multi-node transfer stress runner via `pnpm run stress:p2p:transfer`.

## Main env settings

- P2P_MAX_TOTAL_PEERS
- P2P_MAX_OUTBOUND_PEERS
- P2P_MAX_INBOUND_PEERS
- P2P_MAX_UI_CLIENTS
- P2P_MAX_CHUNK_GET_FANOUT
- P2P_MAX_PENDING_CHUNK_REQUESTS
- P2P_MAX_PENDING_CHUNK_ACKS
- P2P_MAX_BUFFERED_BYTES_PER_PEER
- P2P_MAX_MESSAGE_BYTES
- P2P_PEER_UPLOAD_BYTES_PER_SEC
- P2P_PEER_UPLOAD_BURST_BYTES
- P2P_GLOBAL_UPLOAD_BYTES_PER_SEC
- P2P_GLOBAL_UPLOAD_BURST_BYTES
- P2P_RECONNECT_BASE_MS
- P2P_RECONNECT_MAX_MS
- P2P_REPUTATION_PATH
- P2P_REPUTATION_MAX_PEERS
- P2P_REPUTATION_TTL_MS
- P2P_BOOTSTRAP_MAX_PEERS
- P2P_BOOTSTRAP_RESPONSE_LIMIT
- P2P_BOOTSTRAP_MESSAGES_PER_MINUTE
- P2P_BOOTSTRAP_PEER_TTL_MS
- P2P_BOOTSTRAP_MAX_PAYLOAD_BYTES

## Stress tests

Bootstrap registration load:

`pnpm run stress:p2p`

Malicious input simulation, with bootstrap and Electron transport running:

`pnpm run stress:p2p:malicious`

Local multi-node transfer test:

`pnpm run stress:p2p:transfer`

Useful transfer settings: P2P_TRANSFER_STRESS_NODES, P2P_TRANSFER_STRESS_CHUNKS, P2P_TRANSFER_STRESS_CHUNK_BYTES, P2P_TRANSFER_STRESS_REPLICAS.

## 1000-peer rule

Do not create a full mesh. Keep each node on a bounded peer set, then rely on discovery, adaptive routing, replication, repair, and reputation.

Next steps: run these tests locally, fix any runtime errors, then add CI-safe smaller versions.
