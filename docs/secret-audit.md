# Secret Audit

This document defines the secret-handling baseline for Chunknet / p2p-cloud.

## Current status

- `.gitignore` blocks local environment files: `.env`, `.env.local`, `.env.development.local`, `.env.test.local`, and `.env.production.local`.
- The committed `.env` file is intentionally sanitized and must stay as a warning-only placeholder.
- `.env.example` is the only file that should document environment variable names and must use placeholder values only.
- `pnpm run audit:secrets` runs a local repository scan for obvious committed secrets.
- `pnpm run verify` and `pnpm run prepare:final` run the secret audit before build/release verification.

## Protected values

Never commit real values for:

- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_CLIENT_ID` when it belongs to a live production account
- `P2P_PLAN_UNLOCK_SECRET`
- `PLAN_UNLOCK_SECRET`
- `P2P_MANIFEST_SYNC_AUTH_SECRET`
- `MANIFEST_SYNC_AUTH_SECRET`
- `STORAGE_PEER_ADMIN_TOKEN`
- `P2P_SAFETY_PEER_DELETE_TOKEN`
- private keys, seed phrases, GitHub tokens, AWS keys, database passwords, or wallet keys

## Required local workflow

Before pushing changes, run:

```bash
pnpm run audit:secrets
pnpm run verify
```

If the audit fails:

1. Remove the secret from the tracked file.
2. Replace committed values with placeholders in `.env.example` only.
3. Rotate the leaked key/token in the external provider if it was ever pushed to Git.
4. Re-run `pnpm run audit:secrets`.

## Git history check

The committed repository state can be clean while older commits still contain leaked values. Before a public release, run:

```bash
git log --all -- .env
git grep -n "PAYPAL_CLIENT_SECRET\|PLAN_UNLOCK_SECRET\|MANIFEST_SYNC_AUTH_SECRET\|PRIVATE KEY\|AKIA\|ghp_" $(git rev-list --all)
```

If a real secret appears in history, rotate it immediately. Removing it from the latest commit is not enough.

## Release gate

A release is not approved unless:

- `pnpm run audit:secrets` passes.
- `.env` is sanitized.
- `.env.example` contains only placeholders.
- no production secrets are present in the Git history check.
- live secrets exist only in the deployment environment, never in source control.
