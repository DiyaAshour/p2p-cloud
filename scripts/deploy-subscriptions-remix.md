# Deploy p2p.cloud Subscriptions on Sepolia

Treasury wallet:

```text
0x870dc8c138634B3d9E93Dbe6ed9bee511C36D257
```

## Safest deploy path: Remix + Trust Wallet / MetaMask

Do not paste or share your private key.

1. Open Remix.
2. Create `P2PCloudSubscriptions.sol`.
3. Paste the contents of:

```text
contracts/P2PCloudSubscriptions.sol
```

4. Compile with Solidity `0.8.20` or newer.
5. Connect wallet on Sepolia.
6. Deploy constructor argument:

```text
0x870dc8c138634B3d9E93Dbe6ed9bee511C36D257
```

7. Copy the deployed contract address.
8. Configure plans by calling `setPlan` from the owner wallet.

## Sepolia test prices

Use tiny test ETH values for testing.

```text
1 TB  planId 1  priceWei 10000000000000  quotaBytes 1099511627776
3 TB  planId 3  priceWei 25000000000000  quotaBytes 3298534883328
7 TB  planId 7  priceWei 49900000000000  quotaBytes 7696581394432
10 TB planId 10 priceWei 79900000000000  quotaBytes 10995116277760
```

These are only Sepolia test values, not real production pricing.

## Production behavior

The app must send payment to the contract, not directly to the treasury.

The contract forwards funds to treasury and records:

```text
subscriptions[user].planId
subscriptions[user].paidUntil
subscriptions[user].quotaBytes
```

The app should unlock paid storage only when:

```text
getSubscription(wallet).active == true
```

Free storage remains 5GB even without payment.
