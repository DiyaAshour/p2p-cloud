# Peer Security Technical Integration

This document connects peer hardening to the existing Chunknet architecture in a clean production-oriented way.

## Objective

Do not treat corrupted chunks, false ACKs, slow peers, and invalid manifests as isolated errors. Route them into the same peer reputation system so the network learns which peers should not be trusted for replication, repair, or download.

## Existing architecture touchpoints

### 1. `electron/p2p-transport.js`

This is the correct place for first-line peer security because it owns:

- peer sockets
- peer health state
- chunk put/get messages
- ACK tracking
- timeout handling
- replica health filtering
- peer selection ordering

Security failures should be recorded here before they reach higher layers.

### 2. `electron/replication-engine.js`

This layer should not need to know every attack type. It should trust the transport methods:

- `selectReplicaTargets()`
- `healthyReplicaIds()`
- `isPeerHealthy()`

If a peer is quarantined or has a low score, it must automatically disappear from replication targets.

### 3. `electron/main.js`

This layer should expose the security state through `networkSummary()` so the UI can show:

- healthy peers
- suspect peers
- quarantined peers
- peer score
- last failure reason
- security failure count

No business logic should be duplicated here.

### 4. UI

The UI should consume the transport health summary, not calculate reputation itself.

Recommended display:

- Healthy: usable for upload/download/repair
- Suspect: usable only if no better peers are available
- Quarantined: blocked from storage and download routing
- Dead/offline: not counted as a healthy replica

## Security event flow

### A. Peer sends corrupted chunk

Flow:

1. `chunk:found` or `chunk:put` arrives.
2. Transport validates `sha256(base64 decoded data) === chunk.hash`.
3. If mismatch:
   - reject chunk
   - do not store it
   - do not add peer to replica set
   - call `notePeerFailure(peerId, 'chunk-hash-mismatch')`
4. If repeated, peer becomes quarantined.

### B. Peer lies about storage ACK

Flow:

1. Local node sends `chunk:put` with expected chunk hash.
2. Peer returns `chunk:stored-ack`.
3. Transport checks that ACK maps to an active pending ACK.
4. Transport checks that ACK chunk hash equals pending chunk hash.
5. If not:
   - do not add peer to replica set
   - call `notePeerFailure(peerId, 'false-storage-ack')`

### C. Peer is slow or repeatedly times out

Flow:

1. ACK or chunk request times out.
2. Transport records normal failure.
3. Score drops.
4. Repeated failures move peer to `suspect`.
5. Peer stops being preferred by `sortedConnectedPeerIds()`.

Slow peers are not always malicious, so they should be penalized less than hash mismatches.

### D. Peer broadcasts invalid manifest

Flow:

1. `manifest:broadcast` arrives.
2. Transport validates minimum manifest shape:
   - `hash`
   - `ownerWallet`
   - encryption metadata when `isEncrypted === true`
3. If invalid:
   - do not forward
   - call `notePeerFailure(peerId, 'invalid-manifest')`

## Reputation model

Recommended peer health fields:

```js
{
  peerId,
  score,
  state,
  successes,
  failures,
  securityFailures,
  storedChunks,
  fetchedChunks,
  lastSeen,
  lastSuccessAt,
  lastFailureAt,
  lastLatencyMs,
  lastError,
  quarantinedUntil,
  quarantineReason
}
```

Recommended states:

```text
new -> healthy -> suspect -> quarantined
healthy -> offline
healthy -> dead
quarantined -> suspect after timeout expires
```

## Penalty policy

| Event | Type | Action |
|---|---|---|
| chunk hash mismatch | severe | security failure + possible quarantine |
| invalid chunk shape | severe | security failure + possible quarantine |
| false storage ACK | severe | security failure + possible quarantine |
| unexpected ACK | medium/severe | security failure |
| invalid manifest | severe | security failure |
| ACK timeout | medium | score penalty |
| chunk request timeout | medium | score penalty |
| high latency | light/medium | score penalty |
| clean store/fetch | positive | score bonus |

## Integration contract

After implementation, these existing functions should automatically become security-aware:

```js
selectReplicaTargets()
healthyReplicaIds()
putChunkOnNetwork()
fetchChunkFromNetwork()
peerHealthSummary()
networkSummary()
repairManifests()
countUnderReplicatedChunks()
```

The key is that `replication-engine.js` should not manually filter bad peers. It should call transport methods, and the transport should already know who is trustworthy.

## Environment variables

Recommended tunables:

```bash
P2P_PEER_SECURITY_FAILURES_BEFORE_QUARANTINE=2
P2P_PEER_QUARANTINE_MS=3600000
P2P_MIN_REPLICA_HEALTH_SCORE=35
P2P_CHUNK_REQUEST_TIMEOUT_MS=15000
P2P_CHUNK_STORE_ACK_TIMEOUT_MS=5000
```

## UI/diagnostics additions

Expose from `networkSummary()`:

```js
peerSecurity: {
  healthy: number,
  suspect: number,
  quarantined: number,
  dead: number,
  totalSecurityFailures: number
}
```

Each peer card should show:

- score
- state
- lastLatencyMs
- failures
- securityFailures
- lastError
- quarantineReason

## Minimal implementation order

1. Add chunk integrity validation to `p2p-transport.js`.
2. Add security failure counters and quarantine state.
3. Make `isPeerHealthy()` reject quarantined peers.
4. Harden `chunk:put`, `chunk:found`, and `chunk:stored-ack`.
5. Validate `manifest:broadcast` before forwarding.
6. Add `peerSecurity` summary to `networkSummary()`.
7. Add UI indicators later; do not block transport security on UI work.

## Acceptance tests

Create a test file such as:

```text
tests/p2p-peer-security.test.ts
```

Scenarios:

1. Corrupted chunk is rejected and not stored.
2. Peer sending corrupted chunks receives `securityFailures += 1`.
3. Peer is quarantined after repeated corrupted chunks.
4. Quarantined peer is excluded from `selectReplicaTargets()`.
5. False ACK does not create a replica.
6. Invalid manifest is not forwarded.
7. Normal peer can recover score through successful store/fetch operations after quarantine expires.

## Production principle

Hash checks protect the file. Reputation protects the network.

Both are required.
