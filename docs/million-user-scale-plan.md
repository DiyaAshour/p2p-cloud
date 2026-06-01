# Chunknet Million-User Scale Plan

This document is the production-scale target for taking Chunknet from a working P2P cloud beta to a million-user storage network.

## Target scenario

- Users: 1,000,000
- Paid plan focus: 1 TB
- Expected average used storage per user: 150 GB to 300 GB
- Recommended planning average: 300 GB
- Replicas: 3
- Logical user data at 300 GB average: 300 PB
- Physical replicated storage at 3 replicas: 900 PB
- Safety peer target ratio: 1% to 5% of logical data
- Safety danger zone: above 10%

## Why the current beta architecture is not enough

The current beta is strong for local, LAN, and early public tests, but the million-user target breaks the following assumptions:

1. A single manifest JSON file cannot hold production metadata.
2. A single in-memory bootstrap map cannot serve a global peer directory.
3. JSON/base64 chunk storage wastes space and CPU at PB scale.
4. A fixed 2 MB chunk size creates too many chunk records.
5. Repair cannot be a broad periodic scan; it must be queue-based and event-driven.
6. Safety peer cannot silently become primary storage.

## Required production architecture

### 1. Metadata control plane

Replace file-based manifest storage with a real metadata database.

Recommended first production step:

- PostgreSQL for beta-scale production.
- Tables for users, files, file_versions, chunks, chunk_replicas, peers, repair_jobs, tombstones, workspaces, workspace_members, audit_events.
- Append-only event log for file create/update/delete and repair state transitions.

Future million-user option:

- CockroachDB, YugabyteDB, FoundationDB, or sharded PostgreSQL.
- Region-aware metadata partitions.

### 2. Chunk index

Each peer must maintain a local durable index instead of scanning folders or relying on huge JSON indexes.

Required:

- SQLite, RocksDB, or LevelDB local index.
- Tables/keys for chunk_hash, file_id, owner_id, size, stored_at, last_verified_at, delete_tombstone_seen_at.
- Incremental integrity checks.
- Fast lookup for chunk:get and chunk:delete.

### 3. Binary chunk storage

Move from JSON/base64 chunks to raw binary content-addressed chunks.

Required format:

```txt
chunks/ab/cd/<sha256>.chunk
index: SQLite/RocksDB record
metadata: stored separately, not inside every chunk file
```

Why:

- base64 adds about 33% overhead.
- JSON parse/stringify becomes too expensive.
- binary writes are simpler, faster, and cheaper.

### 4. Adaptive chunk sizing

Fixed 2 MB chunks are too small for very large files.

Target policy:

| File size | Chunk size |
|---|---:|
| under 100 MB | 2 MB |
| 100 MB to 5 GB | 8 MB |
| 5 GB to 50 GB | 16 MB |
| over 50 GB | 32 MB |

This reduces chunk-record pressure by 4x to 16x for large files.

### 5. Three-replica policy

Production target:

```txt
3 P2P replicas = Protected
2 replicas = Repair soon
1 replica = Critical repair now
0 replicas = Lost or safety-only recovery required
Safety peer = emergency fallback, not primary storage
```

Important: safety peer should not count as a healthy P2P replica. It is an emergency protection layer.

### 6. Repair queue

Repair must become event-driven.

Required queues:

- critical_repair: chunks with only one healthy replica.
- normal_repair: chunks below target replicas.
- safety_cleanup: chunks now protected by P2P and ready to delete from safety.
- tombstone_delivery: deletes that must be delivered to returning peers.
- integrity_check: background spot checks.

Required job fields:

```txt
job_id
chunk_hash
file_id
priority
source_peer_id
target_peer_id
attempts
last_error
next_retry_at
created_at
updated_at
```

### 7. Bootstrap cluster

The current bootstrap model is useful for beta but needs clustering.

Required:

- multiple bootstrap nodes.
- peer directory persisted outside process memory.
- region-aware peer selection.
- per-account and per-IP rate limits.
- peer list filtered by workspace, region, health, capacity, and file interest.
- relay/NAT traversal path.

### 8. Safety peer pool

Replace single safety peer thinking with a safety pool.

Required:

- multiple safety peers across regions.
- per-owner quotas.
- safety ratio metric.
- automatic cleanup after P2P target replicas are reached.
- signed delete, not only admin token.

### 9. Observability

A million-user system cannot run blind.

Required metrics:

- active peers.
- upload success rate.
- download success rate.
- average replicas per chunk.
- chunks below 3 replicas.
- chunks with one replica.
- repair queue lag.
- safety storage ratio.
- safety cleanup lag.
- peer churn.
- chunk get latency.
- chunk put latency.
- manifest sync latency.
- delete propagation lag.

### 10. Abuse and quota control

Required before public scale:

- account quotas enforced server-side and Electron-side.
- contribution accounting for P2P Saver plans.
- per-peer storage contribution limits.
- bandwidth caps.
- file type abuse detection where legally required.
- signed manifests and signed delete/tombstone events.

## Immediate implementation order

1. Set production target replicas to 3.
2. Add adaptive chunk sizing.
3. Add binary chunk storage path behind a feature flag.
4. Add SQLite/RocksDB local peer chunk index.
5. Replace manifest-sync JSON file with PostgreSQL.
6. Add repair job queue.
7. Add bootstrap clustering plan and first regional node support.
8. Add safety ratio metrics.
9. Add 1,000 simulated peer test.
10. Add 10,000 simulated peer test before real 10k launch.

## Release gates

### Gate A: 1,000-user beta

- 1,000 simulated peers pass.
- 10 TB test dataset.
- 3 replicas maintained.
- safety ratio under 5% after repair settles.
- downloads pass hash verification after peer churn.

### Gate B: 10,000-user beta

- PostgreSQL manifest sync live.
- binary chunk storage live.
- repair queue live.
- bootstrap cluster live.
- safety cleanup automated.
- 100 TB simulation passes.

### Gate C: million-user readiness

- multi-region metadata.
- multi-region bootstrap.
- safety peer pool.
- repair workers.
- full observability.
- abuse prevention.
- disaster recovery plan.

## Non-negotiable rule

Do not scale user count faster than the system can keep safety storage ratio under control.

If safety storage ratio stays above 10%, the P2P network is not carrying enough load and the business model becomes centralized cloud storage with extra complexity.
