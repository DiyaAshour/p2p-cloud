# P2P Network Hardening

This branch adds scaling guardrails for larger peer networks and safer big-file transfers.

## Added

- Bootstrap peer cap and discovery response limit.
- Bootstrap message rate limit and peer TTL cleanup.
- Transport total, inbound, outbound, and UI connection caps.
- Peer buckets: fast, stable, probation, congested, quarantine, offline, dead.
- Adaptive routing by score, bucket, and socket pressure.
- Bounded chunk lookup fanout instead of flooding all peers.
- Backpressure for pending chunk requests and pending chunk acknowledgements.
- Socket bufferedAmount protection.
- Retry cooldown with jitter to reduce reconnect storms.

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
- P2P_RECONNECT_BASE_MS
- P2P_RECONNECT_MAX_MS
- P2P_BOOTSTRAP_MAX_PEERS
- P2P_BOOTSTRAP_RESPONSE_LIMIT
- P2P_BOOTSTRAP_MESSAGES_PER_MINUTE
- P2P_BOOTSTRAP_PEER_TTL_MS
- P2P_BOOTSTRAP_MAX_PAYLOAD_BYTES

## 1000-peer rule

Do not create a full mesh. Each node should keep a bounded peer set, then rely on discovery, adaptive routing, replication, and repair.

Recommended starting point per node:

- total peers: 96
- outbound peers: 32
- inbound peers: 64
- chunk lookup fanout: 8

Next steps: add token-bucket bandwidth shaping, persistent reputation, and automated stress tests.
