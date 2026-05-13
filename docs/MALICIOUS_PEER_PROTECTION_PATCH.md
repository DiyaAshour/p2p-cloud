# Malicious peer protection patch

Apply this to `electron/p2p-transport.js` to make peer reputation punish malicious behavior explicitly.

## Goals

- Reject bad chunks before storing them.
- Penalize peers that send corrupted chunks.
- Penalize unexpected or false storage ACKs.
- Quarantine peers after repeated security failures.
- Exclude quarantined peers from replica selection and message forwarding.

## Add constants and helpers near the top

```js
const PEER_SECURITY_FAILURES_BEFORE_QUARANTINE = Number(process.env.P2P_PEER_SECURITY_FAILURES_BEFORE_QUARANTINE || 2);
const PEER_QUARANTINE_MS = Number(process.env.P2P_PEER_QUARANTINE_MS || 60 * 60 * 1000);

function hashBufferHex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function validateChunkIntegrity(chunk) {
  if (!chunk?.hash || typeof chunk.data !== 'string') throw new Error('invalid-chunk');
  const buffer = Buffer.from(chunk.data, 'base64');
  if (hashBufferHex(buffer) !== chunk.hash) throw new Error(`chunk-hash-mismatch:${chunk.hash}`);
  return buffer;
}

function isSecurityFailure(error = '') {
  const reason = String(error).toLowerCase();
  return [
    'chunk-hash-mismatch',
    'invalid-chunk',
    'invalid-manifest',
    'false-storage-ack',
    'unexpected-ack',
    'chunk:stored-ack timeout',
    'replica-unavailable',
  ].some((x) => reason.includes(x));
}
```

## Extend peer health

Add these fields inside `emptyPeerHealth(peerId)`:

```js
securityFailures: 0,
quarantinedUntil: null,
quarantineReason: null,
```

## Make local chunk storage strict

At the start of `storeLocalChunk(chunk)`, after the hash check, add:

```js
validateChunkIntegrity(chunk);
```

Inside `getLocalChunk(chunkHash)`, validate memory/disk chunks before returning them. Delete invalid disk chunks.

## Replace `notePeerFailure`

```js
notePeerFailure(peerId, error = null) {
  if (!peerId || peerId === this.peerId) return;

  const now = Date.now();
  const current = this.getPeerHealth(peerId) || emptyPeerHealth(peerId);
  const reason = error ? String(error) : 'peer-failure';
  const securityFailure = isSecurityFailure(reason);
  const nextFailures = current.failures + 1;
  const nextSecurityFailures = Number(current.securityFailures || 0) + (securityFailure ? 1 : 0);
  const shouldQuarantine = securityFailure && nextSecurityFailures >= PEER_SECURITY_FAILURES_BEFORE_QUARANTINE;

  const next = {
    ...current,
    state: shouldQuarantine ? 'quarantined' : nextFailures >= 3 || securityFailure ? 'suspect' : current.state,
    failures: nextFailures,
    securityFailures: nextSecurityFailures,
    lastFailureAt: now,
    lastError: reason,
    quarantinedUntil: shouldQuarantine ? now + PEER_QUARANTINE_MS : current.quarantinedUntil,
    quarantineReason: shouldQuarantine ? reason : current.quarantineReason,
  };

  this.peerHealth.set(peerId, next);

  if (shouldQuarantine) {
    console.warn(`[p2p-transport] quarantined peer ${peerId}: ${reason}`);
    this.broadcastToUi({ type: 'peer:quarantined', peerId, reason, until: next.quarantinedUntil });
  }
}
```

## Exclude quarantined peers

In `isPeerHealthy`, require:

```js
health.state !== 'quarantined'
```

## Harden chunk messages

In `chunk:put`, wrap storage with try/catch:

```js
try {
  validateChunkIntegrity(chunk);
  this.storeLocalChunk(chunk);
  this.notePeerSuccess(message.fromPeerId, 'store');
} catch (error) {
  this.notePeerFailure(message.fromPeerId, error.message);
  this.send(socket, {
    type: 'chunk:rejected',
    fromPeerId: this.peerId,
    toPeerId: message.fromPeerId,
    error: error.message,
  });
  return;
}
```

In `chunk:found`, validate before adding replicas or resolving requests:

```js
try {
  validateChunkIntegrity(chunk);
} catch (error) {
  this.notePeerFailure(message.fromPeerId, error.message);
  return;
}
```

In `chunk:stored-ack`, if no pending ACK exists, call:

```js
this.notePeerFailure(fromPeerId, `unexpected-ack:${chunkHash || 'unknown'}`);
return;
```

If the pending ACK chunk hash differs from the ACK chunk hash, call:

```js
this.notePeerFailure(fromPeerId, `false-storage-ack: expected ${pending.chunkHash} got ${chunkHash}`);
```

## Test

Run:

```bash
pnpm check
pnpm electron:dev
```

Expected log when a peer misbehaves:

```text
[p2p-transport] quarantined peer <peerId>: <reason>
```
