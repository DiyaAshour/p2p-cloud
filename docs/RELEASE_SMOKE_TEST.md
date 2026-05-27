# Release Smoke Test Checklist

This checklist is the manual release gate for Chunknet / p2p-cloud.

A build is not considered release-ready until the automated guards pass and the manual smoke tests below are completed on a clean machine or clean app-data profile.

---

## 1. Automated Gate

Run from a clean checkout:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm renderer:build
pnpm package:win
```

Required result:

- No committed secrets detected.
- Production scripts do not use legacy patch/apply scripts.
- IPC contract is valid.
- Renderer data path is Electron-only.
- Large files stay out of renderer memory.
- Manifest writes/deletes are authenticated.
- Storage peer validates chunks and protects deletes.
- Bootstrap validates peer registrations.
- Wallet/payment plan unlock is guarded.
- Encryption/key safety guard passes.
- Release readiness guard passes.

---

## 2. Clean Install Smoke Test

Use a machine/profile where `%APPDATA%/Chunknet`, `%APPDATA%/chunknet`, and `%APPDATA%/p2p-cloud` are empty or intentionally backed up.

Steps:

1. Install the packaged Windows build.
2. Launch the app from the installer shortcut.
3. Confirm the main window opens without a blank/black screen.
4. Open diagnostics from the app if available.
5. Confirm preload is loaded and Electron bridge exists.
6. Confirm there is no browser-mode fallback.

Pass criteria:

- Window loads the native app UI.
- No `Electron preload bridge is missing` error.
- No `No handler registered` errors for core channels.
- App can close to tray in packaged mode without killing protection runtime.

---

## 3. Identity / Wallet Smoke Test

Steps:

1. Start logged out.
2. Confirm file actions that require identity are blocked.
3. Connect wallet or seed identity.
4. Confirm `wallet:status` reports verified identity.
5. Restart app.
6. Confirm identity/session behavior is expected.
7. Disconnect/logout.
8. Confirm private files/folders do not leak into logged-out view.

Pass criteria:

- Upload is blocked when identity is not verified.
- Upload is allowed after verified wallet/seed login.
- Logout clears identity-scoped file/folder UI state.
- No paid plan can be unlocked from UI payload alone.

---

## 4. Local Upload / Download Smoke Test

Test files:

- Small text file: `< 1 MB`
- Medium image/video/file: `50-250 MB`
- Large file: `1 GB+`

Steps:

1. Upload each file.
2. Confirm progress updates.
3. Confirm manifest appears in file list.
4. Download each file using `downloadToPath`.
5. Compare original and downloaded file hash.
6. Restart app and confirm files remain discoverable.

Pass criteria:

- No renderer memory spike from full-file Buffer/Base64.
- Large file download writes to disk path.
- Downloaded hashes match originals.
- App remains responsive during large transfer.

---

## 5. Multi-Peer Network Smoke Test

Use at least two desktop peers plus one bootstrap server.

Steps:

1. Start bootstrap server on public/LAN reachable host.
2. Start peer A with a valid `P2P_PUBLIC_URL`.
3. Start peer B with a valid `P2P_PUBLIC_URL`.
4. Confirm both peers register with bootstrap.
5. Confirm each peer sees the other in network summary.
6. Upload from peer A.
7. Download from peer B using same identity/key material.
8. Stop peer A and retry availability from replicated/safety copy.

Pass criteria:

- Bootstrap accepts only valid `ws://` or `wss://` peer URLs.
- Peers discover each other.
- Chunk get/put succeeds.
- Download from another peer reconstructs the file.
- Under-replicated state is visible and repair/protection does not crash.

---

## 6. Manifest Sync Smoke Test

Steps:

1. Start manifest sync with `MANIFEST_SYNC_REQUIRE_AUTH=true`.
2. Configure matching `P2P_MANIFEST_SYNC_AUTH_SECRET` and `MANIFEST_SYNC_AUTH_SECRET`.
3. Upload file and confirm manifest push succeeds.
4. Restart app and confirm manifest pull succeeds.
5. Attempt unauthenticated POST/DELETE manually.

Pass criteria:

- Authenticated manifest writes work.
- Unauthenticated writes/deletes fail.
- Wrong identity/wallet path fails.
- Replay attempts with old nonce/timestamp fail.

---

## 7. Storage Peer Smoke Test

Steps:

1. Start storage peer.
2. Upload chunks through normal app flow.
3. Request known chunk by hash.
4. Attempt invalid chunk upload with mismatched hash.
5. Attempt `chunk:delete` without `STORAGE_PEER_ADMIN_TOKEN`.
6. Attempt `chunk:delete` with valid admin token only in controlled test.

Pass criteria:

- Valid chunk stores successfully.
- Invalid hash is rejected.
- Oversized chunk/message is rejected.
- Delete is disabled without admin token.
- Delete with token works only when intentionally configured.

---

## 8. Payment / Paid Plan Smoke Test

Steps:

1. Configure PayPal sandbox credentials.
2. Configure the same `P2P_PLAN_UNLOCK_SECRET` / `PLAN_UNLOCK_SECRET` for Electron and PayPal checkout service.
3. Start PayPal checkout service.
4. Create PayPal order for a paid plan.
5. Capture order after sandbox approval.
6. Confirm response includes `planUnlockToken`, `paidUntil`, `wallet`, `planId`, and `orderId`.
7. Call `wallet:setPlan` with the signed token.
8. Try the same call with a modified plan/wallet/paidUntil/token.

Pass criteria:

- Valid captured PayPal order unlocks the correct plan.
- Modified token payload fails.
- Missing secret disables paid unlocks.
- Plan/wallet mismatch fails.

---

## 9. Encryption / Cross-Device Smoke Test

Steps:

1. Upload private encrypted file on peer A.
2. Confirm manifest contains encryption metadata but not raw secret material.
3. Download on peer A and verify hash.
4. Login on peer B with the same wallet/seed and drive password.
5. Download on peer B and verify hash.
6. Attempt wrong password/key.

Pass criteria:

- Correct identity/password decrypts successfully.
- Wrong identity/password fails authentication.
- Hash after decrypt matches original.
- No `encryptionSecret` is persisted into wallet JSON.

---

## 10. Release Decision

Release is allowed only when:

- All automated checks pass.
- Installer launches on a clean Windows profile.
- Small, medium, and 1GB+ file flows pass.
- Two-peer discovery and transfer pass.
- Manifest sync auth passes.
- Storage peer safety passes.
- PayPal sandbox paid-plan unlock passes.
- Encryption cross-device test passes.

Record test results in the release notes with:

```md
Date:
Commit SHA:
OS:
Installer file:
Peers tested:
Largest file tested:
Payment mode:
Result:
Known issues:
```
